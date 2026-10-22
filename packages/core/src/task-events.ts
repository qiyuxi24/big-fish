/**
 * 任务事件流：任务状态迁移 + 通道步骤的 append-only 记录。
 *
 * 为什么单独一张表：面板工作流树和「daemon 出问题要主动唤醒 DSH」都需要「任务现在走到哪一步」
 * 的增量流；把步骤事件写进 tasks 的 JSON 字段会让每次轮询读整行、也没法按 since 游标拉取。
 * 事件只增不改、只由 worker 与执行器写，读侧（GET /events）按 id 游标增量拉取。
 * @module @bigfish/core/task-events
 */
import { fail, toXianyuError } from './errors.ts'
import {
  asSqlRow,
  decodePayload,
  encodePayload,
  readSqlNumber,
  readSqlOptionalText,
  readSqlText,
} from './store.ts'
import type { Store } from './store.ts'

/** 事件种类：task.state = 队列状态迁移（done/failed/needs_review/queued），task.step = 通道步骤。 */
export type TaskEventKind = 'task.state' | 'task.step'

const EVENT_KINDS = new Set<string>(['task.state', 'task.step'])

/** 写入一条事件；taskId 与 kind 必填，其余按种类取。 */
export interface TaskEventInput {
  taskId: string
  kind: TaskEventKind
  /** 批次 id；面板按批次过滤工作流树时用。 */
  batchId?: string
  /** 通道步骤名（如「打开发布页」「填标题」）；task.step 事件必填。 */
  step?: string
  /** 步骤状态启发式：started / done / failed；task.state 事件里是队列状态。 */
  state?: string
  /** 失败码（与 XianyuError.code 同值域）；只在失败事件里出现。 */
  code?: string
  /** 人读消息；已由调用方脱敏（daemon 输出还会再走 redact 一道）。 */
  message?: string
  /** 结构化附加信息（如截图路径）；必须是普通对象。 */
  details?: Record<string, unknown>
}

/** 读出的事件；id 是全局递增游标（GET /events?since= 用它）。 */
export interface TaskEventRecord {
  id: number
  at: number
  taskId: string
  batchId?: string
  kind: TaskEventKind
  step?: string
  state?: string
  code?: string
  message?: string
  details?: Record<string, unknown>
}

/** 读侧过滤条件：since 是排他游标（返回 id > since）。 */
export interface TaskEventQuery {
  since?: number
  limit?: number
  taskId?: string
  batchId?: string
}

export interface TaskEventSink {
  append(input: TaskEventInput): TaskEventRecord
  list(query?: TaskEventQuery): TaskEventRecord[]
}

/** 面板一次轮询的默认批量；上限防止一次拉空整张表。 */
export const DEFAULT_EVENT_LIMIT = 200
export const MAX_EVENT_LIMIT = 1000

export interface TaskEventStoreOptions {
  /** 可注入时钟（整数毫秒）。 */
  now?: () => number
}

/** 建事件读写口；表由 openStore 的 v3 迁移保证存在。 */
export function createTaskEventStore(store: Store, options: TaskEventStoreOptions = {}): TaskEventSink {
  if (typeof store !== 'object' || store === null) fail('VALIDATION', 'createTaskEventStore 需要 store')
  const clock = options.now ?? ((): number => Date.now())
  return {
    append(input: TaskEventInput): TaskEventRecord {
      return appendEvent(store, clock, input)
    },
    list(query: TaskEventQuery = {}): TaskEventRecord[] {
      return listEvents(store, query)
    },
  }
}

