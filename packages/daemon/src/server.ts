/**
 * 本地 HTTP 服务：只绑回环地址、Bearer token 文件鉴权、JSON 信封响应。
 *
 * 为什么这么收：DSH 插件是唯一客户端，攻击面是本机其他进程；token 文件 + 回环绑定
 * 把「谁能操作 daemon」收敛到「能读该文件的本机用户」。
 * @module @bigfish/daemon/server
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import { XianyuError, fail, toXianyuError } from '@bigfish/core'
import type { CircuitBreaker, DaemonCapabilities, DaemonStatus, ItemRepository, SellerRepository, TaskEventSink, TaskQueue } from '@bigfish/core'
import { isLoopbackHost } from './config.ts'
import type { DaemonConfig } from './config.ts'
import { extractBearer, loadRedact, sendError, sendMappedError, tokenMatches } from './http.ts'
import type { RedactFn } from './http.ts'
import { buildStatus, matchRoute } from './routes.ts'
import type {
  ActivateAccountHandler,
  ImportAccountHandler,
  LoginAccountHandler,
  LogoutAccountHandler,
  ReferenceCollectHandler,
  VerifyAccountHandler,
  RequestShutdown,
  RetryTaskHandler,
  WorkerCounts,
} from './routes.ts'
import type { AccountSummary } from './account-list.ts'
import type { BrowserStatus } from './managed-browser.ts'
import type { ImRuntime } from './im-runtime.ts'
import type { SellerCollectHandler } from './seller-routes.ts'
import type { SettingsStore } from './settings.ts'

/**
 * 请求总超时：普通 IPC 都是毫秒级，但三条长请求要留够时间——
 * 扫码登录（等用户扫码，最长 180s）、参考采集（20 件串行）、商家采集（最多 60 件串行 + 翻页）。
 * 调小会先于业务超时把连接掐断（历史上 scanning 请求就被 30s 掐过）。
 */
const REQUEST_TIMEOUT_MS = 180_000
/** 头部超时：防止半开连接占满连接数。 */
const HEADERS_TIMEOUT_MS = 10_000

/** 启动参数。queue 由调用方注入，便于 CLI 接 core、测试接 fake。 */
export interface StartDaemonOptions {
  config: DaemonConfig
  queue: TaskQueue
  /** 商品表；缺省时 GET /items 返回空数组（P0 行为）。 */
  items?: ItemRepository
  /** 已保存账号列表；缺省视作空。 */
  accounts?: () => string[]
  /** 账号熔断器；缺省时 status.circuits 为空对象。 */
  circuits?: CircuitBreaker
  /** worker 计数；缺省时 status 不带 worker 字段。 */
  worker?: () => WorkerCounts
  /** 写能力快照；缺省时 status 不带 capabilities 字段。 */
  capabilities?: () => DaemonCapabilities
  /** 账号导入能力；缺省时 POST /accounts/import 返回 UNSUPPORTED。 */
  importAccount?: ImportAccountHandler
  /** 扫码登录能力；缺省时 POST /accounts/login 返回 UNSUPPORTED。 */
  loginAccount?: LoginAccountHandler
  /** 登录态校验能力；缺省时 POST /accounts/:id/verify 返回 UNSUPPORTED。 */
  verifyAccount?: VerifyAccountHandler
  /** 切换当前账号能力；缺省时 POST /accounts/activate 返回 UNSUPPORTED。 */
  activateAccount?: ActivateAccountHandler
  /** 退出登录能力；缺省时 POST /accounts/:id/logout 返回 UNSUPPORTED。 */
  logoutAccount?: LogoutAccountHandler
  /** 账号摘要能力；缺省时 GET /accounts 返回空数组。 */
  accountSummaries?: () => Promise<AccountSummary[]>
  /** 人工重新入队能力；缺省时 POST /tasks/:id/retry 返回 UNSUPPORTED。 */
  retryTask?: RetryTaskHandler
  /** 参考采集能力；缺省时 POST /reference 返回 UNSUPPORTED。 */
  referenceCollect?: ReferenceCollectHandler
  /** 商家商品采集（会写本地库）；缺省时 POST /sellers/collect 返回 UNSUPPORTED。 */
  sellerCollect?: SellerCollectHandler
  /** 采集结果仓储；缺省时 GET /sellers 与 /sellers/:id/items 返回空。 */
  sellerItems?: SellerRepository
  /** 优雅关停能力；缺省时 POST /shutdown 返回 UNSUPPORTED。 */
  requestShutdown?: RequestShutdown
  /** 设置存储；缺省时 GET/PUT /settings 返回 UNSUPPORTED。 */
  settings?: SettingsStore
  /** 任务事件流；缺省时 GET /events 返回 UNSUPPORTED。 */
  events?: TaskEventSink
  /** 托管浏览器状态提供者；缺省时 GET /browser 返回 enabled:false。 */
  browser?: () => Promise<BrowserStatus>
  /** IM 运行时；缺省时 GET /im/status 返回 enabled:false、POST /im/reply 返回 UNSUPPORTED。 */
  im?: ImRuntime
  /** 可注入时钟（整数毫秒），测试用假时钟断言 uptime。 */
  now?: () => number
  version?: string
}

