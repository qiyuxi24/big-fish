/**
 * 幂等任务队列（SQLite 持久化）。
 *
 * 为什么要有租约：daemon 崩溃后，leased 任务在 lease_until 过期后可被别的 owner 回收；
 * 但「发布」这类写操作不能盲目重放（AGENTS 架构不变量 2），所以 attempts 用尽的任务
 * 进 needs_review 交给人看，而不是继续重试。
 * @module @bigfish/core/queue
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { XianyuError, fail } from './errors.ts'
import { asSqlRow, decodePayload, encodePayload, openStore, readSqlNumber, readSqlOptionalNumber, readSqlOptionalText, readSqlText, withTransaction } from './store.ts'
import type { SqlRow, Store } from './store.ts'
import type { EnqueueInput, FailTaskOptions, LeaseOptions, TaskFilter, TaskKind, TaskQueue, TaskRecord, TaskState } from './types.ts'

/** 任务种类白名单，与 tasks 表的 CHECK 约束一致。 */
export const TASK_KINDS: readonly TaskKind[] = ['publish', 'deliver', 'polish', 'reply', 'probe']

/** 任务状态白名单，与 tasks 表的 CHECK 约束一致。 */
export const TASK_STATES: readonly TaskState[] = ['queued', 'leased', 'done', 'failed', 'needs_review']

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 500
const MAX_LAST_ERROR_CHARS = 500

/** 队列构造参数：path 与 store 至少给一个。 */
export interface TaskQueueOptions {
  /** 数据库文件路径；队列自己打开并负责关闭。 */
  path?: string
  /** 复用已打开的 store（一个进程只开一个连接时用）。 */
  store?: Store
  /** 注入时钟（整数毫秒）；测试用假时钟。 */
  now?: () => number
  /** 注入 id 生成器；测试可预测 id。 */
  idFactory?: () => string
}

/** 实际返回的队列句柄：TaskQueue 的超集，fail 的附加选项见 types.ts 的 FailTaskOptions。 */
export interface TaskQueueHandle extends TaskQueue {
  fail(id: string, owner: string, error: string | Error, options?: FailTaskOptions): void
}

/** 建队列；path 与 store 都不给 → VALIDATION。 */
export function createTaskQueue(options: TaskQueueOptions): TaskQueueHandle {
  const ctx = createContext(options)
  return {
    enqueue: (input: EnqueueInput): TaskRecord => enqueueTask(ctx, input),
    lease: (leaseOptions: LeaseOptions): TaskRecord[] => leaseTasks(ctx, leaseOptions),
    ack: (id: string, owner: string): void => ackTask(ctx, id, owner),
    fail: (id: string, owner: string, error: string | Error, failOptions?: FailTaskOptions): void => {
      failTask(ctx, id, owner, error, failOptions)
    },
    release: (id: string, owner: string): void => releaseTask(ctx, id, owner),
    get: (id: string): TaskRecord | undefined => getTask(ctx, id),
    list: (filter?: TaskFilter): TaskRecord[] => listTasks(ctx, filter),
    stats: (): Record<TaskState, number> => taskStats(ctx),
    close: (): void => closeQueue(ctx),
  }
}

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (TASK_KINDS as readonly string[]).includes(value)
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value)
}

interface QueueContext {
  store: Store
  db: DatabaseSync
  sql: QueueStatements
  now: () => number
  newId: () => string
  closed: boolean
}

type Statement = ReturnType<DatabaseSync['prepare']>

interface QueueStatements {
  insertTask: Statement
  selectById: Statement
  selectByDedupe: Statement
  selectClaimable: Statement
  leaseTask: Statement
  markDone: Statement
  markFailed: Statement
  markQueued: Statement
  listAll: Statement
  listByState: Statement
  listByKind: Statement
  listByStateKind: Statement
  countByState: Statement
}

const TASK_COLUMNS =
  'id, kind, dedupe_key, payload, state, attempts, max_attempts, lease_owner, lease_until, available_at, last_error, created_at, updated_at'

