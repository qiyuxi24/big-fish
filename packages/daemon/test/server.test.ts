/**
 * HTTP 外壳测试：鉴权、统一信封、Content-Type、状态码、关闭幂等。
 * 全部打真实服务（port 0），不 mock node:http。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'

import { asRecord, createHarness, dataOf, errorOf } from './harness.ts'

const JSON_TYPE = 'application/json; charset=utf-8'

describe('daemon HTTP 外壳', () => {
  it('GET /health 免鉴权，返回版本/运行时长/pid，且运行时长跟随时钟', async (t) => {
    const h = await createHarness(t)
    const first = await h.rawRequest({ method: 'GET', path: '/health', token: null })
    assert.equal(first.status, 200)
    assert.equal(first.contentType, JSON_TYPE)
    const body = asRecord(dataOf(first))
    assert.equal(body.version, '9.9.9')
    assert.equal(body.pid, process.pid)
    assert.equal(body.uptimeMs, 0)

    h.setNow(h.now() + 1234)
    const second = await h.rawRequest({ method: 'GET', path: '/health', token: null })
    assert.equal(asRecord(dataOf(second)).uptimeMs, 1234)
  })

  it('客户端 health() 不带 token 也能调通', async (t) => {
    const h = await createHarness(t)
    const health = await h.client.health()
    assert.equal(health.version, '9.9.9')
    assert.equal(typeof health.pid, 'number')
  })

  it('非公开路由无 token → 401 UNAUTHORIZED，且响应仍是统一信封', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({ method: 'GET', path: '/status', token: null })
    assert.equal(response.status, 401)
    assert.equal(response.contentType, JSON_TYPE)
    const error = errorOf(response)
    assert.equal(error.code, 'UNAUTHORIZED')
    assert.equal(error.retryable, false)
    assert.ok(error.message.length > 0)
  })

  it('错误 token → 401；未知路由在无 token 时也先 401（不泄露路由表）', async (t) => {
    const h = await createHarness(t)
    const wrong = await h.rawRequest({ method: 'GET', path: '/status', token: 'deadbeef' })
    assert.equal(wrong.status, 401)
    assert.equal(errorOf(wrong).code, 'UNAUTHORIZED')

    const unknown = await h.rawRequest({ method: 'GET', path: '/nope', token: null })
    assert.equal(unknown.status, 401)
  })

  it('正确 token 可读 /status：队列快照 + 版本 + pid + 空账号/熔断', async (t) => {
    const h = await createHarness(t)
    h.queue.enqueue({ kind: 'publish', dedupeKey: 'k1', payload: {} })
    h.setNow(h.now() + 500)
    const response = await h.rawRequest({ method: 'GET', path: '/status' })
    assert.equal(response.status, 200)
    const status = asRecord(dataOf(response))
    assert.equal(status.version, '9.9.9')
    assert.equal(status.uptimeMs, 500)
    assert.equal(status.pid, process.pid)
    assert.deepEqual(status.queue, { queued: 1, leased: 0, done: 0, failed: 0, needs_review: 0 })
    assert.deepEqual(status.accounts, [])
    assert.deepEqual(status.circuits, {})
  })

  it('GET /browser：注入时回托管浏览器状态，未注入时明确 enabled:false（不假装）', async (t) => {
    const status = { port: 9333, profileDir: 'C:/data/chrome-profile', running: true, owned: true, headless: false }
    const withBrowser = await createHarness(t, { browser: async () => status })
    const response = await withBrowser.rawRequest({ method: 'GET', path: '/browser' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { enabled: true, ...status })

    const without = await createHarness(t)
    assert.deepEqual(dataOf(await without.rawRequest({ method: 'GET', path: '/browser' })), { enabled: false })
  })

  it('未知路由 404、方法不匹配 405，都是 VALIDATION 信封', async (t) => {
    const h = await createHarness(t)
    const missing = await h.rawRequest({ method: 'GET', path: '/nope' })
    assert.equal(missing.status, 404)
    assert.equal(errorOf(missing).code, 'VALIDATION')

    const badMethod = await h.rawRequest({ method: 'DELETE', path: '/status' })
    assert.equal(badMethod.status, 405)
    assert.equal(errorOf(badMethod).code, 'VALIDATION')
    assert.equal(badMethod.contentType, JSON_TYPE)
  })

  it('close 幂等，关闭后端口不再接受请求', async (t) => {
    const h = await createHarness(t)
    await h.daemon.close()
    await h.daemon.close()
    await assert.rejects(h.client.status(), (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'NETWORK')
      return true
    })
  })
})