/** 已启动的 daemon 句柄。 */
export interface Daemon {
  url: string
  port: number
  /** 关闭监听并断开所有连接；幂等。 */
  close(): Promise<void>
  /** 当前状态快照，与 GET /status 同源。 */
  status(): DaemonStatus
}

interface ServerContext {
  queue: TaskQueue
  items: ItemRepository | undefined
  accounts: (() => string[]) | undefined
  circuits: CircuitBreaker | undefined
  worker: (() => WorkerCounts) | undefined
  capabilities: (() => DaemonCapabilities) | undefined
  importAccount: ImportAccountHandler | undefined
  loginAccount: LoginAccountHandler | undefined
  verifyAccount: VerifyAccountHandler | undefined
  activateAccount: ActivateAccountHandler | undefined
  logoutAccount: LogoutAccountHandler | undefined
  accountSummaries: (() => Promise<AccountSummary[]>) | undefined
  retryTask: RetryTaskHandler | undefined
  referenceCollect: ReferenceCollectHandler | undefined
  sellerCollect: SellerCollectHandler | undefined
  sellerItems: SellerRepository | undefined
  requestShutdown: RequestShutdown | undefined
  settings: SettingsStore | undefined
  events: TaskEventSink | undefined
  browser: (() => Promise<BrowserStatus>) | undefined
  im: ImRuntime | undefined
  now: () => number
  startedAt: number
  version: string
  token: string
  redact: RedactFn
}

/**
 * 启动 daemon；listen 成功后才 resolve，端口占用等失败以 XianyuError(NETWORK) 抛出。
 * config.port=0 时使用系统分配端口，并回填到 Daemon.port / Daemon.url。
 */
export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  const { config, queue } = options
  if (!isLoopbackHost(config.host)) fail('VALIDATION', 'daemon 只允许绑定回环地址，收到 ' + config.host)
  const now = options.now ?? Date.now
  const startedAt = now()
  const version = options.version ?? '0.0.0'
  const token = await readOrCreateToken(config.tokenPath)
  const redact = await loadRedact()
  const context: ServerContext = {
    queue,
    items: options.items,
    accounts: options.accounts,
    circuits: options.circuits,
    worker: options.worker,
    capabilities: options.capabilities,
    importAccount: options.importAccount,
    loginAccount: options.loginAccount,
    verifyAccount: options.verifyAccount,
    activateAccount: options.activateAccount,
    logoutAccount: options.logoutAccount,
    accountSummaries: options.accountSummaries,
    retryTask: options.retryTask,
    referenceCollect: options.referenceCollect,
    sellerCollect: options.sellerCollect,
    sellerItems: options.sellerItems,
    requestShutdown: options.requestShutdown,
    settings: options.settings,
    events: options.events,
    browser: options.browser,
    im: options.im,
    now,
    startedAt,
    version,
    token,
    redact,
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, context).catch((error: unknown) => {
      handleFatalRequestError(res, error)
    })
  })
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = HEADERS_TIMEOUT_MS

  const address = await listen(server, config.host, config.port)
  const port = address.port
  const hostForUrl = config.host.includes(':') ? '[' + config.host + ']' : config.host
  let closing: Promise<void> | undefined
  return {
    url: 'http://' + hostForUrl + ':' + port,
    port,
    close: () => {
      closing ??= closeServer(server)
      return closing
    },
    status: () =>
      buildStatus({
        queue,
        now,
        startedAt,
        version,
        ...(options.accounts === undefined ? {} : { accounts: options.accounts }),
        ...(options.circuits === undefined ? {} : { circuits: options.circuits }),
        ...(options.worker === undefined ? {} : { worker: options.worker }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      }),
  }
}

