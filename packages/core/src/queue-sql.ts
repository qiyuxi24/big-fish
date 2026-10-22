/**
 * 队列 SQL 文本与预编译语句。
 *
 * 为什么单独成文件：这张语句表是「tasks 表 ↔ TaskRecord」的唯一映射点，纯声明、
 * 不含状态机逻辑；拆出来后 queue.ts 专注状态流转，也不会再顶到 400 行上限。
 * @module @bigfish/core/queue-sql
 */
import type { DatabaseSync } from 'node:sqlite'

/** node:sqlite 的预编译语句类型。 */
export type Statement = ReturnType<DatabaseSync['prepare']>

/** 队列用到的全部预编译语句；字段名与操作一一对应。 */
export interface QueueStatements {
  insertTask: Statement
  selectById: Statement
  selectByDedupe: Statement
  selectClaimable: Statement
  leaseTask: Statement
  markDone: Statement
  markFailed: Statement
  markQueued: Statement
  markRequeued: Statement
  listAll: Statement
  listByState: Statement
  listByKind: Statement
  listByStateKind: Statement
  countByState: Statement
  selectByBatch: Statement
  countByBatch: Statement
}

/**
 * SELECT 列清单：TaskRecord 的每个字段都从这里读，改表结构必须同步。
 * batch_id 排在最后——V2 迁移是 ALTER TABLE ADD COLUMN，列顺序天然在末尾。
 */
export const TASK_COLUMNS =
  'id, kind, dedupe_key, payload, state, attempts, max_attempts, lease_owner, lease_until, available_at, last_error, created_at, updated_at, batch_id'

const LIST_ORDER = 'ORDER BY created_at ASC, rowid ASC'

/** 列顺序即 insertTask 的占位符顺序：14 列 → 14 个 ?。 */
export const SQL_TEXT = {
  insertTask: `INSERT INTO tasks (${TASK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING`,
  selectById: `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`,
  selectByDedupe: `SELECT ${TASK_COLUMNS} FROM tasks WHERE dedupe_key = ?`,
  // 可领取 = 到期的 queued，或租约已过期（owner 崩溃）的 leased。
  selectClaimable: `SELECT ${TASK_COLUMNS} FROM tasks
    WHERE (state = 'queued' AND available_at <= ?)
       OR (state = 'leased' AND lease_until IS NOT NULL AND lease_until <= ?)
    ORDER BY available_at ASC, created_at ASC, rowid ASC
    LIMIT ?`,
  leaseTask: `UPDATE tasks SET state = 'leased', lease_owner = ?, lease_until = ?,
    attempts = attempts + 1, updated_at = ? WHERE id = ?`,
  markDone: `UPDATE tasks SET state = 'done', lease_owner = NULL, lease_until = NULL,
    updated_at = ? WHERE id = ?`,
  markFailed: `UPDATE tasks SET state = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
    last_error = ?, updated_at = ? WHERE id = ?`,
  markQueued: `UPDATE tasks SET state = 'queued', available_at = ?, lease_owner = NULL, lease_until = NULL,
    updated_at = ? WHERE id = ?`,
  // 与 markQueued 的差别：attempts 归零 + 清 last_error，语义是「人工重获完整重试预算」。
  markRequeued: `UPDATE tasks SET state = 'queued', attempts = 0, available_at = ?, lease_owner = NULL,
    lease_until = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
  listAll: `SELECT ${TASK_COLUMNS} FROM tasks ${LIST_ORDER} LIMIT ?`,
  listByState: `SELECT ${TASK_COLUMNS} FROM tasks WHERE state = ? ${LIST_ORDER} LIMIT ?`,
  listByKind: `SELECT ${TASK_COLUMNS} FROM tasks WHERE kind = ? ${LIST_ORDER} LIMIT ?`,
  listByStateKind: `SELECT ${TASK_COLUMNS} FROM tasks WHERE state = ? AND kind = ? ${LIST_ORDER} LIMIT ?`,
  countByState: 'SELECT state, COUNT(*) AS total FROM tasks GROUP BY state',
  // 批次视图：明细按入队顺序（created_at 相同则按 rowid），最多 200 条由调用方 LIMIT。
  selectByBatch: `SELECT ${TASK_COLUMNS} FROM tasks WHERE batch_id = ? ${LIST_ORDER} LIMIT ?`,
  countByBatch: 'SELECT state, COUNT(*) AS total FROM tasks WHERE batch_id = ? GROUP BY state',
} as const

export function prepareStatements(db: DatabaseSync): QueueStatements {
  return {
    insertTask: db.prepare(SQL_TEXT.insertTask),
    selectById: db.prepare(SQL_TEXT.selectById),
    selectByDedupe: db.prepare(SQL_TEXT.selectByDedupe),
    selectClaimable: db.prepare(SQL_TEXT.selectClaimable),
    leaseTask: db.prepare(SQL_TEXT.leaseTask),
    markDone: db.prepare(SQL_TEXT.markDone),
    markFailed: db.prepare(SQL_TEXT.markFailed),
    markQueued: db.prepare(SQL_TEXT.markQueued),
    markRequeued: db.prepare(SQL_TEXT.markRequeued),
    listAll: db.prepare(SQL_TEXT.listAll),
    listByState: db.prepare(SQL_TEXT.listByState),
    listByKind: db.prepare(SQL_TEXT.listByKind),
    listByStateKind: db.prepare(SQL_TEXT.listByStateKind),
    countByState: db.prepare(SQL_TEXT.countByState),
    selectByBatch: db.prepare(SQL_TEXT.selectByBatch),
    countByBatch: db.prepare(SQL_TEXT.countByBatch),
  }
}

/** list/filter 组合 → 对应语句；四种组合都预编译好，避免运行时拼 SQL。 */
export function pickListStatement(sql: QueueStatements, hasState: boolean, hasKind: boolean): Statement {
  if (hasState && hasKind) return sql.listByStateKind
  if (hasState) return sql.listByState
  if (hasKind) return sql.listByKind
  return sql.listAll
}
