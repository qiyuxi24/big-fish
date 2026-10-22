/**
 * GET /events 路由测试：增量游标、过滤参数、未装配能力与非法入参。
 * 事件存储用假 sink（只断言 query 透传与信封），真实读写由 core 的 task-events 单测覆盖。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { TaskEventQuery, TaskEventRecord, TaskEventSink } from '@bigfish/core'

import { createHarness, dataOf, errorOf } from './harness.ts'

interface FakeSink extends TaskEventSink {
  queries: TaskEventQuery[]
}

function makeSink(records: TaskEventRecord[] = []): FakeSink {
  const queries: TaskEventQuery[] = []
  return {
    queries,
    append(input) {
      const record: TaskEventRecord = { id: records.length + 1, at: 1, taskId: input.taskId, kind: input.kind }
      records.push(record)
      return record
    },
    list(query: TaskEventQuery = {}) {
      queries.push(query)
      return records
    },
  }
}

function makeRecord(id: number, overrides: Partial<TaskEventRecord> = {}): TaskEventRecord {
  return { id, at: 1_700_000_000_000 + id, taskId: 't1', kind: 'task.step', step: '填标题', message: '开始', state: 'started', ...overrides }
}

describe('daemon GET /events', () => {
  it('未装配事件流 → 500 UNSUPPORTED（不返回空流假装正常）', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({ method: 'GET', path: '/events' })
    assert.equal(response.status, 500)
    assert.equal(errorOf(response).code, 'UNSUPPORTED')
  })

  it('带上鉴权 → 200 {items,nextSince}，nextSince 取最后一条 id', async (t) => {
    const sink = makeSink([makeRecord(3), makeRecord(4)])
    const h = await createHarness(t, { events: sink })
    const response = await h.rawRequest({ method: 'GET', path: '/events' })
    assert.equal(response.status, 200)
    const data = dataOf(response) as { items: TaskEventRecord[]; nextSince: number }
    assert.deepEqual(data.items.map((row) => row.id), [3, 4])
    assert.equal(data.nextSince, 4)
    assert.deepEqual(sink.queries, [{}])
  })

  it('空流 → items 为空且 nextSince 回落到 since（面板轮询不会卡住）', async (t) => {
    const sink = makeSink([])
    const h = await createHarness(t, { events: sink })
    const response = await h.rawRequest({ method: 'GET', path: '/events?since=7' })
    assert.equal(response.status, 200)
    const data = dataOf(response) as { items: TaskEventRecord[]; nextSince: number }
    assert.deepEqual(data.items, [])
    assert.equal(data.nextSince, 7)
  })

  it('since/limit/taskId/batchId 原样透传给事件存储', async (t) => {
    const sink = makeSink([makeRecord(9, { batchId: 'b1', taskId: 't9' })])
    const h = await createHarness(t, { events: sink })
    const response = await h.rawRequest({ method: 'GET', path: '/events?since=5&limit=10&taskId=t9&batchId=b1' })
    assert.equal(response.status, 200)
    assert.deepEqual(sink.queries, [{ since: 5, limit: 10, taskId: 't9', batchId: 'b1' }])
  })

  it('非法 since（负数/非数字）→ 400 VALIDATION', async (t) => {
    const sink = makeSink([])
    const h = await createHarness(t, { events: sink })
    for (const path of ['/events?since=-1', '/events?since=abc', '/events?limit=0']) {
      const response = await h.rawRequest({ method: 'GET', path })
      assert.equal(response.status, 400, path)
      assert.equal(errorOf(response).code, 'VALIDATION', path)
    }
    assert.deepEqual(sink.queries, [])
  })

  it('未授权 → 401（事件流含任务 payload 摘要，属读敏感）', async (t) => {
    const sink = makeSink([])
    const h = await createHarness(t, { events: sink })
    const response = await h.rawRequest({ method: 'GET', path: '/events', token: null })
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })
})
