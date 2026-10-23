/**
 * daemon 的路由表与处理函数。
 * 所有出站数据都走 sendJson（内部经 redact），错误统一映射为 ApiResult 错误信封。
 * @module @bigfish/daemon/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { XianyuError, fail } from '@bigfish/core'
import type {
  CircuitBreaker,
  DaemonStatus,
  EnqueueInput,
  EnqueueReceipt,
  ItemFilter,
  ItemRepository,
  ItemState,
  ItemSummary,
  TaskEventQuery,
  TaskEventSink,
  TaskFilter,
  TaskKind,
  TaskQueue,
  TaskQueueHandle,
  TaskRecord,
  TaskState,
} from '@bigfish/core'
import {
  MAX_BODY_BYTES,
  asRecord,
  ok,
  optionalBoolean,
  optionalPort,
  optionalPositiveInt,
  optionalString,
  readJsonBody,
  requiredString,
  sendError,
  sendJson,
  sendMappedError,
} from './http.ts'
import type { RedactFn } from './http.ts'
import type { ImportAccountInput, ImportedAccount } from './accounts.ts'
import type { LoginInput, LoginResult } from './login.ts'
import type { AccountSummary } from './account-list.ts'
import type { AccountSessionState } from './account-verify.ts'
import { lifecycleRoutes } from './lifecycle.ts'
import { parseReferenceRequest } from './reference.ts'
import type { ReferenceReport, ReferenceRequest } from './reference.ts'
import type { SettingsStore } from './settings.ts'

/** 账号导入能力的注入签名；未注入时路由返回 UNSUPPORTED（HTTP 500）。 */
export type ImportAccountHandler = (input: ImportAccountInput) => Promise<ImportedAccount>

/** 扫码登录能力的注入签名；未注入时 POST /accounts/login 返回 UNSUPPORTED。 */
export type LoginAccountHandler = (input: LoginInput) => Promise<LoginResult>

/**
 * 登录态校验能力的注入签名；未注入时 POST /accounts/:id/verify 返回 UNSUPPORTED。
 * 返回 200 的 value（online=false 也是成功响应），账号不存在才抛 VALIDATION。
 */
export type VerifyAccountHandler = (input: { accountId: string }) => Promise<AccountSessionState>

/**
 * 人工重新入队能力的注入签名；未注入时 POST /tasks/:id/retry 返回 UNSUPPORTED。
 * daemon 侧实现在 runtime 里（queue.requeue + 唤醒 worker），routes 不依赖 worker。
 */
export type RetryTaskHandler = (id: string) => TaskRecord

/**
 * 参考采集能力的注入签名；未注入时 POST /reference 返回 UNSUPPORTED。
 * 只读：返回统计原料，不落库、不下载图片（AGENTS §1.6）。
 */
export type ReferenceCollectHandler = (input: ReferenceRequest & { signal: AbortSignal }) => Promise<ReferenceReport>

/** 关停能力的注入签名：cli 用它唤醒退出等待；参数是触发原因（HTTP / SIGINT…）。 */
export type RequestShutdown = (reason?: string) => void

