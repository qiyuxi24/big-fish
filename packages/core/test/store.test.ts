/**
 * store.ts 的行为测试：迁移、WAL、幂等 close、跨重启持久化、非法路径。
 * 只通过公开出口（data.ts）使用实现；唯一直接读表的地方是迁移断言（schema_migrations）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BUSY_TIMEOUT_MS, createTaskQueue, openStore } from '../src/data.ts'
import type { Store } from '../src/data.ts'
import { XianyuError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'

const ROOT = fileURLToPath(new URL('../../../.scratch/data-queue-tests/store/', import.meta.url))

interface Sandbox {
  dir: string
  path(name: string): string
  /** 登记资源清理；统一在 after 里逆序关闭，最后才删目录（Windows 上打开中的文件删不掉）。 */
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

test('openStore 递归建目录、开 WAL/外键/busy_timeout，并按注入时钟记录 v1~v3 迁移', (t) => {
  const box = sandbox(t)
  const path = box.path('nested/deeper/core.db')
  const store = box.track(openStore({ path, now: () => 1_700_000_000_000 }), (value: Store) => value.close())
  assert.ok(existsSync(path))
  assert.equal(store.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal')
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get()?.timeout, DEFAULT_BUSY_TIMEOUT_MS)
  const versions = store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version))
  assert.deepEqual(versions, [1, 2, 3, 4])
  const appliedAt = store.db.prepare('SELECT applied_at FROM schema_migrations ORDER BY version').all().map((row) => Number(row.applied_at))
  assert.deepEqual(appliedAt, [1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000])
})

test('close 幂等：连续两次不抛错', (t) => {
  const box = sandbox(t)
  const store = openStore({ path: box.path('core.db') })
  assert.doesNotThrow(() => {
    store.close()
    store.close()
  })
})

test('重开同一文件：迁移不重复执行，队列状态跨重启保留', (t) => {
  const box = sandbox(t)
  const path = box.path('core.db')
  // 注入假时钟，保证 enqueue 的 available_at 与 lease 的 now 落在同一时间轴上
  const first = box.track(openStore({ path, now: () => 1_000 }), (value: Store) => value.close())
  const queue = box.track(createTaskQueue({ store: first, now: () => 1_000 }), (value) => value.close())
  const task = queue.enqueue({ kind: 'publish', dedupeKey: 'publish-1', payload: { title: '甲' } })
  const leased = queue.lease({ owner: 'daemon-a', limit: 1, ttlMs: 60_000, now: 1_000 })
  assert.equal(leased.length, 1)
  queue.close()
  first.close()

  const reopened = box.track(openStore({ path }), (value: Store) => value.close())
  const versions = reopened.db.prepare('SELECT version FROM schema_migrations').all().length
  assert.equal(versions, 4)
  const queue2 = box.track(createTaskQueue({ store: reopened }), (value) => value.close())
  const again = queue2.enqueue({ kind: 'publish', dedupeKey: 'publish-1', payload: { title: '乙' } })
  assert.equal(again.id, task.id)
  assert.equal(again.attempts, 1)
  assert.deepEqual(again.payload, { title: '甲' })
})

test(':memory: 也可用（无父目录，跳过长目录创建）', (t) => {
  const box = sandbox(t)
  const store = box.track(openStore({ path: ':memory:' }), (value: Store) => value.close())
  assert.equal(store.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'memory')
  const queue = box.track(createTaskQueue({ store }), (value) => value.close())
  const task = queue.enqueue({ kind: 'probe', dedupeKey: 'mem-1', payload: {} })
  assert.equal(queue.get(task.id)?.state, 'queued')
})

test('非法 path → VALIDATION；指向目录 → STORAGE', (t) => {
  const box = sandbox(t)
  expectCode('VALIDATION', () => openStore({ path: '   ' }))
  expectCode('VALIDATION', () => openStore({ path: 42 as unknown as string }))
  expectCode('STORAGE', () => openStore({ path: box.dir }))
})
