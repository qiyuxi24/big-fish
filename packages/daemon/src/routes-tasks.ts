/**
 * 任务域路由：队列列表 / 单条 / 入队 / 批次 / 动作 / 重试 / 事件流。
 *
 * 为什么单独成文件：任务机是写路径的核心，状态与幂等语义都在这组路由上；
 * 与账号 / 商品 / 设置分文件后，改任务收尾只碰这一处。
 * @module @bigfish/daemon/routes-tasks
 */
import { fail } from '@bigfish/core'
import type {
  EnqueueInput,
  EnqueueReceipt,
  TaskEventQuery,
  TaskFilter,
  TaskQueue,
  TaskQueueHandle,
  TaskRecord,
} from '@bigfish/core'
import {
  asRecord,
  ok,
  optionalBoolean,
  optionalString,
  readJsonBody,
  requiredString,
  sendError,
  sendJson,
  sendMappedError,
} from './http.ts'
import type { Route, RouteContext } from './routes.ts'
import {
  batchNotFound,
  isTaskKind,
  isTaskState,
  parsePositiveInt,
  parseSince,
  taskNotFound,
} from './routes-shared.ts'

/**
 * 人工重新入队能力的注入签名；未注入时 POST /tasks/:id/retry 返回 UNSUPPORTED。
 * daemon 侧实现在 runtime 里（queue.requeue + 唤醒 worker），routes 不依赖 worker。
 */
export type RetryTaskHandler = (id: string) => TaskRecord

/** 任务域路由；拼进 routes.ts 的 ROUTES。注意顺序：/tasks 精确路径必须排在 /tasks/:id 之前。 */
export const taskRoutes: readonly Route[] = [
  { method: 'GET', pattern: /^\/tasks\/?$/, handler: listTasksHandler },
  { method: 'POST', pattern: /^\/tasks\/?$/, handler: enqueueHandler },
  // 批次视图只是 tasks.batch_id 的聚合，放在 /tasks 之后、/tasks/:id 之前读起来最顺。
  { method: 'GET', pattern: /^\/batches\/([^/]+)\/?$/, handler: batchStatsHandler },
  { method: 'GET', pattern: /^\/tasks\/([^/]+)\/?$/, handler: getTaskHandler },
  { method: 'POST', pattern: /^\/tasks\/([^/]+)\/(ack|fail|release)$/, handler: taskActionHandler },
  { method: 'POST', pattern: /^\/tasks\/([^/]+)\/retry\/?$/, handler: retryTaskHandler },
  { method: 'GET', pattern: /^\/events\/?$/, handler: listEventsHandler },
]

async function listTasksHandler(ctx: RouteContext): Promise<void> {
  const filter: TaskFilter = {}
  const state = ctx.url.searchParams.get('state')
  if (state !== null) {
    if (!isTaskState(state)) fail('VALIDATION', 'state 非法：' + state)
    filter.state = state
  }
  const kind = ctx.url.searchParams.get('kind')
  if (kind !== null) {
    if (!isTaskKind(kind)) fail('VALIDATION', 'kind 非法：' + kind)
    filter.kind = kind
  }
  const limit = ctx.url.searchParams.get('limit')
  if (limit !== null) filter.limit = parsePositiveInt(limit)
  await sendJson(ctx.res, 200, ok(ctx.queue.list(filter)), ctx.redact)
}

async function getTaskHandler(ctx: RouteContext): Promise<void> {
  const id = ctx.params[0] ?? fail('VALIDATION', '缺少任务 id')
  const record = ctx.queue.get(id)
  if (record === undefined) {
    await sendError(ctx.res, 404, taskNotFound(id), ctx.redact)
    return
  }
  await sendJson(ctx.res, 200, ok(record), ctx.redact)
}

async function enqueueHandler(ctx: RouteContext): Promise<void> {
  const body = asRecord(await readJsonBody(ctx.req), '入队请求体')
  let receipt: EnqueueReceipt
  try {
    // kind / dedupeKey / payload 的语义校验交给 queue：它才知道幂等键与状态机约束。
    receipt = enqueueWithReceipt(ctx.queue, body as unknown as EnqueueInput)
  } catch (error) {
    await sendMappedError(ctx.res, error, 400, ctx.redact)
    return
  }
  // created 摊平到顶层：既有调用方读 data.kind/data.id 的行为不变，新调用方靠 created 区分「新建/幂等命中」。
  await sendJson(ctx.res, 201, ok({ ...receipt.task, created: receipt.created }), ctx.redact)
}

/** 老队列实现没有 enqueueWithReceipt 时退回 enqueue，并保守地报告 created=true（它确实完成了入队语义）。 */
function enqueueWithReceipt(queue: TaskQueue, input: EnqueueInput): EnqueueReceipt {
  const handle = queue as TaskQueueHandle
  if (typeof handle.enqueueWithReceipt === 'function') return handle.enqueueWithReceipt(input)
  return { task: queue.enqueue(input), created: true }
}

