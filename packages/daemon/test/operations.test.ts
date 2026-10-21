/**
 * 通道装配的令牌刷新回写测试：mtop 过期 → 合并 Set-Cookie → 回写凭据库 → 用新 token 重试。
 * 全部 fake transport + 假凭据库，不触网；覆盖 probe/polish 两条走 mtop 的执行器。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { signMtop } from '@bigfish/channel-mtop'
import type { MtopHttpRequest, MtopHttpResponse, MtopTransport } from '@bigfish/channel-mtop'
import { XianyuError } from '@bigfish/core'
import type { CredentialRecord, CredentialSaveInput, ItemRepository, ItemSummary } from '@bigfish/core'

import type { ExecuteContext } from '../src/executor.ts'
import { createExecutors } from '../src/executors.ts'
import { createOperationPort } from '../src/operations.ts'

const NOW = 1_700_000_000_000
const OLD_TOKEN_COOKIE = 'oldtok_1699990000000'
const NEW_TOKEN = 'newtok'
const NEW_TOKEN_COOKIE = NEW_TOKEN + '_' + String(NOW + 7_200_000)
const RECORD: CredentialRecord = {
  accountId: 'acc1',
  cookies: { unb: '2200000000001', _m_h5_tk: OLD_TOKEN_COOKIE },
  updatedAt: 1,
  meta: { deviceId: 'dev-1' },
}
const DETAIL_TEXT = JSON.stringify({
  ret: ['SUCCESS::调用成功'],
  data: { itemDO: { itemId: 'i1', title: '测试商品', soldPrice: '19.90', itemStatus: 0 } },
})
const POLISH_OK_TEXT = JSON.stringify({ ret: ['SUCCESS::调用成功'], data: {} })
const EXPIRED_TEXT = JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] })

interface FakeTransport {
  transport: MtopTransport
  calls: MtopHttpRequest[]
}

/** 按调用顺序回放响应；用尽后报错，顺带阻止「多发了请求却没人发现」。 */
function sequenceTransport(responses: ReadonlyArray<MtopHttpResponse | Error>): FakeTransport {
  const calls: MtopHttpRequest[] = []
  const transport: MtopTransport = {
    request: async (request) => {
      calls.push(request)
      const next = responses[calls.length - 1]
      if (next === undefined) throw new Error('fake transport 响应已用尽：调用方多发了请求')
      if (next instanceof Error) throw next
      return next
    },
  }
  return { transport, calls }
}

function expiredResponse(): MtopHttpResponse {
  return {
    status: 200,
    headers: {},
    text: EXPIRED_TEXT,
    setCookie: [
      '_m_h5_tk=' + NEW_TOKEN_COOKIE + '; Path=/; Domain=.goofish.com; HttpOnly',
      '_m_h5_tk_enc=enc2; Path=/; Domain=.goofish.com; HttpOnly',
    ],
  }
}

function okResponse(text: string): MtopHttpResponse {
  return { status: 200, headers: {}, text }
}

interface FakeStore {
  reads: string[]
  saves: CredentialSaveInput[]
  load(accountId: string): Promise<CredentialRecord | undefined>
  save?(input: CredentialSaveInput): Promise<void>
}

/**
 * 假凭据库：writable=false 模拟「能读不能写」（如只读挂载），failSave=true 模拟落盘失败。
 * 后者用来验证回写失败不会退化成「悄悄不刷新」。
 */
function makeStore(options: { writable?: boolean; failSave?: boolean } = {}): FakeStore {
  const store: FakeStore = {
    reads: [],
    saves: [],
    async load(accountId) {
      store.reads.push(accountId)
      return accountId === RECORD.accountId ? RECORD : undefined
    },
  }
  if (options.writable !== false) {
    store.save = async (input) => {
      if (options.failSave === true) throw new Error('凭据盘写入失败')
      store.saves.push(input)
    }
  }
  return store
}

interface FakeItems extends ItemRepository {
  upserts: ItemSummary[]
}

function makeItems(): FakeItems {
  const upserts: ItemSummary[] = []
  return {
    upserts,
    upsert(input) {
      const row: ItemSummary = {
        itemId: input.itemId,
        accountId: input.accountId,
        title: input.title,
        priceCents: input.priceCents,
        state: input.state,
        updatedAt: input.updatedAt ?? NOW,
      }
      upserts.push(row)
      return row
    },
    get(itemId) {
      return upserts.find(row => row.itemId === itemId)
    },
    list() {
      return upserts
    },
    count() {
      return upserts.length
    },
  }
}

function makeCtx(
  kind: 'probe' | 'polish',
  credentials: FakeStore,
  items?: FakeItems,
): ExecuteContext {
  return {
    task: {
      id: 't1',
      kind,
      dedupeKey: 'k1',
      payload: { accountId: 'acc1', itemId: 'i1' },
      state: 'leased',
      attempts: 1,
      maxAttempts: 3,
      availableAt: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    signal: new AbortController().signal,
    credentials,
    ...(items === undefined ? {} : { items }),
    now: () => NOW,
  }
}

function makeExecutors(transport: MtopTransport) {
  return createExecutors({ ports: createOperationPort({ transport, now: () => NOW }) })
}

/** 断言 promise 以 XianyuError 的指定 code 拒绝。 */
async function expectCode(code: string, run: () => Promise<void>): Promise<XianyuError> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, code)
    return error
  }
  assert.fail('预期抛出 XianyuError')
}

