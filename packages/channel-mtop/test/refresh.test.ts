/**
 * 令牌过期自动刷新测试：过期 → 合并 Set-Cookie 新令牌 → 重签重试一次。
 * 全部用 fake transport，不触网；断言重点在「刷新结果必须交回调用方」与 fail-fast 不被破坏。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { XianyuError } from '@bigfish/core'

import { callMtop } from '../src/call.ts'
import { mergeCookies, parseSetCookie } from '../src/response.ts'
import { signMtop } from '../src/sign.ts'
import type { MtopHttpRequest, MtopHttpResponse, MtopTransport } from '../src/types.ts'

const API = 'mtop.taobao.idle.pc.detail'
const T = 1_700_000_000_123
const OLD_TOKEN_COOKIE = 'oldtok_1699990000000'
const NEW_TOKEN = 'newtok'
const NEW_TOKEN_COOKIE = NEW_TOKEN + '_' + String(T + 7_200_000)
const SESSION = { cookies: { unb: '2200000000001', _m_h5_tk: OLD_TOKEN_COOKIE, cookie2: 'c2' } }
const DATA = { itemId: '1' }
const DATA_TEXT = JSON.stringify(DATA)
const OK_TEXT = JSON.stringify({ ret: ['SUCCESS::调用成功'], data: DATA })
const EXPIRED_TEXT = JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] })

interface FakeTransport {
  transport: MtopTransport
  calls: MtopHttpRequest[]
}

/** 按调用顺序回放响应；响应是 Error 时抛出，用尽后报错（防止偷偷多发请求）。 */
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

function ok(text: string = OK_TEXT): MtopHttpResponse {
  return { status: 200, headers: {}, text }
}

/** 令牌过期响应：真实平台把新令牌放在 Set-Cookie 原始行里（不是 headers 拼接串）。 */
function expired(
  setCookie: string[] = [
    '_m_h5_tk=' + NEW_TOKEN_COOKIE + '; Path=/; Domain=.goofish.com; HttpOnly',
    '_m_h5_tk_enc=enc2; Path=/; Domain=.goofish.com; HttpOnly',
  ],
): MtopHttpResponse {
  return { status: 200, headers: {}, text: EXPIRED_TEXT, setCookie }
}

/** 断言 promise 以 XianyuError 的指定 code 拒绝，并返回该错误。 */
async function expectCode(code: string, promise: Promise<unknown>): Promise<XianyuError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, code)
    return error
  }
  assert.fail('预期抛出 XianyuError')
}

test('过期 → 合并 Set-Cookie → 用新 token 重签重试一次并成功，新 cookie 交回调用方', async () => {
  const { transport, calls } = sequenceTransport([expired(), ok()])
  const updates: Array<Record<string, string>> = []
  const result = await callMtop(transport, {
    api: API,
    data: DATA,
    session: SESSION,
    t: T,
    onSessionUpdate: (cookies) => {
      updates.push(cookies)
    },
  })
  assert.deepEqual(result, DATA)
  assert.equal(calls.length, 2, '过期后只允许重试一次')
  assert.match(calls[0]?.headers.cookie ?? '', /_m_h5_tk=oldtok_/, '第一次仍用旧 token')
  const retried = calls[1]
  assert.ok(retried !== undefined)
  const params = new URL(retried.url).searchParams
  assert.equal(params.get('sign'), signMtop(NEW_TOKEN, T, DATA_TEXT), '第二次必须用新 token 重签')
  assert.equal(params.get('t'), String(T), '两次尝试共用同一个 t')
  const cookie = retried.headers.cookie ?? ''
  assert.match(cookie, /_m_h5_tk=newtok_/)
  assert.match(cookie, /_m_h5_tk_enc=enc2/)
  assert.match(cookie, /unb=2200000000001/, '原有 cookie 不能丢')
  assert.deepEqual(
    updates,
    [{ unb: '2200000000001', _m_h5_tk: NEW_TOKEN_COOKIE, cookie2: 'c2', _m_h5_tk_enc: 'enc2' }],
    '刷新结果必须原样交回调用方（合并后的完整 cookie 表）',
  )
})

test('刷新后仍提示过期 → AUTH_EXPIRED，且只发两次请求', async () => {
  const { transport, calls } = sequenceTransport([expired(), expired()])
  const updates: Array<Record<string, string>> = []
  const error = await expectCode(
    'AUTH_EXPIRED',
    callMtop(transport, {
      api: API,
      data: DATA,
      session: SESSION,
      t: T,
      onSessionUpdate: (cookies) => {
        updates.push(cookies)
      },
    }),
  )
  assert.equal(error.retryable, false)
  assert.match(error.message, /刷新令牌后仍提示过期/)
  assert.equal(calls.length, 2)
  assert.equal(updates.length, 1)
  assert.ok(!error.message.includes(NEW_TOKEN), '错误消息不得出现令牌明文')
})

test('正常路径不变：一次请求、不触发刷新回调', async () => {
  const { transport, calls } = sequenceTransport([ok()])
  let updates = 0
  const result = await callMtop(transport, {
    api: API,
    data: DATA,
    session: SESSION,
    t: T,
    onSessionUpdate: () => {
      updates += 1
    },
  })
  assert.deepEqual(result, DATA)
  assert.equal(calls.length, 1)
  assert.equal(updates, 0)
  const params = new URL(calls[0]?.url ?? '').searchParams
  assert.equal(params.get('sign'), signMtop('oldtok', T, DATA_TEXT))
})