/** 一次请求的处理上下文：路由参数、URL、队列与时钟都在这里。 */
export interface RouteContext {
  queue: TaskQueue
  /** 商品表；未注入时为 undefined（GET /items 返回空数组）。 */
  items: ItemRepository | undefined
  /** 已保存账号列表提供者；未注入时 /status.accounts 为空。 */
  accounts: (() => string[]) | undefined
  /** 账号熔断器；未注入时 /status.circuits 为空且 /circuits/reset 为空操作。 */
  circuits: CircuitBreaker | undefined
  /** worker 计数提供者；未注入时 /status 不带 worker 字段。 */
  worker: (() => WorkerCounts) | undefined
  /** 账号导入能力；未注入时 POST /accounts/import 返回 UNSUPPORTED。 */
  importAccount: ImportAccountHandler | undefined
  /** 扫码登录能力；未注入时 POST /accounts/login 返回 UNSUPPORTED。 */
  loginAccount: LoginAccountHandler | undefined
  /** 登录态校验能力；未注入时 POST /accounts/:id/verify 返回 UNSUPPORTED。 */
  verifyAccount: VerifyAccountHandler | undefined
  /** 账号摘要能力；未注入时 GET /accounts 返回空数组（不是错误，开发态也能渲染面板）。 */
  accountSummaries: (() => Promise<AccountSummary[]>) | undefined
  /** 人工重新入队能力；未注入时 POST /tasks/:id/retry 返回 UNSUPPORTED。 */
  retryTask: RetryTaskHandler | undefined
  /** 参考采集能力；未注入时 POST /reference 返回 UNSUPPORTED。 */
  referenceCollect: ReferenceCollectHandler | undefined
  /** 优雅关停能力；未注入时 POST /shutdown 返回 UNSUPPORTED。 */
  requestShutdown: RequestShutdown | undefined
  /** 设置存储；未注入时 GET/PUT /settings 返回 UNSUPPORTED（测试里不必真读盘）。 */
  settings: SettingsStore | undefined
  /** 任务事件流；未注入时 GET /events 返回 UNSUPPORTED。 */
  events: TaskEventSink | undefined
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
  method: 'GET' | 'POST' | 'PUT'
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
const ITEM_STATES = new Set<string>(['online', 'offline', 'unknown'])

function isTaskState(value: string): value is TaskState {
  return TASK_STATES.has(value)
}

function isItemState(value: string): value is ItemState {
  return ITEM_STATES.has(value)
}

function isTaskKind(value: string): value is TaskKind {
  return TASK_KINDS.has(value)
}

/** 路由表。注意顺序：/tasks 精确路径必须排在 /tasks/:id 之前。 */
const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^\/health\/?$/, handler: healthHandler, public: true },
  { method: 'GET', pattern: /^\/status\/?$/, handler: statusHandler },
  { method: 'GET', pattern: /^\/accounts\/?$/, handler: listAccountsHandler },
  { method: 'POST', pattern: /^\/accounts\/import\/?$/, handler: importAccountHandler },
  { method: 'POST', pattern: /^\/accounts\/login\/?$/, handler: loginAccountHandler },
  // 放在 login 之后：两条都是精确/带参路径，顺序只影响可读性；带参路由不要抢在精确路由前。
  { method: 'POST', pattern: /^\/accounts\/([^/]+)\/verify\/?$/, handler: verifyAccountHandler },
  { method: 'GET', pattern: /^\/tasks\/?$/, handler: listTasksHandler },
  { method: 'POST', pattern: /^\/tasks\/?$/, handler: enqueueHandler },
  // 批次视图只是 tasks.batch_id 的聚合，放在 /tasks 之后、/tasks/:id 之前读起来最顺。
  { method: 'GET', pattern: /^\/batches\/([^/]+)\/?$/, handler: batchStatsHandler },
  { method: 'GET', pattern: /^\/tasks\/([^/]+)\/?$/, handler: getTaskHandler },
  { method: 'POST', pattern: /^\/tasks\/([^/]+)\/(ack|fail|release)$/, handler: taskActionHandler },
  { method: 'POST', pattern: /^\/tasks\/([^/]+)\/retry\/?$/, handler: retryTaskHandler },
  { method: 'POST', pattern: /^\/reference\/?$/, handler: referenceHandler },
  { method: 'GET', pattern: /^\/items\/?$/, handler: listItemsHandler },
  { method: 'POST', pattern: /^\/circuits\/reset\/?$/, handler: resetCircuitHandler },
  { method: 'GET', pattern: /^\/events\/?$/, handler: listEventsHandler },
  { method: 'GET', pattern: /^\/settings\/?$/, handler: getSettingsHandler },
  { method: 'PUT', pattern: /^\/settings\/?$/, handler: putSettingsHandler },
  // 生命周期路由单独成文件：关停是运维动作，不跟业务读写在同一个模块里改。
  ...lifecycleRoutes,
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

/** /status.worker 的最小形状（避免 routes 依赖 worker 实现）。 */
export interface WorkerCounts {
  leased: number
  done: number
  failed: number
  errors: number
}

interface StatusSource {
  queue: TaskQueue
  now: () => number
  startedAt: number
  version: string
  /** 已保存账号列表提供者（凭据库）；缺省或 undefined 视作空。 */
  accounts?: (() => string[]) | undefined
  /** 账号熔断器；缺省或 undefined 视作无熔断。 */
  circuits?: CircuitBreaker | undefined
  /** worker 计数；缺省或 undefined 时不带 worker 字段。 */
  worker?: (() => WorkerCounts) | undefined
}