/** 顶层请求管线：路由 → 鉴权 → 处理；异常统一映射成错误信封。 */
async function handleRequest(req: IncomingMessage, res: ServerResponse, context: ServerContext): Promise<void> {
  try {
    const url = parseRequestUrl(req)
    const method = req.method ?? 'GET'
    const matched = matchRoute(method, url.pathname)
    // 鉴权先于 404：未授权方连「哪些路由存在」都不该探到；唯一例外是 GET /health。
    const isPublic = matched !== undefined && !('methodNotAllowed' in matched) && matched.route.public === true
    if (!isPublic && !tokenMatches(context.token, extractBearer(req.headers.authorization))) {
      await sendError(res, 401, new XianyuError({ code: 'UNAUTHORIZED', message: '缺少或无效的 daemon token' }), context.redact)
      return
    }
    // 404/405 用独立 code（不再复用 VALIDATION）：插件与面板据此能把「我打错路径/方法」和
    // 「参数不合法」分开——前者是版本不匹配，后者要用户改输入。鉴权仍在它们之前。
    if (matched === undefined) {
      await sendError(res, 404, new XianyuError({ code: 'NOT_FOUND', message: '未知路由：' + method + ' ' + url.pathname }), context.redact)
      return
    }
    if ('methodNotAllowed' in matched) {
      await sendError(res, 405, new XianyuError({ code: 'METHOD_NOT_ALLOWED', message: '方法不允许：' + method + ' ' + url.pathname }), context.redact)
      return
    }
    await matched.route.handler({
      queue: context.queue,
      items: context.items,
      accounts: context.accounts,
      circuits: context.circuits,
      worker: context.worker,
      capabilities: context.capabilities,
      importAccount: context.importAccount,
      loginAccount: context.loginAccount,
      verifyAccount: context.verifyAccount,
      activateAccount: context.activateAccount,
      logoutAccount: context.logoutAccount,
      accountSummaries: context.accountSummaries,
      retryTask: context.retryTask,
      referenceCollect: context.referenceCollect,
      sellerCollect: context.sellerCollect,
      sellerItems: context.sellerItems,
      requestShutdown: context.requestShutdown,
      settings: context.settings,
      events: context.events,
      browser: context.browser,
      im: context.im,
      now: context.now,
      startedAt: context.startedAt,
      version: context.version,
      redact: context.redact,
      req,
      res,
      url,
      params: matched.params,
    })
  } catch (error) {
    // 路由内部的 VALIDATION（非法 query/body）默认映射 400；413 由 details.httpStatus 覆盖。
    await sendMappedError(res, error, 400, context.redact)
  }
}

function parseRequestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://daemon.local')
  } catch {
    return fail('VALIDATION', '请求 URL 非法')
  }
}

/** 兜底：连错误信封都写不出去时断开连接；不记录原始异常（可能带敏感数据）。 */
function handleFatalRequestError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const message = error instanceof Error ? error.message : '未知错误'
  // 错误体只回稳定 code，不把内部 message 回给客户端；诊断靠 daemon 侧日志。
  const body = JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'daemon 内部错误', retryable: false } })
  try {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  } catch {
    // 已经写不出去就断开；messsage 仅用于本地诊断时再打开。
    void message
    res.destroy()
  }
}

function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(listenError(error, host, port))
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new XianyuError({ code: 'INTERNAL', message: '无法获取 daemon 监听地址' }))
        return
      }
      resolve(address)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ port, host })
  })
}

/** 把系统监听错误翻译成可读的中文 XianyuError；errno 留在 details 供 CLI 判断端口占用。 */
function listenError(error: Error, host: string, port: number): XianyuError {
  const errno = errorCode(error) ?? 'UNKNOWN'
  const hint = errno === 'EADDRINUSE' ? '端口已被占用' : '无法监听'
  return new XianyuError({
    code: 'NETWORK',
    message: 'daemon ' + hint + '：' + host + ':' + port + '（' + errno + '）',
    details: { errno },
    cause: error,
  })
}

/** 关闭监听并主动断开 keep-alive 连接；重复调用返回同一个 Promise。 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error === undefined) {
        resolve()
        return
      }
      if (errorCode(error) === 'ERR_SERVER_NOT_RUNNING') {
        resolve()
        return
      }
      reject(toXianyuError(error))
    })
    // keep-alive 连接会让 close 一直等；断开后端口才能真正释放。
    server.closeAllConnections()
  })
}

/** 读取 token；不存在则生成 32 字节随机 hex 并以 0600 权限原子创建。 */
async function readOrCreateToken(tokenPath: string): Promise<string> {
  await mkdir(dirname(tokenPath), { recursive: true })
  try {
    return await readTokenFile(tokenPath)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw toXianyuError(error)
  }
  const token = randomBytes(32).toString('hex')
  try {
    // wx：原子创建，避免两个 daemon 同时初始化时互相覆盖 token。
    await writeFile(tokenPath, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return token
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw toXianyuError(error)
    // 另一个 daemon 抢先创建：读它写下的 token，保证两侧一致。
    try {
      return await readTokenFile(tokenPath)
    } catch (readError) {
      throw toXianyuError(readError)
    }
  }
}

async function readTokenFile(tokenPath: string): Promise<string> {
  const token = (await readFile(tokenPath, 'utf8')).trim()
  // 空 token 意味着所有请求都会 401；不静默重建，免得轮换掉正在使用的 token。
  if (token.length === 0) fail('INTERNAL', 'token 文件为空：' + tokenPath + '（删除后由 daemon 重新生成）')
  return token
}

/** 取 Node 系统错误的 code（ENOENT / EADDRINUSE / ERR_SERVER_NOT_RUNNING…）。 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}