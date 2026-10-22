/**
 * task_events（core v3 迁移 + 事件读写）行为测试。
 * 表由 openStore 的迁移建；这里用真实 SQLite 临时库验证迁移、游标、过滤与入参校验。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
  createTaskEventStore,
  openStore,
} from '../src/data.ts'
import type { Store } from '../src/data.ts'
import { XianyuError } from '../src/errors.ts'

const ROOT = fileURLToPath(new URL('../../../.scratch/data-task-events/', import.meta.url))

interface Fixture {
  store: Store
  path: string
  /** 幂等关闭；清理钩子会在删目录前再调一次（Windows 上打开着的库文件删不掉）。 */
  close(): void
}

function makeStore(t: { after(fn: () => void): void }): Fixture {
  const dir = join(ROOT, randomUUID())
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'bigfish.db')
  const store = openStore({ path })
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    store.close()
  }
  t.after(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, path, close }
}

function expectCode(fn: () => void, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError，实际：' + String(error))
    assert.equal(error.code, code)
    return
  }
  assert.fail('期望抛 ' + code + '，但调用返回了')
}

describe('task_events（core）', () => {
  it('迁移建出 task_events 表并记版本 3', (t) => {
    const { store } = makeStore(t)
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_events'").all()
    assert.equal(Array.isArray(tables) ? tables.length : 0, 1)
    const versions = store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3])
  })

  it('append 返回递增 id 与注入时钟；list 按 id 升序', (t) => {
    const { store } = makeStore(t)
    let clock = 1_700_000_000_000
    const sink = createTaskEventStore(store, { now: () => (clock += 10) })
    const first = sink.append({ taskId: 't1', kind: 'task.state', state: 'queued' })
    const second = sink.append({ taskId: 't1', kind: 'task.step', step: '打开发布页', message: '开始', state: 'started' })
    assert.equal(second.id, first.id + 1)
    assert.ok(first.at < second.at)
    const list = sink.list()
    assert.deepEqual(list.map((row) => row.id), [first.id, second.id])
    assert.equal(list[1]?.step, '打开发布页')
    assert.equal(list[1]?.state, 'started')
  })

  it('since 是排他游标：只返回 id > since，没有新事件时返回空', (t) => {
    const { store } = makeStore(t)
    const sink = createTaskEventStore(store)
    const a = sink.append({ taskId: 't1', kind: 'task.state', state: 'queued' })
    const b = sink.append({ taskId: 't1', kind: 'task.state', state: 'done' })
    const after = sink.list({ since: a.id })
    assert.deepEqual(after.map((row) => row.id), [b.id])
    assert.deepEqual(sink.list({ since: b.id }), [])
  })

  it('按 taskId / batchId 过滤，且可以和 since 组合', (t) => {
    const { store } = makeStore(t)
    const sink = createTaskEventStore(store)
    const a = sink.append({ taskId: 't1', batchId: 'b1', kind: 'task.step', step: 's1', message: '开始' })
    const b = sink.append({ taskId: 't2', batchId: 'b1', kind: 'task.step', step: 's1', message: '开始' })
    sink.append({ taskId: 't3', batchId: 'b2', kind: 'task.step', step: 's1', message: '开始' })
    assert.deepEqual(sink.list({ taskId: 't1' }).map((row) => row.id), [a.id])
    assert.deepEqual(sink.list({ batchId: 'b1' }).map((row) => row.id), [a.id, b.id])
    assert.deepEqual(sink.list({ batchId: 'b1', since: a.id }).map((row) => row.id), [b.id])
  })

  it('limit 生效且超过上限拒绝', (t) => {
    const { store } = makeStore(t)
    const sink = createTaskEventStore(store)
    for (let index = 0; index < 3; index += 1) {
      sink.append({ taskId: 't1', kind: 'task.state', state: 'queued' })
    }
    assert.equal(sink.list({ limit: 2 }).length, 2)
    assert.equal(sink.list().length, 3)
    assert.ok(DEFAULT_EVENT_LIMIT >= 3)
    expectCode(() => sink.list({ limit: MAX_EVENT_LIMIT + 1 }), 'VALIDATION')
    expectCode(() => sink.list({ limit: 0 }), 'VALIDATION')
  })

  it('details 往返 JSON；step/state/code/message 可缺省', (t) => {
    const { store } = makeStore(t)
    const sink = createTaskEventStore(store)
    const event = sink.append({
      taskId: 't1',
      kind: 'task.step',
      step: '截图',
      message: '失败：类目不支持',
      state: 'failed',
      details: { shot: 'shots/1.png', attempt: 2 },
    })
    const [row] = sink.list()
    assert.deepEqual(row?.details, { shot: 'shots/1.png', attempt: 2 })
    assert.equal(row?.message, '失败：类目不支持')
    assert.equal(row?.id, event.id)
  })

  it('非法入参 → VALIDATION（kind / taskId / details）', (t) => {
    const { store } = makeStore(t)
    const sink = createTaskEventStore(store)
    expectCode(() => sink.append({ taskId: '', kind: 'task.state' }), 'VALIDATION')
    expectCode(() => sink.append({ taskId: 't1', kind: 'nope' as never }), 'VALIDATION')
    expectCode(() => sink.append({ taskId: 't1', kind: 'task.state', details: [] as never }), 'VALIDATION')
    assert.deepEqual(sink.list(), [])
  })

  it('重开同一个库：事件仍在（迁移幂等）', (t) => {
    const { store, path, close } = makeStore(t)
    const sink = createTaskEventStore(store)
    const event = sink.append({ taskId: 't1', kind: 'task.state', state: 'done' })
    close()
    const reopened = openStore({ path })
    try {
      const list = createTaskEventStore(reopened).list()
      assert.deepEqual(list.map((row) => row.id), [event.id])
    } finally {
      // 必须在用例体内关闭：清理钩子先于后面的 t.after 执行，Windows 上删不掉打开中的库文件
      reopened.close()
    }
  })
})
