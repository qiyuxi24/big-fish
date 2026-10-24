/**
 * 批次底座测试：v1→v2 迁移（含可重入）、batchId 校验、enqueueWithReceipt 的 created 语义、
 * batchStats 的计数/顺序/上限。时间全部走假时钟，不 sleep。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTaskQueue, openStore } from '../src/data.ts'
import type { Store, TaskQueueHandle } from '../src/data.ts'
import { XianyuError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'

const ROOT = fileURLToPath(new URL('../../../.scratch/data-queue-tests/batch/', import.meta.url))
const OWNER = 'daemon-a'

interface Sandbox {
  dir: string
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
    dir,
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

function setup(t: TestContext, now: () => number, idFactory?: () => string): { queue: TaskQueueHandle; store: Store; path: string } {
  const box = sandbox(t)
  const path = box.path('queue.db')
  const store = box.track(openStore({ path, now }), (value: Store) => value.close())
  const queue = box.track(createTaskQueue({ store, now, ...(idFactory === undefined ? {} : { idFactory }) }), (value: TaskQueueHandle) => value.close())
  return { queue, store, path }
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

/** v1 时代的库：tasks 没有 batch_id 列，schema_migrations 只记了版本 1。 */
const V1_SCHEMA_SQL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_until INTEGER,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state IN ('queued', 'leased', 'done', 'failed', 'needs_review')),
  CHECK (kind IN ('publish', 'deliver', 'polish', 'reply', 'probe'))
);
CREATE INDEX idx_tasks_claim ON tasks(state, available_at);
CREATE INDEX idx_tasks_lease ON tasks(lease_until);
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1000);
INSERT INTO tasks (id, kind, dedupe_key, payload, state, attempts, max_attempts, lease_owner, lease_until, available_at, last_error, created_at, updated_at)
VALUES ('legacy-1', 'publish', 'legacy-key', '{"title":"旧任务"}', 'queued', 0, 3, NULL, NULL, 1000, NULL, 1000, 1000);
`

function writeLegacyDb(path: string, withBatchColumn: boolean): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(V1_SCHEMA_SQL)
    if (withBatchColumn) db.exec('ALTER TABLE tasks ADD COLUMN batch_id TEXT')
  } finally {
    db.close()
  }
}

function migrationVersions(store: Store): number[] {
  return store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version))
}

test('旧库（v1，无 batch_id 列）打开后自动迁移 v2：历史任务可读、可继续入队与建批次', (t) => {
  const box = sandbox(t)
  const path = box.path('legacy.db')
  writeLegacyDb(path, false)
  const store = box.track(openStore({ path, now: () => 5_000 }), (value: Store) => value.close())
  assert.deepEqual(migrationVersions(store), [1, 2, 3, 4, 5])

  const queue = box.track(createTaskQueue({ store, now: () => 5_000 }), (value: TaskQueueHandle) => value.close())
  const legacy = queue.get('legacy-1')
  assert.ok(legacy !== undefined, '旧任务应仍可读')
  assert.equal(legacy.state, 'queued')
  assert.deepEqual(legacy.payload, { title: '旧任务' })
  // 历史行没有批次归属：字段应当缺省，而不是空字符串或 'undefined'
  assert.equal('batchId' in legacy, false)
  assert.deepEqual(queue.list().map((task) => task.id), ['legacy-1'])

  const receipt = queue.enqueueWithReceipt({ kind: 'publish', dedupeKey: 'new-1', payload: {}, batchId: 'batch-old-db' })
  assert.equal(receipt.created, true)
  assert.equal(receipt.task.batchId, 'batch-old-db')
  assert.equal(queue.batchStats('batch-old-db').total, 1)

  queue.close()
  store.close()

  // 迁移幂等：重开不重复 ALTER，也不重复记账
  const reopened = box.track(openStore({ path }), (value: Store) => value.close())
  assert.deepEqual(migrationVersions(reopened), [1, 2, 3, 4, 5])
})

test('列已存在但版本未记录：迁移可重入，不因 duplicate column 启动失败', (t) => {
  const box = sandbox(t)
  const path = box.path('half-migrated.db')
  writeLegacyDb(path, true)
  const store = box.track(openStore({ path, now: () => 7_000 }), (value: Store) => value.close())
  assert.deepEqual(migrationVersions(store), [1, 2, 3, 4, 5])
  const queue = box.track(createTaskQueue({ store, now: () => 7_000 }), (value) => value.close())
  assert.equal(queue.get('legacy-1')?.state, 'queued')
  assert.equal(queue.enqueue({ kind: 'probe', dedupeKey: 'p-1', payload: {}, batchId: 'b1' }).batchId, 'b1')
})

test('enqueueWithReceipt：首次 created=true，dedupeKey 命中 created=false 且不重置 attempts/payload/batchId', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, clock.now)
  const first = queue.enqueueWithReceipt({ kind: 'publish', dedupeKey: 'k-1', payload: { title: '甲' }, batchId: 'b1' })
  assert.equal(first.created, true)
  assert.equal(first.task.attempts, 0)
  assert.equal(first.task.batchId, 'b1')

  assert.equal(queue.lease({ owner: OWNER, limit: 1, ttlMs: 10_000, now: 1_000 }).length, 1)
  clock.set(2_000)
  const again = queue.enqueueWithReceipt({ kind: 'publish', dedupeKey: 'k-1', payload: { title: '乙' }, batchId: 'b2' })
  assert.equal(again.created, false)
  assert.equal(again.task.id, first.task.id)
  assert.equal(again.task.state, 'leased')
  assert.equal(again.task.attempts, 1)
  assert.deepEqual(again.task.payload, { title: '甲' })
  // 批次归属属于「第一次入队」，重放不能把任务从原批次里拽走
  assert.equal(again.task.batchId, 'b1')
  assert.equal(queue.batchStats('b2').total, 0)
})

test('batchId 校验：非法值 VALIDATION 且不入队；合法字符集（含 64 位）可用', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, clock.now)
  for (const bad of ['', 'a b', '中文', 'a/b', 'x'.repeat(65), 42, null]) {
    expectCode('VALIDATION', () => queue.enqueue({ kind: 'probe', dedupeKey: `bad-${String(bad)}`, payload: {}, batchId: bad as unknown as string }))
  }
  assert.equal(queue.list().length, 0)

  const longest = 'x'.repeat(64)
  assert.equal(queue.enqueue({ kind: 'probe', dedupeKey: 'ok-long', payload: {}, batchId: longest }).batchId, longest)
  assert.equal(queue.enqueue({ kind: 'probe', dedupeKey: 'ok-chars', payload: {}, batchId: 'batch.2026-10_22' }).batchId, 'batch.2026-10_22')
  // 查询侧同样校验，避免把任意字符串当 batch id 扫库
  expectCode('VALIDATION', () => queue.batchStats('bad id'))
})

test('batchStats：counts 覆盖五行状态、total 为真实总数、items 按 created_at 升序', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, clock.now)
  const a = queue.enqueue({ kind: 'publish', dedupeKey: 'a', payload: { title: '甲' }, batchId: 'b1' })
  clock.set(1_001)
  const b = queue.enqueue({ kind: 'publish', dedupeKey: 'b', payload: { title: '乙' }, batchId: 'b1' })
  clock.set(1_002)
  const c = queue.enqueue({ kind: 'publish', dedupeKey: 'c', payload: { title: '丙' }, batchId: 'b1' })
  // 一个 done、一个 failed、一个 queued：计数必须各就各位
  clock.set(1_003)
  queue.lease({ owner: OWNER, limit: 1, ttlMs: 1_000, now: 1_003 })
  queue.ack(a.id, OWNER)
  clock.set(1_004)
  queue.lease({ owner: OWNER, limit: 1, ttlMs: 1_000, now: 1_004 })
  queue.fail(b.id, OWNER, new Error('类目不支持'), { nonRetryable: true })

  const stats = queue.batchStats('b1')
  assert.equal(stats.batchId, 'b1')
  assert.equal(stats.total, 3)
  assert.deepEqual(stats.counts, { queued: 1, leased: 0, done: 1, failed: 1, needs_review: 0 })
  assert.deepEqual(stats.items.map((task) => task.id), [a.id, b.id, c.id])
  assert.deepEqual(stats.items.map((task) => task.state), ['done', 'failed', 'queued'])
  assert.equal(c.batchId, 'b1')
})

test('batchStats：空批次全零；明细上限 200 但 total 不受限', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, clock.now)
  const empty = queue.batchStats('nothing-here')
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.counts, { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 })
  assert.deepEqual(empty.items, [])

  for (let index = 0; index < 201; index += 1) {
    queue.enqueue({ kind: 'probe', dedupeKey: `cap-${index}`, payload: { index }, batchId: 'cap' })
  }
  const capped = queue.batchStats('cap')
  assert.equal(capped.total, 201)
  assert.equal(capped.counts.queued, 201)
  assert.equal(capped.items.length, 200)
  assert.equal(capped.items[0]?.dedupeKey, 'cap-0')
  assert.equal(capped.items[199]?.dedupeKey, 'cap-199')
})

test('原 enqueue() 行为不变：仍只返回 TaskRecord，dedupeKey 命中返回既有任务', (t) => {
  const clock = fakeClock(1_000)
  const { queue } = setup(t, clock.now)
  const task = queue.enqueue({ kind: 'deliver', dedupeKey: 'd-1', payload: { orderId: 'o1' } })
  assert.equal('batchId' in task, false)
  const again = queue.enqueue({ kind: 'deliver', dedupeKey: 'd-1', payload: { orderId: 'o2' } })
  assert.deepEqual(again, task)
  assert.equal(queue.stats().queued, 1)
})
