/**
 * daemon 的路由「表」与公共上下文。
 *
 * 这层只做两件事：声明一次请求的上下文（RouteContext）与把各域路由拼成一张表。
 * 具体 handler 按域分文件：status / accounts / tasks / items / settings / seller / market / lifecycle。
 * 为什么不再全放这里：13 条路由时代还看得过来，21 条之后任何一处改动都要在同一个
 * 500+ 行文件里翻五个域，且每次加能力都会在同一段 RouteContext 上制造冲突。
 * @module @bigfish/daemon/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  CircuitBreaker,
  DaemonCapabilities,
  ItemRepository,
  SellerRepository,
  TaskEventSink,
  TaskQueue,
} from '@bigfish/core'
import type { RedactFn } from './http.ts'
import type { ImportAccountInput, ImportedAccount } from './accounts.ts'
import type { LoginInput, LoginResult } from './login.ts'
import type { AccountSummary } from './account-list.ts'
import type { AccountSessionState } from './account-verify.ts'
import type { ActivateResult, LogoutResult } from './account-lifecycle.ts'
import type { BrowserStatus } from './managed-browser.ts'
import { lifecycleRoutes } from './lifecycle.ts'
import { sellerRoutes } from './seller-routes.ts'
import { marketRoutes } from './routes-market.ts'
import { policyRoutes } from './routes-policy.ts'
import type { SellerCollectHandler } from './seller-routes.ts'
import type { SettingsStore } from './settings.ts'
import { accountRoutes } from './routes-accounts.ts'
import type {
  ActivateAccountHandler,
  ImportAccountHandler,
  LoginAccountHandler,
  LogoutAccountHandler,
  VerifyAccountHandler,
} from './routes-accounts.ts'
import { imRoutes } from './routes-im.ts'
import { itemRoutes } from './routes-items.ts'
import type { ReferenceCollectHandler } from './routes-items.ts'
import type { ImRuntime } from './im-runtime.ts'
import { settingsRoutes } from './routes-settings.ts'
import { decodeParam } from './routes-shared.ts'
import { statusRoutes } from './routes-status.ts'
import type { WorkerCounts } from './routes-status.ts'
import { taskRoutes } from './routes-tasks.ts'
import type { RetryTaskHandler } from './routes-tasks.ts'

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
  /** 写能力快照；未注入时 /status 不带 capabilities 字段。 */
  capabilities: (() => DaemonCapabilities) | undefined
  /** 账号导入能力；未注入时 POST /accounts/import 返回 UNSUPPORTED。 */
  importAccount: ImportAccountHandler | undefined
  /** 扫码登录能力；未注入时 POST /accounts/login 返回 UNSUPPORTED。 */
  loginAccount: LoginAccountHandler | undefined
  /** 登录态校验能力；未注入时 POST /accounts/:id/verify 返回 UNSUPPORTED。 */
  verifyAccount: VerifyAccountHandler | undefined
  /** 切换当前账号能力；未注入时 POST /accounts/activate 返回 UNSUPPORTED。 */
  activateAccount: ActivateAccountHandler | undefined
  /** 退出登录能力；未注入时 POST /accounts/:id/logout 返回 UNSUPPORTED。 */
  logoutAccount: LogoutAccountHandler | undefined
  /** 账号摘要能力；未注入时 GET /accounts 返回空数组（不是错误，开发态也能渲染面板）。 */
  accountSummaries: (() => Promise<AccountSummary[]>) | undefined
  /** 人工重新入队能力；未注入时 POST /tasks/:id/retry 返回 UNSUPPORTED。 */
  retryTask: RetryTaskHandler | undefined
  /** 参考采集能力；未注入时 POST /reference 返回 UNSUPPORTED。 */
  referenceCollect: ReferenceCollectHandler | undefined
  /** 商家商品采集（会落库）；未注入时 POST /sellers/collect 返回 UNSUPPORTED。 */
  sellerCollect: SellerCollectHandler | undefined
  /** 采集结果仓储；未注入时 GET /sellers 与 /sellers/:id/items 返回空。 */
  sellerItems: SellerRepository | undefined
  /** 优雅关停能力；未注入时 POST /shutdown 返回 UNSUPPORTED。 */
  requestShutdown: RequestShutdown | undefined
  /** 设置存储；未注入时 GET/PUT /settings 返回 UNSUPPORTED（测试里不必真读盘）。 */
  settings: SettingsStore | undefined
  /** 任务事件流；未注入时 GET /events 返回 UNSUPPORTED。 */
  events: TaskEventSink | undefined
  /** 托管浏览器状态（扫码/导入/发布共用的那个实例）；未注入时 GET /browser 返回 enabled:false。 */
  browser: (() => Promise<BrowserStatus>) | undefined
  /** IM 运行时（连接状态 + 回复入队）；未注入时 GET /im/status 返回 enabled:false、POST /im/reply 返回 UNSUPPORTED。 */
  im: ImRuntime | undefined
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

/**
 * 路由表：按域拼装，顺序只在「精确路径 vs 带参路径」时才有意义
 * （例如 /tasks 必须排在 /tasks/:id 之前；各域之间路径前缀不重叠）。
 */
const ROUTES: readonly Route[] = [
  ...statusRoutes,
  ...accountRoutes,
  ...taskRoutes,
  ...itemRoutes,
  ...sellerRoutes,
  ...marketRoutes,
  ...policyRoutes,
  ...imRoutes,
  ...settingsRoutes,
  // 生命周期路由单独成文件：关停是运维动作，不跟业务读写在同一个模块里改。
  ...lifecycleRoutes,
]

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

// 对外契约不变：server / runtime / 测试仍从 routes.ts 取这些类型与状态组装函数。
export type {
  ActivateAccountHandler,
  ImportAccountHandler,
  LoginAccountHandler,
  LogoutAccountHandler,
  VerifyAccountHandler,
  RetryTaskHandler,
  ReferenceCollectHandler,
  WorkerCounts,
}
export type { ImportedAccount, ImportAccountInput }
export type { LoginInput, LoginResult }
export type { AccountSummary, AccountSessionState }
export type { ActivateResult, LogoutResult }
export { buildStatus } from './routes-status.ts'