const LIST_ORDER = 'ORDER BY created_at ASC, rowid ASC'

const SQL_TEXT = {
  insertTask: `INSERT INTO tasks (${TASK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  listAll: `SELECT ${TASK_COLUMNS} FROM tasks ${LIST_ORDER} LIMIT ?`,
  listByState: `SELECT ${TASK_COLUMNS} FROM tasks WHERE state = ? ${LIST_ORDER} LIMIT ?`,
  listByKind: `SELECT ${TASK_COLUMNS} FROM tasks WHERE kind = ? ${LIST_ORDER} LIMIT ?`,
  listByStateKind: `SELECT ${TASK_COLUMNS} FROM tasks WHERE state = ? AND kind = ? ${LIST_ORDER} LIMIT ?`,
  countByState: 'SELECT state, COUNT(*) AS total FROM tasks GROUP BY state',
} as const

function prepareStatements(db: DatabaseSync): QueueStatements {
  return {
    insertTask: db.prepare(SQL_TEXT.insertTask),
    selectById: db.prepare(SQL_TEXT.selectById),
    selectByDedupe: db.prepare(SQL_TEXT.selectByDedupe),
    selectClaimable: db.prepare(SQL_TEXT.selectClaimable),
    leaseTask: db.prepare(SQL_TEXT.leaseTask),
    markDone: db.prepare(SQL_TEXT.markDone),
    markFailed: db.prepare(SQL_TEXT.markFailed),
    markQueued: db.prepare(SQL_TEXT.markQueued),
    listAll: db.prepare(SQL_TEXT.listAll),
    listByState: db.prepare(SQL_TEXT.listByState),
    listByKind: db.prepare(SQL_TEXT.listByKind),
    listByStateKind: db.prepare(SQL_TEXT.listByStateKind),
    countByState: db.prepare(SQL_TEXT.countByState),
  }
}

function createContext(options: TaskQueueOptions): QueueContext {
  if (typeof options !== 'object' || options === null) fail('VALIDATION', 'createTaskQueue 需要参数对象')
  const now = options.now ?? ((): number => Date.now())
  const newId = options.idFactory ?? ((): string => randomUUID())
  const store = resolveStore(options, now)
  return { store, db: store.db, sql: prepareStatements(store.db), now, newId, closed: false }
}

function resolveStore(options: TaskQueueOptions, now: () => number): Store {
  if (options.store !== undefined) return options.store
  const path = options.path
  if (path === undefined || path.trim().length === 0) {
    fail('VALIDATION', 'createTaskQueue 需要非空 path 或已打开的 store')
  }
  return openStore({ path, now })
}

function enqueueTask(ctx: QueueContext, input: EnqueueInput): TaskRecord {
  assertOpen(ctx)
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'enqueue 需要入参对象')
  const kind = assertKind(input.kind)
  const dedupeKey = assertText(input.dedupeKey, 'dedupeKey')
  const payloadText = encodePayload(input.payload)
  const maxAttempts =
    input.maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : assertPositiveInt(input.maxAttempts, 'maxAttempts')
  const at = ctx.now()
  const availableAt = input.availableAt === undefined ? at : assertTimestamp(input.availableAt, 'availableAt')
  const id = assertText(ctx.newId(), 'idFactory 返回值')
  return withTransaction(ctx.db, () => {
    // ON CONFLICT DO NOTHING：dedupeKey 命中时既不新建、也不重置既有记录的 attempts/状态。
    ctx.sql.insertTask.run(id, kind, dedupeKey, payloadText, 'queued', 0, maxAttempts, null, null, availableAt, null, at, at)
    return toTaskRecord(ctx.sql.selectByDedupe.get(dedupeKey))
  })
}

function leaseTasks(ctx: QueueContext, options: LeaseOptions): TaskRecord[] {
  assertOpen(ctx)
  if (typeof options !== 'object' || options === null) fail('VALIDATION', 'lease 需要入参对象')
  const owner = assertText(options.owner, 'owner')
  const limit = assertPositiveInt(options.limit, 'limit')
  const ttlMs = assertPositiveInt(options.ttlMs, 'ttlMs')
  const at = options.now === undefined ? ctx.now() : assertTimestamp(options.now, 'now')
  const leaseUntil = at + ttlMs
  return withTransaction(ctx.db, () => {
    const rows = ctx.sql.selectClaimable.all(at, at, limit)
    const claimed: TaskRecord[] = []
    for (const raw of rows) {
      const row = asSqlRow(raw)
      if (row === undefined) continue
      const id = readSqlText(row, 'id')
      ctx.sql.leaseTask.run(owner, leaseUntil, at, id)
      claimed.push(toTaskRecord(ctx.sql.selectById.get(id)))
    }
    return claimed
  })
}

function ackTask(ctx: QueueContext, id: string, owner: string): void {
  assertOpen(ctx)
  const task = requireLease(ctx, id, owner, 'ack')
  ctx.sql.markDone.run(ctx.now(), task.id)
}

function releaseTask(ctx: QueueContext, id: string, owner: string): void {
  assertOpen(ctx)
  const task = requireLease(ctx, id, owner, 'release')
  const at = ctx.now()
  ctx.sql.markQueued.run(at, at, task.id) // 回到队首：available_at = now，attempts 不变
}

function failTask(ctx: QueueContext, id: string, owner: string, error: string | Error, options?: FailTaskOptions): void {
  assertOpen(ctx)
  const task = requireLease(ctx, id, owner, 'fail')
  const at = ctx.now()
  const lastError = errorMessage(error).slice(0, MAX_LAST_ERROR_CHARS)
  const retryAfterMs = readRetryAfterMs(options)
  // 判定顺序：明确不可重试 → failed；次数用尽 → needs_review（写操作交给人看，不自动重放）。
  const state: TaskState = options?.nonRetryable === true ? 'failed' : task.attempts >= task.maxAttempts ? 'needs_review' : 'queued'
  // 风控冷却只能推迟重试：与指数退避取较大者，避免「60s 退避」把 10 分钟冷却提前打穿。
  const delay = retryAfterMs === undefined ? backoffMs(task.attempts) : Math.max(backoffMs(task.attempts), retryAfterMs)
  // retryAfterMs 允许小数，但落库时间必须是整数毫秒，向上取整保证不会早于冷却截止。
  const availableAt = state === 'queued' ? at + Math.ceil(delay) : task.availableAt
  ctx.sql.markFailed.run(state, availableAt, lastError, at, task.id)
}

/** retryAfterMs 校验：有限非负数（毫秒）；非法入参一律 VALIDATION，且不改动任务。 */
function readRetryAfterMs(options: FailTaskOptions | undefined): number | undefined {
  const value: unknown = options?.retryAfterMs
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('VALIDATION', 'retryAfterMs 必须是有限非负数（毫秒）')
  }
  return value
}

function getTask(ctx: QueueContext, id: string): TaskRecord | undefined {
  assertOpen(ctx)
  const raw = ctx.sql.selectById.get(assertText(id, 'id'))
  return raw === undefined ? undefined : toTaskRecord(raw)
}

function listTasks(ctx: QueueContext, filter?: TaskFilter): TaskRecord[] {
  assertOpen(ctx)
  const state = filter?.state === undefined ? undefined : assertState(filter.state)
  const kind = filter?.kind === undefined ? undefined : assertKind(filter.kind)
  const limit = filter?.limit === undefined ? DEFAULT_LIST_LIMIT : Math.min(assertPositiveInt(filter.limit, 'limit'), MAX_LIST_LIMIT)
  const statement = pickListStatement(ctx.sql, state !== undefined, kind !== undefined)
  const params: (string | number)[] = []
  if (state !== undefined) params.push(state)
  if (kind !== undefined) params.push(kind)
  params.push(limit)
  return statement.all(...params).map((raw) => toTaskRecord(raw))
}

function taskStats(ctx: QueueContext): Record<TaskState, number> {
  assertOpen(ctx)
  const stats: Record<TaskState, number> = { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 }
  for (const raw of ctx.sql.countByState.all()) {
    const row = asSqlRow(raw)
    if (row === undefined) continue
    const state = readSqlText(row, 'state')
    if (isTaskState(state)) stats[state] = readSqlNumber(row, 'total')
  }
  return stats
}

function closeQueue(ctx: QueueContext): void {
  if (ctx.closed) return
  ctx.closed = true
  ctx.store.close()
}

function pickListStatement(sql: QueueStatements, hasState: boolean, hasKind: boolean): Statement {
  if (hasState && hasKind) return sql.listByStateKind
  if (hasState) return sql.listByState
  if (hasKind) return sql.listByKind
  return sql.listAll
}

function requireLease(ctx: QueueContext, id: string, owner: string, action: string): TaskRecord {
  const taskId = assertText(id, 'id')
  const leaseOwner = assertText(owner, 'owner')
  const task = getTask(ctx, taskId)
  if (task === undefined) fail('VALIDATION', `${action}：任务不存在（id=${taskId}）`)
  if (task.state !== 'leased' || task.leaseOwner !== leaseOwner) {
    fail('VALIDATION', `${action}：任务 ${taskId} 未被 ${leaseOwner} 持有（state=${task.state}）`)
  }
  return task
}

function toTaskRecord(raw: unknown): TaskRecord {
  const row = asSqlRow(raw)
  if (row === undefined) fail('STORAGE', '任务记录不存在')
  const id = readSqlText(row, 'id')
  const leaseOwner = readSqlOptionalText(row, 'lease_owner')
  const leaseUntil = readSqlOptionalNumber(row, 'lease_until')
  const lastError = readSqlOptionalText(row, 'last_error')
  return {
    id,
    kind: requireKind(readSqlText(row, 'kind')),
    dedupeKey: readSqlText(row, 'dedupe_key'),
    payload: decodePayload(row['payload'], id),
    state: requireState(readSqlText(row, 'state')),
    attempts: readSqlNumber(row, 'attempts'),
    maxAttempts: readSqlNumber(row, 'max_attempts'),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseUntil === undefined ? {} : { leaseUntil }),
    availableAt: readSqlNumber(row, 'available_at'),
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: readSqlNumber(row, 'created_at'),
    updatedAt: readSqlNumber(row, 'updated_at'),
  }
}

function requireKind(value: string): TaskKind {
  if (isTaskKind(value)) return value
  fail('STORAGE', `tasks.kind 非法：${value}`)
}

function requireState(value: string): TaskState {
  if (isTaskState(value)) return value
  fail('STORAGE', `tasks.state 非法：${value}`)
}

/** AGENTS 硬规则：退避 = min(60 * 2^(attempts-1), 1800) 秒；attempts 从 1 起算。 */
function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(60 * 2 ** exponent, 1800) * 1000
}

function errorMessage(error: string | Error): string {
  if (typeof error === 'string') return error.length === 0 ? '未知错误' : error
  if (error instanceof Error) return error.message.length === 0 ? error.name : error.message
  fail('VALIDATION', 'fail() 的 error 必须是字符串或 Error')
}

function assertOpen(ctx: QueueContext): void {
  if (ctx.closed) fail('STORAGE', '任务队列已关闭')
}

function assertKind(value: unknown): TaskKind {
  if (isTaskKind(value)) return value
  fail('VALIDATION', `kind 非法：${String(value)}`)
}

function assertState(value: unknown): TaskState {
  if (isTaskState(value)) return value
  fail('VALIDATION', `state 非法：${String(value)}`)
}

function assertText(value: unknown, field: string): string {
  if (typeof value !== 'string') fail('VALIDATION', `${field} 必须是字符串`)
  if (value.trim().length === 0) fail('VALIDATION', `${field} 不能为空`)
  return value
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('VALIDATION', `${field} 必须是正整数`)
  }
  return value
}

function assertTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('VALIDATION', `${field} 必须是非负整数毫秒`)
  }
  return value
}
