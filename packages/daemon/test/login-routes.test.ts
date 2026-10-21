/**
 * POST /accounts/login 路由测试：鉴权、能力未注入、空 body、参数透传与错误映射。
 * 不连 Chrome：登录能力用假实现注入，只验 HTTP 层行为。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'

import type { LoginResult } from '../src/login.ts'
import type { LoginInput } from '../src/login.ts'
import { createHarness, dataOf, errorOf } from './harness.ts'

const NOW = 1_700_000_000_000

const LOGGED: LoginResult = {
  accountId: '12345',
  savedFieldCount: 2,
  updatedAt: NOW,
  source: 'chrome-cdp',
  elapsedMs: 12_345,
}

function stubLogin(calls: LoginInput[]): (input: LoginInput) => Promise<LoginResult> {
  return async (input: LoginInput): Promise<LoginResult> => {
    calls.push(input)
    return LOGGED
  }
}

describe('POST /accounts/login', () => {
  it('缺少 Bearer token → 401 UNAUTHORIZED', async (t) => {
    const harness = await createHarness(t, { loginAccount: stubLogin([]) })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/login', token: null, body: '{}' })
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })

  it('未注入登录能力 → 500 UNSUPPORTED（不假装成功）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/login', body: '{}' })
    assert.equal(response.status, 500)
    const error = errorOf(response)
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /未注入扫码登录能力/)
  })

  it('没有请求体也允许（全部参数可选），返回登录结果', async (t) => {
    const calls: LoginInput[] = []
    const harness = await createHarness(t, { loginAccount: stubLogin(calls) })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/login' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), LOGGED)
    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.ok(call !== undefined)
    // 路由总是挂一个 AbortSignal，客户端断开时可中止等待扫码。
    assert.ok(call.signal instanceof AbortSignal)
    assert.equal(call.accountId, undefined)
    assert.equal(call.port, undefined)
    assert.equal(call.timeoutMs, undefined)
  })

  it('空对象 body 同样可用', async (t) => {
    const calls: LoginInput[] = []
    const harness = await createHarness(t, { loginAccount: stubLogin(calls) })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/login', body: '{}' })
    assert.equal(response.status, 200)
    assert.deepEqual(calls.length, 1)
  })

  it('accountId / port / timeoutMs 透传给登录器', async (t) => {
    const calls: LoginInput[] = []
    const harness = await createHarness(t, { loginAccount: stubLogin(calls) })
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/accounts/login',
      body: JSON.stringify({ accountId: 'main-shop', port: 9333, timeoutMs: 5000 }),
    })
    assert.equal(response.status, 200)
    const call = calls[0]
    assert.ok(call !== undefined)
    assert.equal(call.accountId, 'main-shop')
    assert.equal(call.port, 9333)
    assert.equal(call.timeoutMs, 5000)
  })

  it('非法 timeoutMs / port / accountId → 400 VALIDATION', async (t) => {
    const harness = await createHarness(t, { loginAccount: stubLogin([]) })
    const bodies = ['{"timeoutMs":0}', '{"timeoutMs":"5000"}', '{"timeoutMs":1.5}', '{"port":0}', '{"port":70000}', '{"accountId":42}']
    for (const body of bodies) {
      const response = await harness.rawRequest({ method: 'POST', path: '/accounts/login', body })
      assert.equal(response.status, 400, body)
      assert.equal(errorOf(response).code, 'VALIDATION', body)
    }
  })

  it('超时（UNAUTHORIZED）→ 500 错误信封，文案可操作', async (t) => {
    const harness = await createHarness(t, {
      loginAccount: async (): Promise<LoginResult> => {
        throw new XianyuError({
          code: 'UNAUTHORIZED',
          message: '扫码超时：请确认浏览器窗口已打开并完成扫码（已等 180 秒，端口 9222）',
        })
      },
    })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/login', body: '{}' })
    assert.equal(response.status, 500)
    const error = errorOf(response)
    assert.equal(error.code, 'UNAUTHORIZED')
    assert.match(error.message, /扫码超时/)
  })
})