test('mergeCookies：只更新变化字段，原 cookie 表不被修改', () => {
  const base = { unb: '2200000000001', _m_h5_tk: OLD_TOKEN_COOKIE, cookie2: 'c2' }
  const updates = parseSetCookie([
    '_m_h5_tk=' + NEW_TOKEN_COOKIE + '; Path=/',
    'cookie2=c2; Path=/',
    '_m_h5_tk_enc=enc2; Path=/',
  ])
  const merged = mergeCookies(base, updates)
  assert.deepEqual(merged.changed, { _m_h5_tk: NEW_TOKEN_COOKIE, _m_h5_tk_enc: 'enc2' })
  assert.deepEqual(merged.cookies, {
    unb: '2200000000001',
    _m_h5_tk: NEW_TOKEN_COOKIE,
    cookie2: 'c2',
    _m_h5_tk_enc: 'enc2',
  })
  assert.equal(base._m_h5_tk, OLD_TOKEN_COOKIE, '不得原地修改调用方 cookie 表')
  assert.ok(!Object.hasOwn(base, '_m_h5_tk_enc'))
})

test('没有 onSessionUpdate → 不刷新重试，直接 AUTH_EXPIRED（不吞新令牌）', async () => {
  const { transport, calls } = sequenceTransport([expired(), ok()])
  const error = await expectCode('AUTH_EXPIRED', callMtop(transport, { api: API, data: DATA, session: SESSION, t: T }))
  assert.equal(error.retryable, false)
  assert.equal(calls.length, 1)
})

test('Set-Cookie 里没有新 _m_h5_tk 或值没变 → 不重试', async () => {
  const noToken = sequenceTransport([expired(['_m_h5_tk_enc=enc2; Path=/']), ok()])
  await expectCode(
    'AUTH_EXPIRED',
    callMtop(noToken.transport, { api: API, data: DATA, session: SESSION, t: T, onSessionUpdate: () => undefined }),
  )
  assert.equal(noToken.calls.length, 1)

  const sameToken = sequenceTransport([expired(['_m_h5_tk=' + OLD_TOKEN_COOKIE + '; Path=/']), ok()])
  await expectCode(
    'AUTH_EXPIRED',
    callMtop(sameToken.transport, { api: API, data: DATA, session: SESSION, t: T, onSessionUpdate: () => undefined }),
  )
  assert.equal(sameToken.calls.length, 1)
})

test('非令牌过期的失败即使带 Set-Cookie 也不重试', async () => {
  const risk: MtopHttpResponse = {
    status: 200,
    headers: {},
    text: JSON.stringify({ ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦'] }),
    setCookie: ['_m_h5_tk=' + NEW_TOKEN_COOKIE + '; Path=/'],
  }
  const { transport, calls } = sequenceTransport([risk, ok()])
  const error = await expectCode(
    'RISK_CONTROL',
    callMtop(transport, { api: API, data: DATA, session: SESSION, t: T, onSessionUpdate: () => undefined }),
  )
  assert.equal(error.code, 'RISK_CONTROL')
  assert.equal(calls.length, 1)
})

test('回写回调抛错 → STORAGE，且不重试、不冒充成功', async () => {
  const { transport, calls } = sequenceTransport([expired(), ok()])
  const error = await expectCode(
    'STORAGE',
    callMtop(transport, {
      api: API,
      data: DATA,
      session: SESSION,
      t: T,
      onSessionUpdate: async () => {
        throw new Error('disk full')
      },
    }),
  )
  assert.equal(error.code, 'STORAGE')
  assert.equal(calls.length, 1, '回写失败后不能继续发第二次请求')
})

test('刷新后返回其它失败 → 原样上抛该 code', async () => {
  const validate: MtopHttpResponse = {
    status: 200,
    headers: {},
    text: JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE::需要身份验证'] }),
  }
  const { transport, calls } = sequenceTransport([expired(), validate])
  const error = await expectCode(
    'RISK_CONTROL',
    callMtop(transport, { api: API, data: DATA, session: SESSION, t: T, onSessionUpdate: () => undefined }),
  )
  assert.equal(error.code, 'RISK_CONTROL')
  assert.equal(calls.length, 2)
})

test('Set-Cookie 回退：headers["set-cookie"] 多值拼接（Expires 逗号不误切）也能刷新', async () => {
  const fallback: MtopHttpResponse = {
    status: 200,
    headers: {
      'set-cookie':
        '_m_h5_tk=' + NEW_TOKEN_COOKIE + '; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, _m_h5_tk_enc=enc2; Path=/',
    },
    text: EXPIRED_TEXT,
  }
  const { transport, calls } = sequenceTransport([fallback, ok()])
  const updates: Array<Record<string, string>> = []
  const result = await callMtop(transport, {
    api: API,
    data: DATA,
    session: SESSION,
    t: T,
    onSessionUpdate: (cookies) => {
      updates.push(cookies)
    },
  })
  assert.deepEqual(result, DATA)
  assert.equal(calls.length, 2)
  assert.equal(updates[0]?.['_m_h5_tk_enc'], 'enc2')
  assert.equal(updates[0]?.['_m_h5_tk'], NEW_TOKEN_COOKIE)
})

test('调用方已取消 → 不刷新重试，保持 AUTH_EXPIRED', async () => {
  const controller = new AbortController()
  controller.abort()
  const { transport, calls } = sequenceTransport([expired(), ok()])
  let updates = 0
  await expectCode(
    'AUTH_EXPIRED',
    callMtop(transport, {
      api: API,
      data: DATA,
      session: SESSION,
      t: T,
      signal: controller.signal,
      onSessionUpdate: () => {
        updates += 1
      },
    }),
  )
  assert.equal(updates, 0)
  assert.equal(calls.length, 1)
})