describe('令牌过期刷新回写', () => {
  it('probe：过期 → 回写合并后的 cookie（保留 meta）→ 用新 token 重试成功并落库', async () => {
    const { transport, calls } = sequenceTransport([expiredResponse(), okResponse(DETAIL_TEXT)])
    const store = makeStore()
    const items = makeItems()
    const ctx = makeCtx('probe', store, items)
    await makeExecutors(transport).probe?.execute(ctx.task, ctx)

    assert.equal(calls.length, 2, '过期后应重试一次')
    assert.equal(store.saves.length, 1, '刷新后必须回写一次凭据')
    const saved = store.saves[0]
    assert.ok(saved !== undefined)
    assert.equal(saved.accountId, 'acc1')
    assert.deepEqual(saved.cookies, { unb: '2200000000001', _m_h5_tk: NEW_TOKEN_COOKIE, _m_h5_tk_enc: 'enc2' })
    assert.deepEqual(saved.meta, { deviceId: 'dev-1' }, 'meta 必须原样带回，否则 deviceId 丢失')

    const first = calls[0]
    const retried = calls[1]
    assert.ok(first !== undefined && retried !== undefined)
    assert.ok(!(first.headers.cookie ?? '').includes(NEW_TOKEN), '第一次请求必须仍用旧 token')
    assert.match(retried.headers.cookie ?? '', /_m_h5_tk=newtok_/)
    const params = new URL(retried.url).searchParams
    const bodyText = decodeURIComponent(retried.body.slice('data='.length))
    assert.equal(params.get('sign'), signMtop(NEW_TOKEN, Number(params.get('t')), bodyText), '重试必须用新 token 重签')

    assert.equal(items.upserts.length, 1)
    const row = items.upserts[0]
    assert.ok(row !== undefined)
    assert.equal(row.title, '测试商品')
    assert.equal(row.priceCents, 1990)
    assert.equal(row.state, 'online')
  })

  it('polish：过期 → 回写 → 重试成功', async () => {
    const { transport, calls } = sequenceTransport([expiredResponse(), okResponse(POLISH_OK_TEXT)])
    const store = makeStore()
    const ctx = makeCtx('polish', store)
    await makeExecutors(transport).polish?.execute(ctx.task, ctx)

    assert.equal(calls.length, 2)
    assert.equal(store.saves.length, 1)
    const saved = store.saves[0]
    assert.ok(saved !== undefined)
    assert.deepEqual(saved.cookies, { unb: '2200000000001', _m_h5_tk: NEW_TOKEN_COOKIE, _m_h5_tk_enc: 'enc2' })
    assert.deepEqual(saved.meta, { deviceId: 'dev-1' })
  })

  it('刷新后仍过期 → AUTH_EXPIRED（重试后不再重试）', async () => {
    const { transport, calls } = sequenceTransport([expiredResponse(), expiredResponse()])
    const store = makeStore()
    const ctx = makeCtx('polish', store)
    const error = await expectCode('AUTH_EXPIRED', async () => {
      await makeExecutors(transport).polish?.execute(ctx.task, ctx)
    })
    assert.equal(error.retryable, false)
    assert.equal(calls.length, 2)
    assert.equal(store.saves.length, 1)
  })

  it('凭据库不可写 → 不刷新重试，直接 AUTH_EXPIRED（保持 fail-fast）', async () => {
    const { transport, calls } = sequenceTransport([expiredResponse(), okResponse(POLISH_OK_TEXT)])
    const store = makeStore({ writable: false })
    const ctx = makeCtx('polish', store)
    const error = await expectCode('AUTH_EXPIRED', async () => {
      await makeExecutors(transport).polish?.execute(ctx.task, ctx)
    })
    assert.equal(error.code, 'AUTH_EXPIRED')
    assert.equal(calls.length, 1, '回写不了就不该多发一次请求')
    assert.equal(store.save, undefined)
  })

  it('回写落盘失败 → STORAGE，且不重试', async () => {
    const { transport, calls } = sequenceTransport([expiredResponse(), okResponse(POLISH_OK_TEXT)])
    const store = makeStore({ failSave: true })
    const ctx = makeCtx('polish', store)
    const error = await expectCode('STORAGE', async () => {
      await makeExecutors(transport).polish?.execute(ctx.task, ctx)
    })
    assert.equal(error.code, 'STORAGE')
    assert.equal(calls.length, 1)
  })

  it('正常路径不变：一次请求、不回写凭据', async () => {
    const { transport, calls } = sequenceTransport([okResponse(DETAIL_TEXT)])
    const store = makeStore()
    const items = makeItems()
    const ctx = makeCtx('probe', store, items)
    await makeExecutors(transport).probe?.execute(ctx.task, ctx)

    assert.equal(calls.length, 1)
    assert.equal(store.saves.length, 0)
    assert.equal(store.reads.length, 1)
    assert.equal(items.upserts.length, 1)
  })

  it('凭据层没有 save 时正常路径照样成功（不因可选回写而失败）', async () => {
    const { transport, calls } = sequenceTransport([okResponse(DETAIL_TEXT)])
    const store = makeStore({ writable: false })
    const items = makeItems()
    const ctx = makeCtx('probe', store, items)
    await makeExecutors(transport).probe?.execute(ctx.task, ctx)
    assert.equal(calls.length, 1)
    assert.equal(items.upserts.length, 1)
  })
})