/**
 * 批次视图：一次批量入队的进度聚合。
 * 未知批次按 404 处理——total=0 的「空批次」对 UI 没有意义，而且 batchId 会由调用方生成，
 * 拼错 id 时沉默返回全零比报错更难排查。
 */
async function batchStatsHandler(ctx: RouteContext): Promise<void> {
  const batchId = ctx.params[0] ?? fail('VALIDATION', '缺少批次 id')
  const handle = ctx.queue as TaskQueueHandle
  if (typeof handle.batchStats !== 'function') fail('UNSUPPORTED', '队列实现不支持批次视图')
  const stats = handle.batchStats(batchId)
  if (stats.total === 0) {
    await sendError(ctx.res, 404, batchNotFound(batchId), ctx.redact)
    return
  }
  await sendJson(ctx.res, 200, ok(stats), ctx.redact)
}

/**
 * 人工收尾：把 failed / needs_review 任务重新入队（attempts 归零，重获完整重试预算）。
 * 404 先于能力检查：不存在的 id 不该因为服务端没装配 retry 而变成 500。
 * 状态不允许是「请求与当前状态冲突」的语义，按 400 返回（与 enqueue 的入参校验一致）。
 */
async function retryTaskHandler(ctx: RouteContext): Promise<void> {
  const id = ctx.params[0] ?? fail('VALIDATION', '缺少任务 id')
  if (ctx.queue.get(id) === undefined) {
    await sendError(ctx.res, 404, taskNotFound(id), ctx.redact)
    return
  }
  const retry = ctx.retryTask ?? fail('UNSUPPORTED', 'daemon 未注入任务重试能力')
  let record: TaskRecord
  try {
    record = retry(id)
  } catch (error) {
    await sendMappedError(ctx.res, error, 400, ctx.redact)
    return
  }
  await sendJson(ctx.res, 200, ok(record), ctx.redact)
}

/** 处理 ack / fail / release：租约冲突映射 409，其余按 code 映射。 */
async function taskActionHandler(ctx: RouteContext): Promise<void> {
  const id = ctx.params[0] ?? fail('VALIDATION', '缺少任务 id')
  const action = ctx.params[1] ?? fail('VALIDATION', '缺少任务动作')
  const body = asRecord(await readJsonBody(ctx.req), '任务动作请求体')
  const owner = requiredString(body, 'owner', '任务动作请求体')
  try {
    applyTaskAction(ctx.queue, id, action, owner, body)
  } catch (error) {
    // 这里的 VALIDATION 语义是「状态冲突」（如 owner 不匹配），HTTP 用 409 更准确。
    await sendMappedError(ctx.res, error, 409, ctx.redact)
    return
  }
  const record = ctx.queue.get(id)
  if (record === undefined) {
    await sendError(ctx.res, 404, taskNotFound(id), ctx.redact)
    return
  }
  await sendJson(ctx.res, 200, ok(record), ctx.redact)
}

function applyTaskAction(queue: TaskQueue, id: string, action: string, owner: string, body: Record<string, unknown>): void {
  if (action === 'ack') {
    queue.ack(id, owner)
    return
  }
  if (action === 'release') {
    queue.release(id, owner)
    return
  }
  const message = optionalString(body, 'error', '任务动作请求体') ?? '执行失败（未提供错误信息）'
  // nonRetryable=true 的任务直接进 failed/needs_review，不再等 attempts 用尽（风控、参数错误场景）。
  const nonRetryable = optionalBoolean(body, 'nonRetryable', '任务动作请求体')
  if (nonRetryable === true) queue.fail(id, owner, message, { nonRetryable: true })
  else queue.fail(id, owner, message)
}

/**
 * 增量事件流：since 是排他主键游标，返回 {items, nextSince}，面板每 3 秒带上一次
 * nextSince 再拉一次即可；没有新事件时 items 为空且 nextSince 不回退。
 */
async function listEventsHandler(ctx: RouteContext): Promise<void> {
  const events = ctx.events
  if (events === undefined) fail('UNSUPPORTED', '事件流未开启：daemon 未注入任务事件存储')
  const query: TaskEventQuery = {}
  const since = ctx.url.searchParams.get('since')
  if (since !== null) query.since = parseSince(since)
  const limit = ctx.url.searchParams.get('limit')
  if (limit !== null) query.limit = parsePositiveInt(limit)
  const taskId = ctx.url.searchParams.get('taskId')
  if (taskId !== null && taskId !== '') query.taskId = taskId
  const batchId = ctx.url.searchParams.get('batchId')
  if (batchId !== null && batchId !== '') query.batchId = batchId
  const items = events.list(query)
  const last = items.length === 0 ? undefined : items[items.length - 1]
  const nextSince = last === undefined ? (query.since ?? 0) : last.id
  await sendJson(ctx.res, 200, ok({ items, nextSince }), ctx.redact)
}
