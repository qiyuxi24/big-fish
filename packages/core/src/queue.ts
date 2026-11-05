/**
 * 幂等任务队列（SQLite 持久化）。
 *
 * 为什么要有租约：daemon 崩溃后，leased 任务在 lease_until 过期后可被别的 owner 回收；
 * 但「发布」这类写操作不能盲目重放（AGENTS 架构不变量 2），所以 attempts 用尽的任务
 * 进 needs_review 交给人看，而不是继续重试。
 *
 * 人工收尾：failed / needs_review 可经 requeue 回到 queued，attempts 归零（重获完整重试预算），
 * 这是救回「dedupeKey 已占用且已停下」任务的唯一通道。
 *
 * 批次：tasks.batch_id 只是归属标记，让「一次批量发布跑到哪了」可被 batchStats 观察；
 * 它不引入新的状态机——批次里的任务仍然各自调度、各自重试、各自失败。
 * @module @bigfish/core/queue
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { fail } from './errors.ts'
import {
  assertBatchId,
  assertKind,
  assertPositiveInt,
  assertState,
  assertText,
  assertTimestamp,
  backoffMs,
  emptyStateCounts,
  errorMessage,
  requireKind,
  requireState,
} from './queue-guards.ts'
import { pickListStatement, prepareStatements } from './queue-sql.ts'
import type { QueueStatements } from './queue-sql.ts'
import { asSqlRow, decodePayload, encodePayload, openStore, readSqlNumber, readSqlOptionalNumber, readSqlOptionalText, readSqlText, withTransaction } from './store.ts'
import type { Store } from './store.ts'
import type { BatchStats, EnqueueInput, EnqueueReceipt, FailTaskOptions, LeaseOptions, TaskFilter, TaskQueue, TaskRecord, TaskState } from './types.ts'

// 值域白名单与断言搬到了 queue-guards.ts；这里转出以保持既有 import 路径可用。
export { TASK_KINDS, TASK_STATES, isTaskKind, isTaskState } from './queue-guards.ts'

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 500
const MAX_LAST_ERROR_CHARS = 500

/** 单次 batchStats 最多回 200 条明细：批次只用于观察，不是分页接口。 */
export const MAX_BATCH_ITEMS = 200

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

/** requeue 入参：availableAt 把任务压到未来某刻才可领取（整数毫秒，缺省 = 现在）。 */
export interface RequeueOptions { availableAt?: number }

/** 实际返回的队列句柄：TaskQueue 的超集，fail 的附加选项见 types.ts 的 FailTaskOptions。 */
export interface TaskQueueHandle extends TaskQueue {
  fail(id: string, owner: string, error: string | Error, options?: FailTaskOptions): void
  requeue(id: string, options?: RequeueOptions): TaskRecord
  /** 入队并告知是否新建；created=false 表示 dedupeKey 命中已有任务（不重置 attempts/状态）。 */
  enqueueWithReceipt(input: EnqueueInput): EnqueueReceipt
  /** 一批任务的聚合视图；明细按 created_at 升序，最多 MAX_BATCH_ITEMS 条。 */
  batchStats(batchId: string): BatchStats
}

/** 建队列；path 与 store 都不给 → VALIDATION。 */
export function createTaskQueue(options: TaskQueueOptions): TaskQueueHandle {
  const ctx = createContext(options)
  return {
    enqueue: (input: EnqueueInput): TaskRecord => enqueueTask(ctx, input),
    enqueueWithReceipt: (input: EnqueueInput): EnqueueReceipt => enqueueWithReceipt(ctx, input),
    lease: (leaseOptions: LeaseOptions): TaskRecord[] => leaseTasks(ctx, leaseOptions),
    ack: (id: string, owner: string): void => ackTask(ctx, id, owner),
    fail: (id: string, owner: string, error: string | Error, failOptions?: FailTaskOptions): void => {
      failTask(ctx, id, owner, error, failOptions)
    },
    release: (id: string, owner: string): void => releaseTask(ctx, id, owner),
    requeue: (id: string, requeueOptions?: RequeueOptions): TaskRecord => requeueTask(ctx, id, requeueOptions),
    get: (id: string): TaskRecord | undefined => getTask(ctx, id),
    list: (filter?: TaskFilter): TaskRecord[] => listTasks(ctx, filter),
    batchStats: (batchId: string): BatchStats => batchStatsOf(ctx, batchId),
    stats: (): Record<TaskState, number> => taskStats(ctx),
    close: (): void => closeQueue(ctx),
  }
}

interface QueueContext {
  store: Store
  db: DatabaseSync
  sql: QueueStatements
  now: () => number
  newId: () => string
  closed: boolean
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
  return enqueueWithReceipt(ctx, input).task
}

/**
 * 入队并区分「新建」与「dedupeKey 命中」。
 * 拆出 receipt 是为了让 HTTP/面板能回答「这批实际排进去几条」：命中已有任务时既不能
 * 假装成功（批量数量会虚高），也不能报错（重放同一批是幂等语义）。
 */
