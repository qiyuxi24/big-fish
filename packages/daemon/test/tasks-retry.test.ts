/**
 * POST /tasks/:id/retry 路由测试：鉴权、404、状态冲突 400、成功重排、注入能力被调用。
 * 用 FakeQueue 的 requeue 覆盖真实状态校验；时间来自夹具的假时钟，不 sleep。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createHarness, dataOf, errorOf } from './harness.ts'
import type { DaemonHarness } from './harness.ts'

const OWNER = 'daemon-test'

/** 造一个 failed 任务：入队 → 领取 → nonRetryable 失败；返回任务 id。 */
function makeFailed(h: DaemonHarness, dedupeKey: string): string {
  const record = h.queue.enqueue({ kind: 'publish', dedupeKey, payload: { title: '失败商品', priceCents: 1999 } })
  const leased = h.queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
  assert.equal(leased.length, 1)
  h.queue.fail(record.id, OWNER, new Error('页面元素超时'), { nonRetryable: true })
  assert.equal(h.queue.get(record.id)?.state, 'failed')
  return record.id
}

describe('daemon POST /tasks/:id/retry 路由', () => {
  it('缺少或无效 token → 401 UNAUTHORIZED（重试是写操作，不能匿名触发）', async (t) => {
    const h = await createHarness(t)
    const id = makeFailed(h, 'publish-auth')
    const response = await h.rawRequest({ method: 'POST', path: '/tasks/' + id + '/retry', token: null })
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
    assert.equal(h.queue.get(id)?.state, 'failed', '未授权请求不得改动任务')
  })

  it('任务不存在 → 404 VALIDATION，错误信息带 id', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({ method: 'POST', path: '/tasks/no-such-task/retry' })
    assert.equal(response.status, 404)
    const error = errorOf(response)
    assert.equal(error.code, 'VALIDATION')
    assert.match(error.message, /任务不存在/)
  })

  it('failed 任务 → 200，state=queued、attempts 归零、lastError 清空、保留 dedupeKey/payload', async (t) => {
    const h = await createHarness(t)
    const id = makeFailed(h, 'publish-ok')
    const before = h.queue.get(id)
    assert.ok(before !== undefined)

    const response = await h.rawRequest({ method: 'POST', path: '/tasks/' + id + '/retry' })
    assert.equal(response.status, 200)
    const record = dataOf(response) as Record<string, unknown>
    assert.equal(record.id, id)
    assert.equal(record.state, 'queued')
    assert.equal(record.attempts, 0)
    assert.equal(record.lastError, undefined)
    assert.equal(record.leaseOwner, undefined)
    assert.equal(record.leaseUntil, undefined)
    assert.equal(record.dedupeKey, before.dedupeKey)
    assert.deepEqual(record.payload, before.payload)
    assert.equal(record.availableAt, h.now())
    assert.deepEqual(h.queue.requeueCalls, [id], '重试应恰好重排一次')
  })

  it('needs_review 任务同样可以重新排队', async (t) => {
    const h = await createHarness(t)
    const record = h.queue.enqueue({ kind: 'publish', dedupeKey: 'publish-review', payload: {}, maxAttempts: 1 })
    h.queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
    h.queue.fail(record.id, OWNER, '次数用尽')
    assert.equal(h.queue.get(record.id)?.state, 'needs_review')

    const response = await h.rawRequest({ method: 'POST', path: '/tasks/' + record.id + '/retry' })
    assert.equal(response.status, 200)
    assert.equal((dataOf(response) as Record<string, unknown>).state, 'queued')
  })

  it('queued / leased / done 状态 → 400 VALIDATION，任务保持原状', async (t) => {
    const h = await createHarness(t)
    const record = h.queue.enqueue({ kind: 'probe', dedupeKey: 'probe-state', payload: {} })

    const queuedResponse = await h.rawRequest({ method: 'POST', path: '/tasks/' + record.id + '/retry' })
    assert.equal(queuedResponse.status, 400)
    assert.equal(errorOf(queuedResponse).code, 'VALIDATION')
    assert.equal(h.queue.get(record.id)?.state, 'queued')

    h.queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
    const leasedResponse = await h.rawRequest({ method: 'POST', path: '/tasks/' + record.id + '/retry' })
    assert.equal(leasedResponse.status, 400)
    assert.equal(h.queue.get(record.id)?.state, 'leased')

    h.queue.ack(record.id, OWNER)
    const doneResponse = await h.rawRequest({ method: 'POST', path: '/tasks/' + record.id + '/retry' })
    assert.equal(doneResponse.status, 400)
    assert.equal(h.queue.get(record.id)?.state, 'done')
    assert.deepEqual(h.queue.requeueCalls, [])
  })

  it('注入的 retryTask 被调用一次，其返回值原样作为 200 响应（唤醒逻辑由 runtime 负责）', async (t) => {
    const seen: string[] = []
    const h = await createHarness(t, {
      retryTask: (id) => {
        seen.push(id)
        return {
          id,
          kind: 'publish',
          dedupeKey: 'injected',
          payload: { from: 'injected' },
          state: 'queued',
          attempts: 0,
          maxAttempts: 3,
          availableAt: 1,
          createdAt: 1,
          updatedAt: 1,
        }
      },
    })
    const failed = makeFailed(h, 'publish-injected')
    const response = await h.rawRequest({ method: 'POST', path: '/tasks/' + failed + '/retry' })
    assert.equal(response.status, 200)
    assert.deepEqual(seen, [failed])
    assert.equal((dataOf(response) as Record<string, unknown>).dedupeKey, 'injected')
    assert.deepEqual(h.queue.requeueCalls, [], '注入的实现取代默认 requeue')
  })

  it('方法不匹配 / 尾斜杠：GET 同一路径 → 405，POST 带尾斜杠仍 200', async (t) => {
    const h = await createHarness(t)
    const id = makeFailed(h, 'publish-method')
    const wrongMethod = await h.rawRequest({ method: 'GET', path: '/tasks/' + id + '/retry' })
    assert.equal(wrongMethod.status, 405)

    const withSlash = await h.rawRequest({ method: 'POST', path: '/tasks/' + id + '/retry/' })
    assert.equal(withSlash.status, 200)
  })
})
