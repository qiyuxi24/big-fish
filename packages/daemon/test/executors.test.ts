/**
 * 执行器测试：载荷校验、凭据、熔断、限流、items 落库与通道错误透传。
 * 全部用 fake OperationPort，不触网。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RateLimiter, XianyuError } from '@bigfish/core'
import type { CredentialRecord, ItemRepository, ItemSummary } from '@bigfish/core'

import type { ExecuteContext } from '../src/executor.ts'
import type { OperationPort } from '../src/executors.ts'
import { createExecutors } from '../src/executors.ts'

interface FakeItems extends ItemRepository {
  readonly upserts: ItemSummary[]
}

function makeItems(): FakeItems {
  const rows = new Map<string, ItemSummary>()
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
        updatedAt: input.updatedAt ?? 1_000,
      }
      rows.set(row.itemId, row)
      upserts.push(row)
      return row
    },
    get(itemId) {
      return rows.get(itemId)
    },
    list() {
      return [...rows.values()]
    },
    count() {
      return rows.size
    },
  }
}

function makeCredentialStore(records: Record<string, CredentialRecord>) {
  return {
    loads: [] as string[],
    async load(accountId: string) {
      this.loads.push(accountId)
      return records[accountId]
    },
  }
}

interface CtxOptions {
  payload: Record<string, unknown>
  items?: FakeItems
  credentials?: { load(accountId: string): Promise<CredentialRecord | undefined> }
  limiter?: RateLimiter
  circuits?: ExecuteContext['circuits']
}

function makeCtx(options: CtxOptions): ExecuteContext {
  return {
    task: {
      id: 't1',
      kind: 'probe',
      dedupeKey: 'k1',
      payload: options.payload,
      state: 'leased',
      attempts: 1,
      maxAttempts: 3,
      availableAt: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    signal: new AbortController().signal,
    ...(options.items === undefined ? {} : { items: options.items }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.circuits === undefined ? {} : { circuits: options.circuits }),
    now: () => 1_000,
  } as ExecuteContext
}

function makePort(overrides: Partial<OperationPort> = {}): OperationPort & { calls: string[] } {
  const calls: string[] = []
  const port: OperationPort = {
    async fetchItemDetail(input) {
      calls.push('detail:' + input.itemId)
      return { itemId: input.itemId, title: '标题', priceCents: 1990, state: 'online' }
    },
    async polishItem(input) {
      calls.push('polish:' + input.itemId)
    },
    async publishItem(input) {
      calls.push('publish:' + input.draft.title)
      return { itemId: 'new-1' }
    },
    async deliverOrder(input) {
      calls.push('deliver:' + input.deliver.orderId)
      return { delivered: true }
    },
    async verifySession() {
      // 本文件只测执行器分派，登录态校验不在覆盖范围。
    },
    async sendReply(input) {
      calls.push('reply:' + input.reply.cid)
    },
    ...overrides,
  }
  return Object.assign(port, { calls })
}

describe('daemon 执行器', () => {
  it('probe：取详情后落 items，并消耗 read 桶', async () => {
    const items = makeItems()
    const port = makePort()
    const limiter = new RateLimiter({ now: () => 1_000 })
    const executors = createExecutors({ ports: port })
    const ctx = makeCtx({
      payload: { accountId: 'acc1', itemId: 'i1' },
      items,
      credentials: makeCredentialStore({ acc1: { accountId: 'acc1', cookies: { _m_h5_tk: 'x' }, updatedAt: 1 } }),
      limiter,
    })
    await executors.probe?.execute(ctx.task, ctx)
    assert.deepEqual(port.calls, ['detail:i1'])
    assert.equal(items.upserts.length, 1)
    assert.equal(items.upserts[0]?.itemId, 'i1')
    assert.equal(items.upserts[0]?.state, 'online')
    assert.equal(items.upserts[0]?.priceCents, 1990)
    assert.equal(limiter.snapshot('acc1')['read']?.used, 1)
  })

  it('probe：缺 itemId → VALIDATION', async () => {
    const executors = createExecutors({ ports: makePort() })
    const ctx = makeCtx({ payload: { accountId: 'acc1' } })
    await assert.rejects(executors.probe?.execute(ctx.task, ctx) as Promise<void>, (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'VALIDATION')
      return true
    })
  })

  it('缺 accountId → VALIDATION', async () => {
    const executors = createExecutors({ ports: makePort() })
    const ctx = makeCtx({ payload: { itemId: 'i1' } })
    await assert.rejects(executors.probe?.execute(ctx.task, ctx) as Promise<void>, /accountId/)
  })

  it('没有凭据 → AUTH_EXPIRED（不可重试）', async () => {
    const executors = createExecutors({ ports: makePort() })
    const ctx = makeCtx({ payload: { accountId: 'missing', itemId: 'i1' }, credentials: makeCredentialStore({}) })
    await assert.rejects(executors.probe?.execute(ctx.task, ctx) as Promise<void>, (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'AUTH_EXPIRED')
      return true
    })
  })

  it('熔断中 → CIRCUIT_OPEN 且带 retryAfterMs', async () => {
    const circuits = { isOpen: () => true, list: () => [{ accountId: 'acc1', reason: 'RGV587', trippedAt: 0, until: 61_000 }] }
    const executors = createExecutors({ ports: makePort() })
    const ctx = makeCtx({
      payload: { accountId: 'acc1', itemId: 'i1' },
      credentials: makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } }),
      circuits: circuits as unknown as ExecuteContext['circuits'],
    })
    await assert.rejects(executors.probe?.execute(ctx.task, ctx) as Promise<void>, (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'CIRCUIT_OPEN')
      assert.equal(error.details['retryAfterMs'], 60_000)
      return true
    })
  })

  it('限流拒绝 → RATE_LIMITED 带 retryAfterMs，且不调用通道', async () => {
    const port = makePort()
    const limiter = new RateLimiter({ now: () => 1_000 })
    const executors = createExecutors({ ports: port })
    const credentials = makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } })
    const payload = { accountId: 'acc1', itemId: 'i1' }
    await executors.polish?.execute(makeCtx({ payload, credentials, limiter }).task, makeCtx({ payload, credentials, limiter }))
    const second = makeCtx({ payload, credentials, limiter })
    await assert.rejects(executors.polish?.execute(second.task, second) as Promise<void>, (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'RATE_LIMITED')
      assert.equal(typeof error.details['retryAfterMs'], 'number')
      return true
    })
    assert.equal(port.calls.length, 1)
  })

  it('polish：消耗 write 桶并调用通道', async () => {
    const port = makePort()
    const limiter = new RateLimiter({ now: () => 1_000 })
    const executors = createExecutors({ ports: port })
    const ctx = makeCtx({
      payload: { accountId: 'acc1', itemId: 'i9' },
      credentials: makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } }),
      limiter,
    })
    await executors.polish?.execute(ctx.task, ctx)
    assert.deepEqual(port.calls, ['polish:i9'])
    assert.equal(limiter.snapshot('acc1')['write']?.used, 1)
  })

  it('publish：成功后把新商品以 online 落库', async () => {
    const items = makeItems()
    const port = makePort()
    const executors = createExecutors({ ports: port })
    const ctx = makeCtx({
      payload: { accountId: 'acc1', title: 'T', desc: 'D', priceCents: 1000, images: ['a.png'] },
      items,
      credentials: makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } }),
    })
    await executors.publish?.execute(ctx.task, ctx)
    assert.deepEqual(port.calls, ['publish:T'])
    assert.equal(items.upserts[0]?.itemId, 'new-1')
    assert.equal(items.upserts[0]?.state, 'online')
    assert.equal(items.upserts[0]?.priceCents, 1000)
  })

  it('publish：草稿 category 原样透传给通道，非字符串 → VALIDATION', async () => {
    const port = makePort()
    const seen: string[] = []
    const executors = createExecutors({
      ports: { ...port, async publishItem(input) { seen.push(input.draft.category ?? ''); return { itemId: 'new-2' } } },
    })
    const credentials = makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } })
    const ok = makeCtx({
      payload: { accountId: 'acc1', title: 'T', desc: 'D', priceCents: 1000, images: ['a.png'], category: '电子资料' },
      credentials,
    })
    await executors.publish?.execute(ok.task, ok)
    assert.deepEqual(seen, ['电子资料'])
    const bad = makeCtx({
      payload: { accountId: 'acc1', title: 'T', desc: 'D', priceCents: 1000, images: ['a.png'], category: 42 },
      credentials,
    })
    await assert.rejects(executors.publish?.execute(bad.task, bad) as Promise<void>, /category/)
  })

  it('publish：address/shipping 透传给通道（队列任务读不到草稿文件，缺地址会被必填预检拦下）', async () => {
    const port = makePort()
    const seen: Array<{ address: string | undefined; shipping: string | undefined }> = []
    const executors = createExecutors({
      ports: {
        ...port,
        async publishItem(input) {
          seen.push({ address: input.draft.address, shipping: input.draft.shipping })
          return { itemId: 'new-3' }
        },
      },
    })
    const credentials = makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } })
    const ok = makeCtx({
      payload: {
        accountId: 'acc1', title: 'T', desc: 'D', priceCents: 1000, images: ['a.png'],
        category: '学习笔记', shipping: 'free', address: '西北工业大学长安校区星天苑',
      },
      credentials,
    })
    await executors.publish?.execute(ok.task, ok)
    assert.deepEqual(seen, [{ address: '西北工业大学长安校区星天苑', shipping: 'free' }])
    const badShipping = makeCtx({
      payload: { accountId: 'acc1', title: 'T', desc: 'D', priceCents: 1000, images: ['a.png'], shipping: 'emi' },
      credentials,
    })
    await assert.rejects(executors.publish?.execute(badShipping.task, badShipping) as Promise<void>, /shipping/)
    const badAddress = makeCtx({
      payload: { accountId: 'acc1', title: 'T', desc: 'D', priceCents: 1000, images: ['a.png'], address: 42 },
      credentials,
    })
    await assert.rejects(executors.publish?.execute(badAddress.task, badAddress) as Promise<void>, /address/)
  })

  it('publish：priceCents 非整数 → VALIDATION；images 非法 → VALIDATION', async () => {
    const executors = createExecutors({ ports: makePort() })
    const credentials = makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } })
    const badPrice = makeCtx({ payload: { accountId: 'acc1', title: 'T', desc: 'D', priceCents: 1.5, images: [] }, credentials })
    await assert.rejects(executors.publish?.execute(badPrice.task, badPrice) as Promise<void>, /priceCents/)
    const badImages = makeCtx({ payload: { accountId: 'acc1', title: 'T', desc: 'D', priceCents: 1, images: 'x' }, credentials })
    await assert.rejects(executors.publish?.execute(badImages.task, badImages) as Promise<void>, /images/)
  })

  it('deliver：规格双键原样透传', async () => {
    const port = makePort()
    const executors = createExecutors({ ports: port })
    const ctx = makeCtx({
      payload: { accountId: 'acc1', orderId: 'o1', itemId: 'i1', specId: 's1', content: '卡密' },
      credentials: makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } }),
    })
    await executors.deliver?.execute(ctx.task, ctx)
    assert.deepEqual(port.calls, ['deliver:o1'])
  })

  it('reply：文本透传', async () => {
    const port = makePort()
    const executors = createExecutors({ ports: port })
    const ctx = makeCtx({
      payload: { accountId: 'acc1', cid: 'c1', text: '在的' },
      credentials: makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } }),
    })
    await executors.reply?.execute(ctx.task, ctx)
    assert.deepEqual(port.calls, ['reply:c1'])
  })

  it('通道抛出的 XianyuError 原样上抛（保持 code）', async () => {
    const port = makePort({
      async fetchItemDetail() {
        throw new XianyuError({ code: 'RISK_CONTROL', message: 'RGV587' })
      },
    })
    const executors = createExecutors({ ports: port })
    const ctx = makeCtx({
      payload: { accountId: 'acc1', itemId: 'i1' },
      credentials: makeCredentialStore({ acc1: { accountId: 'acc1', cookies: {}, updatedAt: 1 } }),
    })
    await assert.rejects(executors.probe?.execute(ctx.task, ctx) as Promise<void>, (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'RISK_CONTROL')
      return true
    })
  })
})