function enqueueWithReceipt(ctx: QueueContext, input: EnqueueInput): EnqueueReceipt {
  assertOpen(ctx)
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'enqueue 需要入参对象')
  const kind = assertKind(input.kind)
  const dedupeKey = assertText(input.dedupeKey, 'dedupeKey')
  const payloadText = encodePayload(input.payload)
  // undefined = 不属于任何批次（单件任务）；空串之类的非法值必须报错，不能悄悄当单件。
  const batchId = input.batchId === undefined ? undefined : assertBatchId(input.batchId)
  const maxAttempts =
    input.maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : assertPositiveInt(input.maxAttempts, 'maxAttempts')
  const at = ctx.now()
  const availableAt = input.availableAt === undefined ? at : assertTimestamp(input.availableAt, 'availableAt')
  const id = assertText(ctx.newId(), 'idFactory 返回值')
  return withTransaction(ctx.db, () => {
    // ON CONFLICT DO NOTHING：dedupeKey 命中时既不新建、也不重置既有记录的 attempts/状态。
    // 因此 changes=0 就是「这条已经入过队」的可靠信号，不用再比时间戳。
    const result = ctx.sql.insertTask.run(
      id, kind, dedupeKey, payloadText, 'queued', 0, maxAttempts, null, null, availableAt, null, at, at, batchId ?? null,
    )
    return { task: toTaskRecord(ctx.sql.selectByDedupe.get(dedupeKey)), created: Number(result.changes) > 0 }
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

/** 人工收尾：只收容已停下的任务（failed / needs_review），把重试预算还给用户。 */
function requeueTask(ctx: QueueContext, id: string, options?: RequeueOptions): TaskRecord {
  assertOpen(ctx)
  const taskId = assertText(id, 'id')
  if (options !== undefined && (typeof options !== 'object' || options === null)) fail('VALIDATION', 'requeue 的 options 必须是对象')
  const at = ctx.now()
  const availableAt = options?.availableAt === undefined ? at : assertTimestamp(options.availableAt, 'availableAt')
  return withTransaction(ctx.db, () => {
    const task = getTask(ctx, taskId)
    if (task === undefined) {
      fail('NOT_FOUND', `requeue：任务不存在（id=${taskId}）`, { details: { id: taskId, resource: 'task' } })
    }
    // 只收容已停下：queued 会打乱 available_at/dedupe；leased 可能正在写（再排队=双写，AGENTS 不变量 2）；done 重放=再写一次。
    if (task.state !== 'failed' && task.state !== 'needs_review') {
      fail('VALIDATION', `requeue：任务 ${taskId} 状态为 ${task.state}，只有 failed / needs_review 可以重新排队`)
    }
    // attempts 归零是刻意的：人工重试 = 重获完整重试预算，否则次数用尽的任务刚入队又会立刻回 needs_review。
    ctx.sql.markRequeued.run(availableAt, at, taskId)
    return toTaskRecord(ctx.sql.selectById.get(taskId))
  })
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

/**
 * 批次聚合：counts 覆盖全部状态（缺键会让面板显示成"无数据"），total 是真实总数，
 * items 只是前 200 条明细——两者刻意可能不等，调用方不能拿 items.length 当 total。
 */
function batchStatsOf(ctx: QueueContext, batchId: string): BatchStats {
  assertOpen(ctx)
  const id = assertBatchId(batchId)
  const counts = emptyStateCounts()
  let total = 0
  for (const raw of ctx.sql.countByBatch.all(id)) {
    const row = asSqlRow(raw)
    if (row === undefined) continue
    const count = readSqlNumber(row, 'total')
    counts[requireState(readSqlText(row, 'state'))] = count
    total += count
  }
  const items = ctx.sql.selectByBatch.all(id, MAX_BATCH_ITEMS).map((raw) => toTaskRecord(raw))
  return { batchId: id, total, counts, items }
}

function taskStats(ctx: QueueContext): Record<TaskState, number> {
  assertOpen(ctx)
  const stats = emptyStateCounts()
  for (const raw of ctx.sql.countByState.all()) {
    const row = asSqlRow(raw)
    if (row === undefined) continue
    stats[requireState(readSqlText(row, 'state'))] = readSqlNumber(row, 'total')
  }
  return stats
}

function closeQueue(ctx: QueueContext): void {
  if (ctx.closed) return
  ctx.closed = true
  ctx.store.close()
}

function requireLease(ctx: QueueContext, id: string, owner: string, action: string): TaskRecord {
  const taskId = assertText(id, 'id')
  const leaseOwner = assertText(owner, 'owner')
  const task = getTask(ctx, taskId)
  if (task === undefined) {
    fail('NOT_FOUND', `${action}：任务不存在（id=${taskId}）`, { details: { id: taskId, resource: 'task' } })
  }
  if (task.state !== 'leased' || task.leaseOwner !== leaseOwner) {
    // 这里刻意保留 VALIDATION 而不是改成「冲突」码：details 里带足现场信息，
    // 调用方（工具层/面板）据此就能说清「谁拿着租约、还能拿多久」，
    // 而不是让人对着「任务未持有」猜。
    fail('VALIDATION', `${action}：任务 ${taskId} 未被 ${leaseOwner} 持有（state=${task.state}）`, {
      details: {
        id: taskId,
        action,
        expectedOwner: leaseOwner,
        state: task.state,
        ...(task.leaseOwner === undefined ? {} : { actualOwner: task.leaseOwner }),
        ...(task.leaseUntil === undefined ? {} : { leaseUntilMs: task.leaseUntil, leaseRemainingMs: Math.max(0, task.leaseUntil - ctx.now()) }),
      },
    })
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
  const batchId = readSqlOptionalText(row, 'batch_id')
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
    ...(batchId === undefined ? {} : { batchId }),
  }
}

function assertOpen(ctx: QueueContext): void {
  if (ctx.closed) fail('STORAGE', '任务队列已关闭')
}
