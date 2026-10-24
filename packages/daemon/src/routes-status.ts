/**
 * 状态域路由：GET /health（唯一公开路由）与 GET /status。
 *
 * 为什么单独成文件：状态是「所有能力的只读聚合」，任何新能力都会往这里加字段；
 * 跟任务 / 账号的写路由放在一起会让最热的文件持续变大。
 * @module @bigfish/daemon/routes-status
 */
import type { CircuitBreaker, DaemonStatus, TaskQueue } from '@bigfish/core'
import { ok, sendJson } from './http.ts'
import type { BrowserStatus } from './managed-browser.ts'
import type { Route, RouteContext } from './routes.ts'

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

async function healthHandler(ctx: RouteContext): Promise<void> {
  const data = { version: ctx.version, uptimeMs: uptime(ctx), pid: process.pid }
  await sendJson(ctx.res, 200, ok(data), ctx.redact)
}

async function statusHandler(ctx: RouteContext): Promise<void> {
  await sendJson(ctx.res, 200, ok(buildStatus(ctx)), ctx.redact)
}

/**
 * 托管浏览器状态：面板要能回答「扫码/发布共用的是哪个窗口、现在活着没」。
 * 与 /status 分开是因为它要真的探一次端口（毫秒级、连不上立刻返回），
 * 而 /status 每 3 秒被轮询一次、必须保持同步无 IO。
 */
async function browserHandler(ctx: RouteContext): Promise<void> {
  if (ctx.browser === undefined) {
    await sendJson(ctx.res, 200, ok({ enabled: false }), ctx.redact)
    return
  }
  const status: BrowserStatus = await ctx.browser()
  await sendJson(ctx.res, 200, ok({ enabled: true, ...status }), ctx.redact)
}

/** 状态域路由；拼进 routes.ts 的 ROUTES。 */
export const statusRoutes: readonly Route[] = [
  { method: 'GET', pattern: /^\/health\/?$/, handler: healthHandler, public: true },
  { method: 'GET', pattern: /^\/status\/?$/, handler: statusHandler },
  { method: 'GET', pattern: /^\/browser\/?$/, handler: browserHandler },
]
