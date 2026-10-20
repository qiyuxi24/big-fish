/**
 * daemon 的路由表与处理函数。
 * 所有出站数据都走 sendJson（内部经 redact），错误统一映射为 ApiResult 错误信封。
 * @module @bigfish/daemon/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { XianyuError, fail } from '@bigfish/core'
import type {
  DaemonStatus,
  EnqueueInput,
  ItemSummary,
  TaskFilter,
  TaskKind,
  TaskQueue,
  TaskRecord,
  TaskState,
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
import type { RedactFn } from './http.ts'

/** 一次请求的处理上下文：路由参数、URL、队列与时钟都在这里。 */
export interface RouteContext {
  queue: TaskQueue
  now: () => number
  startedAt: number
  version: string
  redact: RedactFn
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: string[]
}

/** 一条路由：方法 + 路径正则 + 处理函数。 */
export interface Route {
  method: 'GET' | 'POST'
  pattern: RegExp
  handler: (ctx: RouteContext) => Promise<void>
  /** 唯一公开路由：GET /health 不需要 token。 */
  public?: boolean
}

/** 路由匹配结果；methodNotAllowed 用于区分 404（路径不存在）与 405（路径存在但方法不对）。 */
export type RouteMatch = { route: Route; params: string[] } | { methodNotAllowed: true }

const TASK_STATES = new Set<string>(['queued', 'leased', 'done', 'failed', 'needs_review'])
const TASK_KINDS = new Set<string>(['publish', 'deliver', 'polish', 'reply', 'probe'])

/** 状态机取值校验（P0 手写集合；任务层用 zod 时再统一）。 */
function isTaskState(value: string): value is TaskState {
  return TASK_STATES.has(value)
}

function isTaskKind(value: string): value is TaskKind {
  return TASK_KINDS.has(value)
}

/** 路由表。注意顺序：/tasks 精确路径必须排在 /tasks/:id 之前。 */
const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^\/health\/?$/, handler: healthHandler, public: true },
  { method: 'GET', pattern: /^\/status\/?$/, handler: statusHandler },
  { method: 'GET', pattern: /^\/tasks\/?$/, handler: listTasksHandler },
  { method: 'POST', pattern: /^\/tasks\/?$/, handler: enqueueHandler },
  { method: 'GET', pattern: /^\/tasks\/([^/]+)\/?$/, handler: getTaskHandler },
  { method: 'POST', pattern: /^\/tasks\/([^/]+)\/(ack|fail|release)$/, handler: taskActionHandler },
  { method: 'GET', pattern: /^\/items\/?$/, handler: listItemsHandler },
  { method: 'POST', pattern: /^\/circuits\/reset\/?$/, handler: resetCircuitHandler },
]

/** 装饰 URL 参数解码失败时按 VALIDATION 处理。 */
function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return fail('VALIDATION', '路径参数不是合法的 URL 编码')
  }
}

/** 匹配方法与路径；找不到路径返回 undefined，路径存在但方法不对返回 methodNotAllowed。 */
export function matchRoute(method: string, pathname: string): RouteMatch | undefined {
  let pathMatched = false
  for (const route of ROUTES) {
    const matched = route.pattern.exec(pathname)
    if (matched === null) continue
    pathMatched = true
    if (route.method !== method) continue
    return { route, params: matched.slice(1).map(decodeParam) }
  }
  return pathMatched ? { methodNotAllowed: true } : undefined
}

interface StatusSource {
  queue: TaskQueue
  now: () => number
  startedAt: number
  version: string
}

/** 组装 DaemonStatus。accounts/circuits 在 P0 固定为空，P1 接账号存储与熔断器。 */
export function buildStatus(source: StatusSource): DaemonStatus {
  return {
    version: source.version,
    uptimeMs: uptime(source),
    pid: process.pid,
    queue: source.queue.stats(),
    accounts: [],
    circuits: {},
  }
}

/** 运行时长；注入假时钟时也保证非负。 */
function uptime(source: { now: () => number; startedAt: number }): number {
  return Math.max(0, Math.trunc(source.now() - source.startedAt))
}

/** 解析 limit 查询参数：必须是正整数。 */
function parseLimit(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) fail('VALIDATION', 'limit 必须是正整数：' + raw)
  return Number(raw)
}

async function healthHandler(ctx: RouteContext): Promise<void> {
  const data = { version: ctx.version, uptimeMs: uptime(ctx), pid: process.pid }
  await sendJson(ctx.res, 200, ok(data), ctx.redact)
}

async function statusHandler(ctx: RouteContext): Promise<void> {
  await sendJson(ctx.res, 200, ok(buildStatus(ctx)), ctx.redact)
}

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
  if (limit !== null) filter.limit = parseLimit(limit)
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
  let record: TaskRecord
  try {
    // kind / dedupeKey / payload 的语义校验交给 queue：它才知道幂等键与状态机约束。
    record = ctx.queue.enqueue(body as unknown as EnqueueInput)
  } catch (error) {
    await sendMappedError(ctx.res, error, 400, ctx.redact)
    return
  }
  await sendJson(ctx.res, 201, ok(record), ctx.redact)
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

async function listItemsHandler(ctx: RouteContext): Promise<void> {
  // TODO(P1)：接 @bigfish/core 的 store（ItemSummary 落库）；P0 固定返回空数组以冻结接口。
  const items: ItemSummary[] = []
  await sendJson(ctx.res, 200, ok(items), ctx.redact)
}

async function resetCircuitHandler(ctx: RouteContext): Promise<void> {
  const body = asRecord(await readJsonBody(ctx.req), '熔断重置请求体')
  requiredString(body, 'accountId', '熔断重置请求体')
  // TODO(P1)：接 @bigfish/core 的 CircuitBreaker.reset(accountId)；P0 空实现以固定接口。
  await sendJson(ctx.res, 200, ok({}), ctx.redact)
}

/** 构造 404 错误：code 用 VALIDATION（core 没有 NOT_FOUND 码，HTTP 状态已表达语义）。 */
function taskNotFound(id: string): XianyuError {
  return new XianyuError({ code: 'VALIDATION', message: '任务不存在：' + id })
}
