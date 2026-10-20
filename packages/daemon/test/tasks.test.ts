/**
 * 任务相关路由测试：入队幂等、脱敏、参数校验、ack/fail/release 状态机、items/circuits 占位。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createHarness, dataOf, errorOf } from './harness.ts'
import type { DaemonHarness } from './harness.ts'

const OWNER = 'daemon-test'

/** 入队一个任务并领取，返回租约中的记录 id。 */
async function enqueueAndLease(h: DaemonHarness, dedupeKey: string): Promise<string> {
  const record = h.queue.enqueue({ kind: 'publish', dedupeKey, payload: { itemId: dedupeKey } })
  const leased = h.queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
  assert.equal(leased.length, 1)
  return record.id
}

describe('daemon /tasks 路由', () => {
  it('POST /tasks → 201，幂等键透传，payload 中的敏感字段被 redact', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({
      method: 'POST',
      path: '/tasks',
      body: JSON.stringify({ kind: 'publish', dedupeKey: 'item-1', payload: { itemId: 'i1', cookie: 'SECRET-COOKIE' } }),
    })
    assert.equal(response.status, 201)
    const record = dataOf(response) as Record<string, unknown>
    assert.equal(record.kind, 'publish')
    assert.equal(record.dedupeKey, 'item-1')
    assert.equal(record.state, 'queued')
    const payload = record.payload as Record<string, unknown>
    assert.equal(payload.itemId, 'i1')
    assert.equal(payload.cookie, '[redacted]')
  })

  it('同一 dedupeKey 重复入队返回同一条记录（幂等）', async (t) => {
    const h = await createHarness(t)
    const first = await h.client.enqueue({ kind: 'deliver', dedupeKey: 'order-9', payload: { orderId: 'o9' } })
    const second = await h.rawRequest({
      method: 'POST',
      path: '/tasks',
      body: JSON.stringify({ kind: 'deliver', dedupeKey: 'order-9', payload: { orderId: 'o9' } }),
    })
    assert.equal(second.status, 201)
    assert.equal((dataOf(second) as Record<string, unknown>).id, first.id)
  })

  it('未知 kind 交给 queue 校验，映射 400 VALIDATION', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({
      method: 'POST',
      path: '/tasks',
      body: JSON.stringify({ kind: 'nope', dedupeKey: 'k-bad', payload: {} }),
    })
    assert.equal(response.status, 400)
    assert.equal(errorOf(response).code, 'VALIDATION')
    assert.match(errorOf(response).message, /kind/)
  })

  it('非法 JSON → 400；超出 1 MiB 的 body → 413', async (t) => {
    const h = await createHarness(t)
    const broken = await h.rawRequest({ method: 'POST', path: '/tasks', body: '{oops' })
    assert.equal(broken.status, 400)
    assert.equal(errorOf(broken).code, 'VALIDATION')

    const oversized = await h.rawRequest({ method: 'POST', path: '/tasks', body: 'x'.repeat(1024 * 1024 + 1) })
    assert.equal(oversized.status, 413)
    assert.equal(errorOf(oversized).code, 'VALIDATION')
  })

  it('GET /tasks/:id 不存在 → 404；存在 → 200', async (t) => {
    const h = await createHarness(t)
    const missing = await h.rawRequest({ method: 'GET', path: '/tasks/nope' })
    assert.equal(missing.status, 404)
    assert.equal(errorOf(missing).code, 'VALIDATION')

    const record = await h.client.enqueue({ kind: 'probe', dedupeKey: 'probe-1', payload: {} })
    const found = await h.client.getTask(record.id)
    assert.equal(found.id, record.id)
  })

  it('GET /tasks 校验 state/kind/limit，且过滤生效', async (t) => {
    const h = await createHarness(t)
    h.queue.enqueue({ kind: 'publish', dedupeKey: 'p1', payload: {} })
    h.queue.enqueue({ kind: 'reply', dedupeKey: 'r1', payload: {} })

    const publishes = await h.client.listTasks({ kind: 'publish' })
    assert.equal(publishes.length, 1)
    assert.equal(publishes[0]?.kind, 'publish')
    assert.equal((await h.client.listTasks({ limit: 1 })).length, 1)

    for (const query of ['state=bogus', 'kind=bogus', 'limit=0', 'limit=abc']) {
      const response = await h.rawRequest({ method: 'GET', path: '/tasks?' + query })
      assert.equal(response.status, 400, query)
      assert.equal(errorOf(response).code, 'VALIDATION', query)
    }
  })

  it('ack 成功 → done，重复 ack → 409', async (t) => {
    const h = await createHarness(t)
    const id = await enqueueAndLease(h, 'ack-1')
    const done = await h.client.ack(id, OWNER)
    assert.equal(done.state, 'done')

    const conflict = await h.rawRequest({
      method: 'POST',
      path: '/tasks/' + id + '/ack',
      body: JSON.stringify({ owner: OWNER }),
    })
    assert.equal(conflict.status, 409)
    assert.equal(errorOf(conflict).code, 'VALIDATION')
  })

  it('fail 可重试 → 回 queued，nonRetryable → failed', async (t) => {
    const h = await createHarness(t)
    const retryId = await enqueueAndLease(h, 'fail-1')
    const retried = await h.client.fail(retryId, OWNER, '网络抖动')
    assert.equal(retried.state, 'queued')
    assert.equal(retried.lastError, '网络抖动')

    h.setNow(h.now() + 60_000)
    const leased = h.queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
    assert.equal(leased[0]?.id, retryId)
    const failed = await h.client.fail(retryId, OWNER, '参数错误', true)
    assert.equal(failed.state, 'failed')
  })

  it('release 归还租约；owner 不匹配 → 409', async (t) => {
    const h = await createHarness(t)
    const id = await enqueueAndLease(h, 'release-1')
    const released = await h.client.release(id, OWNER)
    assert.equal(released.state, 'queued')

    const conflict = await h.rawRequest({
      method: 'POST',
      path: '/tasks/' + id + '/fail',
      body: JSON.stringify({ owner: 'other', error: 'x' }),
    })
    assert.equal(conflict.status, 409)
  })

  it('/items 返回空数组；/circuits/reset 需要 accountId', async (t) => {
    const h = await createHarness(t)
    assert.deepEqual(await h.client.listItems(), [])

    const reset = await h.rawRequest({
      method: 'POST',
      path: '/circuits/reset',
      body: JSON.stringify({ accountId: 'acc-1' }),
    })
    assert.equal(reset.status, 200)
    assert.deepEqual(dataOf(reset), {})

    const invalid = await h.rawRequest({ method: 'POST', path: '/circuits/reset', body: '{}' })
    assert.equal(invalid.status, 400)
    assert.equal(errorOf(invalid).code, 'VALIDATION')
  })
})
