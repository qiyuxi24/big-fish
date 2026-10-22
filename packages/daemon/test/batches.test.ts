/**
 * 批次路由测试：POST /tasks 的 created 语义、GET /batches/:id 的聚合与 404、鉴权。
 * 用 FakeQueue 的 enqueueWithReceipt/batchStats（与 core 同契约），覆盖 HTTP 层映射。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createHarness, dataOf, errorOf } from './harness.ts'

const BATCH = 'b-test-20261022'

function enqueueBody(dedupeKey: string, batchId?: string): string {
  return JSON.stringify({
    kind: 'publish',
    dedupeKey,
    payload: { accountId: 'acc-1', title: '测试商品', priceCents: 990 },
    ...(batchId === undefined ? {} : { batchId }),
  })
}

describe('daemon 批次路由', () => {
  it('POST /tasks 首次入队 → 201 且 created=true、带 batchId', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({ method: 'POST', path: '/tasks', body: enqueueBody('k-1', BATCH) })
    assert.equal(response.status, 201)
    const task = dataOf(response) as Record<string, unknown>
    assert.equal(task.created, true)
    assert.equal(task.batchId, BATCH)
    assert.equal(typeof task.id, 'string')
    // 兼容：既有字段仍在顶层，老调用方不用改。
    assert.equal(task.kind, 'publish')
    assert.equal(task.dedupeKey, 'k-1')
    assert.equal(task.state, 'queued')
  })

  it('POST /tasks 重复 dedupeKey → 201 但 created=false，返回的是同一条任务', async (t) => {
    const h = await createHarness(t)
    const first = dataOf(await h.rawRequest({ method: 'POST', path: '/tasks', body: enqueueBody('k-dup', BATCH) })) as Record<string, unknown>
    const second = dataOf(await h.rawRequest({ method: 'POST', path: '/tasks', body: enqueueBody('k-dup', BATCH) })) as Record<string, unknown>
    assert.equal(second.created, false)
    assert.equal(second.id, first.id)
  })

  it('GET /batches/:id → total/counts/items 聚合，只含该批次任务', async (t) => {
    const h = await createHarness(t)
    await h.rawRequest({ method: 'POST', path: '/tasks', body: enqueueBody('k-a', BATCH) })
    await h.rawRequest({ method: 'POST', path: '/tasks', body: enqueueBody('k-b', BATCH) })
    // 不属于这批的任务不该被算进去。
    await h.rawRequest({ method: 'POST', path: '/tasks', body: enqueueBody('k-c') })

    const response = await h.rawRequest({ method: 'GET', path: '/batches/' + BATCH })
    assert.equal(response.status, 200)
    const stats = dataOf(response) as Record<string, unknown>
    assert.equal(stats.batchId, BATCH)
    assert.equal(stats.total, 2)
    assert.deepEqual(stats.counts, { queued: 2, leased: 0, done: 0, failed: 0, needs_review: 0 })
    const items = stats.items as Record<string, unknown>[]
    assert.equal(items.length, 2)
    assert.deepEqual(items.map((item) => item.dedupeKey), ['k-a', 'k-b'])
  })

  it('GET /batches/:id 未知批次 → 404 VALIDATION，信息带批次 id', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({ method: 'GET', path: '/batches/b-nope' })
    assert.equal(response.status, 404)
    const error = errorOf(response)
    assert.equal(error.code, 'VALIDATION')
    assert.match(error.message, /批次不存在/)
  })

  it('GET /batches/:id 未授权 → 401', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({ method: 'GET', path: '/batches/' + BATCH, token: null })
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })
})
