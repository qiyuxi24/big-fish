/**
 * queue.ts 的行为测试：幂等 enqueue、租约领取/过期回收、ack/fail/release、退避、stats、list。
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
import type { TaskQueueHandle } from '../src/data.ts'
import type { TaskRecord } from '../src/types.ts'

const ROOT = fileURLToPath(new URL('../../../.scratch/data-queue-tests/queue/', import.meta.url))
const OWNER = 'daemon-a'

interface Sandbox {
  path(name: string): string
  track<T>(value: T, close: (value: T) => void): T
}

function sandbox(t: TestContext): Sandbox {
  const dir = join(ROOT, randomUUID())
  mkdirSync(dir, { recursive: true })
  const closers: Array<() => void> = []
  t.after(() => {
    for (const close of closers.reverse()) close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    path: (name) => join(dir, name),
    track: (value, close) => {
      closers.push(() => close(value))
      return value
    },
  }
}

interface FakeClock {
  now(): number
  set(value: number): void
}

function fakeClock(start: number): FakeClock {
  let current = start
  return { now: () => current, set: (value) => { current = value } }
}

interface SetupOptions {
  now?: () => number
  idFactory?: () => string
}

function setup(t: TestContext, options: SetupOptions = {}): { queue: TaskQueueHandle; path: string } {
  const box = sandbox(t)
  const path = box.path('queue.db')
  const queue = box.track(createTaskQueue({ path, ...options }), (value: TaskQueueHandle) => value.close())
  return { queue, path }
}

function expectCode(code: ErrorCode, body: () => unknown): void {
  let caught: unknown
  try {
    body()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof XianyuError, `期望抛 XianyuError(${code})，实际：${String(caught)}`)
  assert.equal(caught.code, code)
}

function mustGet(queue: TaskQueueHandle, id: string): TaskRecord {
  const task = queue.get(id)
  assert.ok(task !== undefined, `任务 ${id} 应存在`)
  return task
}

test('enqueue 落库完整记录，get 读回同样的 payload', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, { now: clock.now })
  const payload = { title: '测试商品', images: ['a.jpg', 'b.jpg'], nested: { priceCents: 1999 }, tags: [] }
  const task = queue.enqueue({ kind: 'publish', dedupeKey: 'publish-1', payload })
  assert.equal(task.state, 'queued')
  assert.equal(task.attempts, 0)
  assert.equal(task.maxAttempts, 3)
  assert.equal(task.availableAt, 1_000)
  assert.equal(task.createdAt, 1_000)
  assert.equal(task.updatedAt, 1_000)
  assert.equal(task.leaseOwner, undefined)
  assert.equal(task.leaseUntil, undefined)
  assert.equal(task.lastError, undefined)
  assert.deepEqual(task.payload, payload)
  assert.deepEqual(queue.get(task.id), task)
})

test('dedupeKey 命中：返回既有任务，不重置 attempts/状态/payload', (t) => {
  const clock = fakeClock(5_000)
  const { queue } = setup(t, { now: clock.now })
  const first = queue.enqueue({ kind: 'deliver', dedupeKey: 'order-1', payload: { orderId: 'o1' }, maxAttempts: 5 })
  assert.equal(queue.lease({ owner: OWNER, limit: 1, ttlMs: 10_000, now: 5_000 }).length, 1)
  clock.set(6_000)
  const again = queue.enqueue({ kind: 'deliver', dedupeKey: 'order-1', payload: { orderId: 'o2' }, maxAttempts: 9 })
  assert.equal(again.id, first.id)
  assert.equal(again.attempts, 1)
  assert.equal(again.state, 'leased')
  assert.equal(again.maxAttempts, 5)
  assert.equal(again.updatedAt, 5_000)
  assert.deepEqual(again.payload, { orderId: 'o1' })
})

test('lease 按 available_at/created_at 升序领取且不超过 limit', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, { now: clock.now })
  const a = queue.enqueue({ kind: 'probe', dedupeKey: 'a', payload: {}, availableAt: 3_000 })
  clock.set(1_100)
  const b = queue.enqueue({ kind: 'probe', dedupeKey: 'b', payload: {}, availableAt: 2_000 })
  clock.set(1_200)
  const c = queue.enqueue({ kind: 'probe', dedupeKey: 'c', payload: {}, availableAt: 2_000 })
  clock.set(1_300)
  const d = queue.enqueue({ kind: 'probe', dedupeKey: 'd', payload: {} })
  const leased = queue.lease({ owner: OWNER, limit: 3, ttlMs: 1_000, now: 3_000 })
  assert.deepEqual(leased.map((task) => task.id), [d.id, b.id, c.id])
  assert.equal(mustGet(queue, a.id).state, 'queued')
  assert.equal(mustGet(queue, a.id).attempts, 0)
  const rest = queue.lease({ owner: OWNER, limit: 10, ttlMs: 1_000, now: 3_000 })
  assert.deepEqual(rest.map((task) => task.id), [a.id])
})

test('租约过期后可被第二个 owner 回收，attempts 继续累加', (t) => {
  const clock = fakeClock(10_000)
  const { queue } = setup(t, { now: clock.now })
  const task = queue.enqueue({ kind: 'publish', dedupeKey: 'publish-9', payload: {} })
  const first = queue.lease({ owner: 'daemon-a', limit: 1, ttlMs: 1_000, now: 10_000 })
  assert.equal(first.length, 1)
  assert.equal(mustGet(queue, task.id).leaseUntil, 11_000)
  assert.equal(queue.lease({ owner: 'daemon-b', limit: 1, ttlMs: 1_000, now: 10_999 }).length, 0)
  const reclaim = queue.lease({ owner: 'daemon-b', limit: 1, ttlMs: 2_000, now: 11_000 })
  assert.equal(reclaim.length, 1)
  const record = mustGet(queue, task.id)
  assert.equal(record.leaseOwner, 'daemon-b')
  assert.equal(record.leaseUntil, 13_000)
  assert.equal(record.attempts, 2)
  assert.equal(record.updatedAt, 11_000)
})

test('ack 置 done 并清租约，之后不再被领取', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, { now: clock.now })
  const task = queue.enqueue({ kind: 'reply', dedupeKey: 'reply-1', payload: {} })
  queue.lease({ owner: OWNER, limit: 1, ttlMs: 5_000, now: 1_000 })
  clock.set(2_000)
  queue.ack(task.id, OWNER)
  const done = mustGet(queue, task.id)
  assert.equal(done.state, 'done')
  assert.equal(done.leaseOwner, undefined)
  assert.equal(done.leaseUntil, undefined)
  assert.equal(done.updatedAt, 2_000)
  assert.equal(queue.lease({ owner: OWNER, limit: 5, ttlMs: 1_000, now: 999_000 }).length, 0)
})

test('fail 退避精确：60s→120s→240s→480s，然后用尽 attempts 进 needs_review', (t) => {
  const clock = fakeClock(0)
  const { queue } = setup(t, { now: clock.now })
  const task = queue.enqueue({ kind: 'publish', dedupeKey: 'publish-backoff', payload: {}, maxAttempts: 5 })
  let attemptAt = 1_000
  for (const backoff of [60_000, 120_000, 240_000, 480_000]) {
    assert.equal(queue.lease({ owner: OWNER, limit: 1, ttlMs: 1_000, now: attemptAt }).length, 1)
    clock.set(attemptAt + 500)
    queue.fail(task.id, OWNER, new Error('network down'))
    const failed = mustGet(queue, task.id)
    assert.equal(failed.state, 'queued')
    assert.equal(failed.lastError, 'network down')
    assert.equal(failed.availableAt, attemptAt + 500 + backoff)
    assert.equal(failed.leaseOwner, undefined)
    attemptAt = attemptAt + 500 + backoff
  }
  assert.equal(queue.lease({ owner: OWNER, limit: 1, ttlMs: 1_000, now: attemptAt }).length, 1)
  clock.set(attemptAt)
  queue.fail(task.id, OWNER, 'still broken')
  const exhausted = mustGet(queue, task.id)
  assert.equal(exhausted.attempts, 5)
  assert.equal(exhausted.state, 'needs_review')
})

test('默认 maxAttempts=3：第三次失败直接 needs_review；nonRetryable 直接 failed', (t) => {
  const clock = fakeClock(0)
  const { queue } = setup(t, { now: clock.now })
  const retrying = queue.enqueue({ kind: 'deliver', dedupeKey: 'deliver-retry', payload: {} })
  let now = 0
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    assert.equal(queue.lease({ owner: OWNER, limit: 1, ttlMs: 1_000, now }).length, 1)
    clock.set(now)
    queue.fail(retrying.id, OWNER, 'timeout')
    now = mustGet(queue, retrying.id).availableAt
  }
  assert.equal(mustGet(queue, retrying.id).state, 'queued')
  assert.equal(queue.lease({ owner: OWNER, limit: 1, ttlMs: 1_000, now }).length, 1)
  queue.fail(retrying.id, OWNER, 'timeout')
  assert.equal(mustGet(queue, retrying.id).state, 'needs_review')

  const fatal = queue.enqueue({ kind: 'publish', dedupeKey: 'publish-fatal', payload: {}, maxAttempts: 9 })
  assert.equal(queue.lease({ owner: OWNER, limit: 1, ttlMs: 1_000, now: 900_000 }).length, 1)
  clock.set(900_000)
  queue.fail(fatal.id, OWNER, '风控拦截', { nonRetryable: true })
  const failed = mustGet(queue, fatal.id)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.attempts, 1)
  assert.equal(failed.lastError, '风控拦截')
})

test('lastError 截断到 500 字符', (t) => {
  const clock = fakeClock(0)
  const { queue } = setup(t, { now: clock.now })
  const task = queue.enqueue({ kind: 'probe', dedupeKey: 'probe-long', payload: {} })
  queue.lease({ owner: OWNER, limit: 1, ttlMs: 1_000, now: 0 })
  queue.fail(task.id, OWNER, 'x'.repeat(600), { nonRetryable: true })
  assert.equal(mustGet(queue, task.id).lastError?.length, 500)
})

test('release 回队列且不消耗退避：availableAt=now、attempts 不变', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, { now: clock.now })
  const task = queue.enqueue({ kind: 'polish', dedupeKey: 'polish-1', payload: {} })
  queue.lease({ owner: OWNER, limit: 1, ttlMs: 60_000, now: 1_000 })
  clock.set(3_000)
  queue.release(task.id, OWNER)
  const queued = mustGet(queue, task.id)
  assert.equal(queued.state, 'queued')
  assert.equal(queued.attempts, 1)
  assert.equal(queued.availableAt, 3_000)
  assert.equal(queued.leaseOwner, undefined)
  const reclaimed = queue.lease({ owner: 'daemon-b', limit: 1, ttlMs: 1_000, now: 3_000 })
  assert.deepEqual(reclaimed.map((record) => record.id), [task.id])
})

test('租约归属不符或非 leased → VALIDATION', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, { now: clock.now })
  const task = queue.enqueue({ kind: 'publish', dedupeKey: 'publish-owner', payload: {} })
  expectCode('VALIDATION', () => queue.ack(task.id, OWNER))
  queue.lease({ owner: OWNER, limit: 1, ttlMs: 1_000, now: 1_000 })
  expectCode('VALIDATION', () => queue.ack(task.id, 'daemon-b'))
  expectCode('VALIDATION', () => queue.fail(task.id, 'daemon-b', 'boom'))
  expectCode('VALIDATION', () => queue.release(task.id, 'daemon-b'))
  expectCode('VALIDATION', () => queue.ack('missing-id', OWNER))
  queue.ack(task.id, OWNER)
  expectCode('VALIDATION', () => queue.ack(task.id, OWNER))
})

test('stats 覆盖五个状态且缺省为 0；list 支持 state/kind/limit 过滤', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, { now: clock.now })
  const tasks: TaskRecord[] = []
  for (const [index, kind] of (['publish', 'deliver', 'probe', 'reply', 'polish'] as const).entries()) {
    clock.set(1_000 + index)
    tasks.push(queue.enqueue({ kind, dedupeKey: `stat-${index}`, payload: { index }, ...(index === 2 ? { maxAttempts: 1 } : {}) }))
  }
  const leased = queue.lease({ owner: OWNER, limit: 5, ttlMs: 1_000, now: 2_000 })
  assert.equal(leased.length, 5)
  queue.ack(tasks[0]!.id, OWNER)
  queue.fail(tasks[1]!.id, OWNER, 'boom', { nonRetryable: true })
  clock.set(2_000)
  queue.fail(tasks[2]!.id, OWNER, 'boom')
  queue.release(tasks[3]!.id, OWNER)
  // tasks[4] 保持 leased
  assert.deepEqual(queue.stats(), { queued: 1, leased: 1, done: 1, failed: 1, needs_review: 1 })
  assert.deepEqual(queue.list().map((task) => task.id), tasks.map((task) => task.id))
  assert.deepEqual(queue.list({ state: 'done' }).map((task) => task.id), [tasks[0]!.id])
  assert.deepEqual(queue.list({ kind: 'publish' }).map((task) => task.id), [tasks[0]!.id])
  assert.deepEqual(queue.list({ limit: 2 }).map((task) => task.id), [tasks[0]!.id, tasks[1]!.id])
  assert.equal(queue.list({ kind: 'deliver', state: 'leased' }).length, 0)
})

test('入参校验：kind/payload/dedupeKey/limit/ttlMs 非法 → VALIDATION', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, { now: clock.now })
  expectCode('VALIDATION', () => queue.enqueue({ kind: 'upload' as unknown as 'publish', dedupeKey: 'k', payload: {} }))
  expectCode('VALIDATION', () => queue.enqueue({ kind: 'publish', dedupeKey: '  ', payload: {} }))
  expectCode('VALIDATION', () => queue.enqueue({ kind: 'publish', dedupeKey: 'k2', payload: [] as unknown as Record<string, unknown> }))
  expectCode('VALIDATION', () => queue.enqueue({ kind: 'publish', dedupeKey: 'k3', payload: 'x' as unknown as Record<string, unknown> }))
  expectCode('VALIDATION', () => queue.lease({ owner: OWNER, limit: 0, ttlMs: 1_000 }))
  expectCode('VALIDATION', () => queue.lease({ owner: OWNER, limit: 1, ttlMs: 0 }))
  expectCode('VALIDATION', () => queue.lease({ owner: ' ', limit: 1, ttlMs: 1_000 }))
  expectCode('VALIDATION', () => queue.list({ state: 'gone' as unknown as 'queued' }))
  assert.deepEqual(queue.list(), [])
  assert.deepEqual(queue.stats(), { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 })
})

test('注入 idFactory/now 生效；close 幂等，关闭后调用报 STORAGE', (t) => {
  const ids = ['task-1', 'task-2']
  const clock = fakeClock(7_000)
  const { queue } = setup(t, { now: clock.now, idFactory: () => ids.shift() ?? 'task-fallback' })
  const task = queue.enqueue({ kind: 'probe', dedupeKey: 'id-1', payload: {} })
  assert.equal(task.id, 'task-1')
  assert.equal(task.createdAt, 7_000)
  assert.doesNotThrow(() => queue.close())
  assert.doesNotThrow(() => queue.close())
  expectCode('STORAGE', () => queue.get(task.id))
  expectCode('STORAGE', () => queue.enqueue({ kind: 'probe', dedupeKey: 'id-2', payload: {} }))
})

test('createTaskQueue 缺 path/store → VALIDATION', () => {
  expectCode('VALIDATION', () => createTaskQueue({}))
  expectCode('VALIDATION', () => createTaskQueue({ path: '  ' }))
})
