/**
 * queue.requeue 的行为测试：failed / needs_review 人工收尾 → queued（attempts 归零、清 lastError）。
 * 只通过公开出口使用实现；时间全部注入假时钟，不 sleep。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { XianyuError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import { createTaskQueue } from '../src/data.ts'
import type { RequeueOptions, TaskQueueHandle } from '../src/data.ts'
import type { TaskRecord } from '../src/types.ts'

const ROOT = fileURLToPath(new URL('../../../.scratch/data-queue-tests/queue-requeue/', import.meta.url))
const OWNER = 'daemon-a'
const START = 1_000

interface FakeClock {
  now(): number
  set(value: number): void
}

function fakeClock(start: number): FakeClock {
  let current = start
  return {
    now: () => current,
    set: (value) => {
      current = value
    },
  }
}

function setup(t: TestContext, clock: FakeClock): TaskQueueHandle {
  const dir = join(ROOT, randomUUID())
  mkdirSync(dir, { recursive: true })
  const queue = createTaskQueue({ path: join(dir, 'queue.db'), now: clock.now })
  t.after(() => {
    queue.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return queue
}

function expectCode(code: ErrorCode, body: () => unknown): XianyuError {
  let caught: unknown
  try {
    body()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof XianyuError, `期望抛 XianyuError(${code})，实际：${String(caught)}`)
  assert.equal(caught.code, code)
  return caught
}

function mustGet(queue: TaskQueueHandle, id: string): TaskRecord {
  const task = queue.get(id)
  assert.ok(task !== undefined, `任务 ${id} 应存在`)
  return task
}

/** 造一个 failed 任务：入队 → 领取 → 以 nonRetryable 失败（写操作不可重试的典型形态）。 */
function makeFailed(queue: TaskQueueHandle, dedupeKey = 'publish-failed'): TaskRecord {
  const task = queue.enqueue({ kind: 'publish', dedupeKey, payload: { title: '失败商品', priceCents: 1999 } })
  queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
  queue.fail(task.id, OWNER, new Error('页面元素超时'), { nonRetryable: true })
  return mustGet(queue, task.id)
}

/** 造一个 needs_review 任务：maxAttempts=1，失败一次即次数用尽。 */
function makeNeedsReview(queue: TaskQueueHandle): TaskRecord {
  const task = queue.enqueue({ kind: 'publish', dedupeKey: 'publish-review', payload: { title: '待审商品' }, maxAttempts: 1 })
  queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
  queue.fail(task.id, OWNER, '风控冷却中')
  return mustGet(queue, task.id)
}

test('requeue 把 failed 任务重置为 queued，attempts 归零并清空 lastError 与租约字段', (t) => {
  const clock = fakeClock(START)
  const queue = setup(t, clock)
  const failed = makeFailed(queue)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.attempts, 1)
  assert.ok(failed.lastError !== undefined)

  const record = queue.requeue(failed.id)
  assert.equal(record.id, failed.id)
  assert.equal(record.state, 'queued')
  assert.equal(record.attempts, 0, '人工重试应重获完整重试预算')
  assert.equal(record.maxAttempts, failed.maxAttempts)
  assert.equal(record.lastError, undefined)
  assert.equal(record.leaseOwner, undefined)
  assert.equal(record.leaseUntil, undefined)
  assert.equal(record.dedupeKey, failed.dedupeKey)
  assert.deepEqual(record.payload, failed.payload)
  assert.equal(record.availableAt, START, '缺省立刻可领取')
  assert.equal(record.updatedAt, START)
})

test('requeue 把 needs_review 任务重置为 queued', (t) => {
  const clock = fakeClock(START)
  const queue = setup(t, clock)
  const review = makeNeedsReview(queue)
  assert.equal(review.state, 'needs_review')

  const record = queue.requeue(review.id)
  assert.equal(record.state, 'queued')
  assert.equal(record.attempts, 0)
})

test('requeue 后任务可被重新领取并按新预算重试', (t) => {
  const clock = fakeClock(START)
  const queue = setup(t, clock)
  const failed = makeFailed(queue, 'publish-retry-once')

  queue.requeue(failed.id)
  const [claimed] = queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
  assert.equal(claimed?.id, failed.id)
  assert.equal(claimed?.state, 'leased')
  assert.equal(claimed?.attempts, 1, '领取即消耗一次重试预算')
})

test('requeue 保留 dedupeKey：同 key 再次 enqueue 仍是同一条任务', (t) => {
  const clock = fakeClock(START)
  const queue = setup(t, clock)
  const failed = makeFailed(queue, 'publish-same-key')
  queue.requeue(failed.id)

  const again = queue.enqueue({ kind: 'publish', dedupeKey: 'publish-same-key', payload: { title: '重复入队' } })
  assert.equal(again.id, failed.id)
  assert.deepEqual(again.payload, failed.payload, 'ON CONFLICT DO NOTHING 不应改写已排队任务的 payload')
})

test('requeue 拒绝 queued / leased / done 状态', (t) => {
  const clock = fakeClock(START)
  const queue = setup(t, clock)
  const queued = queue.enqueue({ kind: 'probe', dedupeKey: 'probe-queued', payload: {} })
  expectCode('VALIDATION', () => queue.requeue(queued.id))

  queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
  expectCode('VALIDATION', () => queue.requeue(queued.id))

  queue.ack(queued.id, OWNER)
  const done = mustGet(queue, queued.id)
  assert.equal(done.state, 'done')
  const error = expectCode('VALIDATION', () => queue.requeue(queued.id))
  assert.match(error.message, /only failed \/ needs_review|只有 failed \/ needs_review/)
})

test('requeue 不存在的 id → NOT_FOUND；非法 id / options → VALIDATION', (t) => {
  const clock = fakeClock(START)
  const queue = setup(t, clock)
  // id 写错要能区分出来：调用方需要知道「去列表拿真实 id」，而不是「参数格式不对」。
  const missing = expectCode('NOT_FOUND', () => queue.requeue('no-such-task'))
  assert.match(missing.message, /任务不存在/)
  expectCode('VALIDATION', () => queue.requeue(''))
  expectCode('VALIDATION', () => queue.requeue(123 as unknown as string))
  const failed = makeFailed(queue, 'publish-bad-options')
  expectCode('VALIDATION', () => queue.requeue(failed.id, 'later' as unknown as RequeueOptions))
  expectCode('VALIDATION', () => queue.requeue(failed.id, { availableAt: 1.5 }))
  assert.equal(mustGet(queue, failed.id).state, 'failed', '非法入参不得改动任务')
})

test('requeue 的 availableAt 生效：到点前领取不到，到点后可领取', (t) => {
  const clock = fakeClock(START)
  const queue = setup(t, clock)
  const failed = makeFailed(queue, 'publish-later')

  const record = queue.requeue(failed.id, { availableAt: START + 1_000 })
  assert.equal(record.state, 'queued')
  assert.equal(record.availableAt, START + 1_000)

  clock.set(START + 999)
  assert.equal(queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 }).length, 0)
  clock.set(START + 1_000)
  const [claimed] = queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000 })
  assert.equal(claimed?.id, failed.id)
})

test('requeue 对已关闭队列抛 STORAGE', (t) => {
  const clock = fakeClock(START)
  const queue = setup(t, clock)
  const failed = makeFailed(queue, 'publish-closed')
  queue.close()
  expectCode('STORAGE', () => queue.requeue(failed.id))
})