/** 组装 DaemonStatus：queue 统计 + 账号列表 + 仍在冷却中的熔断原因。 */
export function buildStatus(source: StatusSource): DaemonStatus {
  const circuits: Record<string, string> = {}
  for (const state of source.circuits?.list() ?? []) circuits[state.accountId] = state.reason
  return {
    version: source.version,
    uptimeMs: uptime(source),
    pid: process.pid,
    queue: source.queue.stats(),
    accounts: source.accounts?.() ?? [],
    circuits,
    ...(source.worker === undefined ? {} : { worker: source.worker() }),
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

/**
 * 扫码登录：打开闲鱼登录页并等用户扫码，读到 cookie 后落加密凭据。
 * 请求体可空（全部参数可选）；长轮询期间用 AbortSignal 响应客户端断开，不阻塞事件循环。
 * 调用方的 HTTP 超时必须大于 timeoutMs（默认 180s）：DaemonClient 默认 15s，直接调会先超时。
 * 这是写操作（落加密凭据），插件侧必须走审批门禁。
 */
async function loginAccountHandler(ctx: RouteContext): Promise<void> {
  const login = ctx.loginAccount ?? fail('UNSUPPORTED', 'daemon 未注入扫码登录能力')
  const body = asRecord(await readJsonBody(ctx.req, MAX_BODY_BYTES, true), '扫码登录请求体')
  const input: LoginInput = {}
  const accountId = optionalString(body, 'accountId', '扫码登录请求体')
  if (accountId !== undefined) input.accountId = accountId
  const port = optionalPort(body, 'port', '扫码登录请求体')
  if (port !== undefined) input.port = port
  const timeoutMs = optionalPositiveInt(body, 'timeoutMs', '扫码登录请求体')
  if (timeoutMs !== undefined) input.timeoutMs = timeoutMs
  const controller = new AbortController()
  // 客户端提前断开（用户关页面/超时撤销）时立刻中止等待，否则会有一个悬挂的扫码轮询。
  const onClose = (): void => {
    controller.abort()
  }
  ctx.res.once('close', onClose)
  try {
    const result = await login({ ...input, signal: controller.signal })
    await sendJson(ctx.res, 200, ok(result), ctx.redact)
  } finally {
    ctx.res.off('close', onClose)
  }
}

/**
 * 从本机 Chrome 导入登录态。
 * 请求体可为空对象；accountId / port 都可选（默认 unb、默认 9222）。
 * 这是写操作（落加密凭据），插件侧必须走审批门禁。
 */
/**
 * 账号列表：只读摘要（账号 id / 更新时间 / 字段数 / 是否可用），不含任何 cookie 值。
 * 未注入摘要能力时返回空数组：面板在「daemon 未接凭据库」的开发态也应当能渲染。
 */
async function listAccountsHandler(ctx: RouteContext): Promise<void> {
  const summaries: AccountSummary[] = ctx.accountSummaries === undefined ? [] : await ctx.accountSummaries()
  await sendJson(ctx.res, 200, ok(summaries), ctx.redact)
}

async function importAccountHandler(ctx: RouteContext): Promise<void> {
  const importer = ctx.importAccount ?? fail('UNSUPPORTED', 'daemon 未注入账号导入能力')
  const body = asRecord(await readJsonBody(ctx.req), '账号导入请求体')
  const input: ImportAccountInput = {}
  const accountId = optionalString(body, 'accountId', '账号导入请求体')
  if (accountId !== undefined) input.accountId = accountId
  const port = optionalPort(body, 'port', '账号导入请求体')
  if (port !== undefined) input.port = port
  const result = await importer(input)
  await sendJson(ctx.res, 200, ok(result), ctx.redact)
}

/**
 * 校验账号登录态：掉线/风控/网络失败都回 200 + online:false，面板据此展示原因，不用解析 mtop 错误码。
 * 只有「账号不存在」（VALIDATION → 400）与「能力未装配」（UNSUPPORTED → 500）走错误信封。
 */
async function verifyAccountHandler(ctx: RouteContext): Promise<void> {
  const verify = ctx.verifyAccount ?? fail('UNSUPPORTED', 'daemon 未注入登录态校验能力')
  const accountId = ctx.params[0] ?? fail('VALIDATION', '缺少账号 id')
  const state = await verify({ accountId })
  await sendJson(ctx.res, 200, ok(state), ctx.redact)
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

/**
 * 采集参考：只读统计（价格带 / 标题长度 / 类目分布 / 关键词 / 商家量级）。
 * 客户端断开就用 AbortSignal 中止剩余请求：20 件串行最坏要十几秒，用户关页面后不该继续打平台。
 */
async function referenceHandler(ctx: RouteContext): Promise<void> {
  const collect = ctx.referenceCollect ?? fail('UNSUPPORTED', 'daemon 未注入参考采集能力')
  const body = asRecord(await readJsonBody(ctx.req), '参考采集请求体')
  const request = parseReferenceRequest(body)
  const controller = new AbortController()
  const onClose = (): void => {
    controller.abort()
  }
  ctx.res.once('close', onClose)
  try {
    const report = await collect({ ...request, signal: controller.signal })
    await sendJson(ctx.res, 200, ok(report), ctx.redact)
  } finally {
    ctx.res.off('close', onClose)
  }
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
  const filter: ItemFilter = {}
  const state = ctx.url.searchParams.get('state')
  if (state !== null) {
    if (!isItemState(state)) fail('VALIDATION', 'item state 非法：' + state)
    filter.state = state
  }
  const accountId = ctx.url.searchParams.get('accountId')
  if (accountId !== null) {
    if (accountId === '') fail('VALIDATION', 'accountId 不能为空')
    filter.accountId = accountId
  }
  const limit = ctx.url.searchParams.get('limit')
  if (limit !== null) filter.limit = parseLimit(limit)
  const items: ItemSummary[] = ctx.items?.list(filter) ?? []
  await sendJson(ctx.res, 200, ok(items), ctx.redact)
}

async function resetCircuitHandler(ctx: RouteContext): Promise<void> {
  const body = asRecord(await readJsonBody(ctx.req), '熔断重置请求体')
  const accountId = requiredString(body, 'accountId', '熔断重置请求体')
  ctx.circuits?.reset(accountId)
  await sendJson(ctx.res, 200, ok({ accountId, reset: ctx.circuits !== undefined }), ctx.redact)
}

/** 读设置：面板启动时拉一次，显示当前文案风格/默认类目/发布节奏。 */
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
  if (limit !== null) query.limit = parseLimit(limit)
  const taskId = ctx.url.searchParams.get('taskId')
  if (taskId !== null && taskId !== '') query.taskId = taskId
  const batchId = ctx.url.searchParams.get('batchId')
  if (batchId !== null && batchId !== '') query.batchId = batchId
  const items = events.list(query)
  const last = items.length === 0 ? undefined : items[items.length - 1]
  const nextSince = last === undefined ? (query.since ?? 0) : last.id
  await sendJson(ctx.res, 200, ok({ items, nextSince }), ctx.redact)
}

/** since 是事件主键游标：只接受非负整数，别让「上次失败的游标」把面板卡死。 */
function parseSince(raw: string): number {
  if (!/^\d+$/.test(raw)) fail('VALIDATION', 'since 必须是非负整数：' + raw)
  return Number(raw)
}

async function getSettingsHandler(ctx: RouteContext): Promise<void> {
  const store = ctx.settings ?? fail('UNSUPPORTED', 'daemon 未注入设置存储')
  await sendJson(ctx.res, 200, ok(await store.get()), ctx.redact)
}

/**
 * 改设置：只接受补丁（缺省字段保持不变）；非法字段/越界值由 core 的 parseSettingsPatch 抛 VALIDATION → 400。
 * 与入队一样，写接口不做「部分成功」：校验不过就一个字段都不写。
 */
async function putSettingsHandler(ctx: RouteContext): Promise<void> {
  const store = ctx.settings ?? fail('UNSUPPORTED', 'daemon 未注入设置存储')
  const body = await readJsonBody(ctx.req)
  let next: Awaited<ReturnType<SettingsStore['update']>>
  try {
    next = await store.update(body)
  } catch (error) {
    await sendMappedError(ctx.res, error, 400, ctx.redact)
    return
  }
  await sendJson(ctx.res, 200, ok(next), ctx.redact)
}

/** 构造 404 错误：code 用 VALIDATION（core 没有 NOT_FOUND 码，HTTP 状态已表达语义）。 */
function taskNotFound(id: string): XianyuError {
  return new XianyuError({ code: 'VALIDATION', message: '任务不存在：' + id })
}

function batchNotFound(batchId: string): XianyuError {
  return new XianyuError({ code: 'VALIDATION', message: '批次不存在：' + batchId })
}