function appendEvent(store: Store, now: () => number, input: TaskEventInput): TaskEventRecord {
  const event = normalizeInput(input)
  const at = now()
  try {
    const result: unknown = store.db
      .prepare(
        `INSERT INTO task_events (at, task_id, batch_id, kind, step, state, code, message, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        event.taskId,
        event.batchId ?? null,
        event.kind,
        event.step ?? null,
        event.state ?? null,
        event.code ?? null,
        event.message ?? null,
        event.details === undefined ? null : encodePayload(event.details),
      )
    return { id: readInsertId(result), at, ...event }
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

function listEvents(store: Store, query: TaskEventQuery): TaskEventRecord[] {
  const since = query.since === undefined ? 0 : requireNonNegativeInt(query.since, 'since')
  const limit = query.limit === undefined ? DEFAULT_EVENT_LIMIT : requireEventLimit(query.limit)
  const taskId = optionalNonEmptyString(query.taskId, 'taskId')
  const batchId = optionalNonEmptyString(query.batchId, 'batchId')
  const where: string[] = ['id > ?']
  const params: Array<string | number> = [since]
  if (taskId !== undefined) {
    where.push('task_id = ?')
    params.push(taskId)
  }
  if (batchId !== undefined) {
    where.push('batch_id = ?')
    params.push(batchId)
  }
  params.push(limit)
  try {
    const rows: unknown = store.db
      .prepare(
        `SELECT id, at, task_id, batch_id, kind, step, state, code, message, details
         FROM task_events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`,
      )
      .all(...params)
    if (!Array.isArray(rows)) return []
    const records: TaskEventRecord[] = []
    for (const raw of rows) {
      const record = readEventRow(raw)
      if (record !== undefined) records.push(record)
    }
    return records
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

function readEventRow(raw: unknown): TaskEventRecord | undefined {
  const row = asSqlRow(raw)
  if (row === undefined) return undefined
  const kind = readSqlText(row, 'kind')
  if (!EVENT_KINDS.has(kind)) return undefined
  const detailsText = readSqlOptionalText(row, 'details')
  const step = readSqlOptionalText(row, 'step')
  const batchId = readSqlOptionalText(row, 'batch_id')
  const state = readSqlOptionalText(row, 'state')
  const code = readSqlOptionalText(row, 'code')
  const message = readSqlOptionalText(row, 'message')
  return {
    id: readSqlNumber(row, 'id'),
    at: readSqlNumber(row, 'at'),
    taskId: readSqlText(row, 'task_id'),
    kind: kind as TaskEventKind,
    ...(batchId === undefined ? {} : { batchId }),
    ...(step === undefined ? {} : { step }),
    ...(state === undefined ? {} : { state }),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(detailsText === undefined ? {} : { details: decodePayload(detailsText) }),
  }
}

function normalizeInput(input: TaskEventInput): TaskEventInput {
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'task event 需要参数对象')
  const taskId = requireNonEmptyString(input.taskId, 'taskId')
  const kind = input.kind
  if (typeof kind !== 'string' || !EVENT_KINDS.has(kind)) {
    fail('VALIDATION', 'task event kind 非法：' + String(kind))
  }
  const batchId = optionalNonEmptyString(input.batchId, 'batchId')
  const step = optionalNonEmptyString(input.step, 'step')
  const state = optionalNonEmptyString(input.state, 'state')
  const code = optionalNonEmptyString(input.code, 'code')
  const message = optionalNonEmptyString(input.message, 'message')
  const details = input.details
  if (details !== undefined && (typeof details !== 'object' || details === null || Array.isArray(details))) {
    fail('VALIDATION', 'task event details 必须是普通对象')
  }
  return {
    taskId,
    kind: kind as TaskEventKind,
    ...(batchId === undefined ? {} : { batchId }),
    ...(step === undefined ? {} : { step }),
    ...(state === undefined ? {} : { state }),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(details === undefined ? {} : { details }),
  }
}

function readInsertId(result: unknown): number {
  const row = asSqlRow(result)
  const value = row?.['lastInsertRowid']
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint') return Number(value)
  fail('STORAGE', 'SQLite 未返回自增事件 id')
}

function requireEventLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EVENT_LIMIT) {
    fail('VALIDATION', 'task event limit 必须在 1..' + String(MAX_EVENT_LIMIT) + ' 之间，实际为 ' + String(value))
  }
  return value
}

function requireNonNegativeInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('VALIDATION', 'task event ' + name + ' 必须是非负整数，实际为 ' + String(value))
  }
  return value
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('VALIDATION', 'task event ' + name + ' 必须是非空字符串')
  }
  return value
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requireNonEmptyString(value, name)
}
