import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XianyuError } from '@bigfish/core'
import { callMtop } from '../src/index.ts'
import type { MtopHttpRequest, MtopHttpResponse, MtopTransport } from '../src/index.ts'

const API = 'mtop.taobao.idle.pc.detail'
const SESSION = { cookies: { _m_h5_tk: 'tok123_1700000000000' } }
const OK_TEXT = JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { itemId: '1' } })

interface FakeTransport {
  transport: MtopTransport
  calls: MtopHttpRequest[]
}

/** 记录每次 request 的假通道；response 为 Error 时抛出它。 */
function fakeTransport(response: MtopHttpResponse | Error): FakeTransport {
  const calls: MtopHttpRequest[] = []
  const transport: MtopTransport = {
    request: async (request) => {
      calls.push(request)
      if (response instanceof Error) throw response
      return response
    },
  }
  return { transport, calls }
}

function ok(text: string = OK_TEXT): MtopHttpResponse {
  return { status: 200, headers: {}, text }
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

test('callMtop：只发一次请求，body 为 data=<紧凑 json>，返回 body.data', async () => {
  const { transport, calls } = fakeTransport(ok())
  const result = await callMtop(transport, {
    api: API,
    data: { itemId: '1', page: 2 },
    session: SESSION,
    t: 1_700_000_000_123,
  })
  assert.equal(calls.length, 1, '一次调用只能发一次网络请求')
  const request = calls[0]
  assert.ok(request !== undefined)
  assert.equal(request.method, 'POST')
  assert.equal(request.body, 'data=' + encodeURIComponent('{"itemId":"1","page":2}'))
  const params = new URL(request.url).searchParams
  assert.equal(params.get('api'), API)
  assert.equal(params.get('t'), '1700000000123')
  assert.equal(request.headers.cookie, '_m_h5_tk=tok123_1700000000000')
  assert.deepEqual(result, { itemId: '1' })
})

test('callMtop：缺省注入超时 signal，调用方 signal 与之合并', async () => {
  const controller = new AbortController()
  const first = fakeTransport(ok())
  await callMtop(first.transport, { api: API, data: {}, session: SESSION })
  const defaultSignal = first.calls[0]?.signal
  assert.ok(defaultSignal instanceof AbortSignal, '未传 signal 时也应带超时 signal')
  assert.equal(defaultSignal.aborted, false)

  const second = fakeTransport(ok())
  await callMtop(second.transport, { api: API, data: {}, session: SESSION, signal: controller.signal })
  const merged = second.calls[0]?.signal
  assert.ok(merged instanceof AbortSignal)
  assert.equal(merged.aborted, false)
  controller.abort()
  assert.equal(merged.aborted, true, '调用方取消后合并 signal 应同步 abort')
})

test('callMtop：传输异常收敛为 NETWORK 且可重试，消息不泄露 token', async () => {
  const { transport, calls } = fakeTransport(new Error('socket hang up'))
  const error = await expectCode('NETWORK', callMtop(transport, { api: API, data: {}, session: SESSION }))
  assert.equal(error.retryable, true)
  assert.equal(calls.length, 1)
  assert.ok(!error.message.includes('tok123'), '错误消息不得出现 cookie token 明文')
})

test('callMtop：传输层已抛 XianyuError 时保持原 code', async () => {
  const { transport } = fakeTransport(new XianyuError({ code: 'RATE_LIMITED', message: '上游限流' }))
  const error = await expectCode('RATE_LIMITED', callMtop(transport, { api: API, data: {}, session: SESSION }))
  assert.equal(error.code, 'RATE_LIMITED')
})

test('callMtop：HTTP 状态映射 401/403→AUTH_EXPIRED、429→RATE_LIMITED、500→可重试 NETWORK', async () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [401, 'AUTH_EXPIRED'],
    [403, 'AUTH_EXPIRED'],
    [429, 'RATE_LIMITED'],
    [500, 'NETWORK'],
    [503, 'NETWORK'],
    [404, 'NETWORK'],
  ]
  for (const [status, code] of cases) {
    const { transport } = fakeTransport({ status, headers: {}, text: 'x' })
    const error = await expectCode(code, callMtop(transport, { api: API, data: {}, session: SESSION }))
    assert.equal(error.code, code)
    const retryable = status === 500 || status === 503 || status === 429
    assert.equal(error.retryable, retryable, 'status ' + String(status) + ' 的 retryable 不符合预期')
  }
})

test('callMtop：平台 ret 失败映射为风险/鉴权等 code', async () => {
  const risk = fakeTransport(ok(JSON.stringify({ ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦'] })))
  const riskError = await expectCode('RISK_CONTROL', callMtop(risk.transport, { api: API, data: {}, session: SESSION }))
  assert.equal(riskError.code, 'RISK_CONTROL')

  const expired = fakeTransport(ok(JSON.stringify({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'] })))
  await expectCode('AUTH_EXPIRED', callMtop(expired.transport, { api: API, data: {}, session: SESSION }))

  const sign = fakeTransport(ok(JSON.stringify({ ret: ['FAIL_SYS_API_SIGN_ERROR::签名错误'] })))
  await expectCode('VALIDATION', callMtop(sign.transport, { api: API, data: {}, session: SESSION }))
})

test('callMtop：响应不是 JSON 时抛 NETWORK', async () => {
  const { transport } = fakeTransport(ok('<html>502 Bad Gateway</html>'))
  await expectCode('NETWORK', callMtop(transport, { api: API, data: {}, session: SESSION }))
})

test('callMtop：transport 结构非法抛 VALIDATION，且不发起请求', async () => {
  const bad = { request: 'not-a-function' } as unknown as MtopTransport
  await expectCode('VALIDATION', callMtop(bad, { api: API, data: {}, session: SESSION }))
})
