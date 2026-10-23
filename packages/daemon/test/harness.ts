/**
 * daemon HTTP 测试夹具：临时数据目录 + 真实 HTTP 服务 + 客户端 + 原始请求助手。
 *
 * 为什么起真服务而不是 mock：鉴权头、Content-Type、413、404 这些行为只在真实
 * node:http 生命周期里成立。每个用例 after 里 close 服务并删临时目录。
 * @module @bigfish/daemon/test/harness
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDaemonConfig } from '@bigfish/core'
import type { CircuitBreaker, DaemonConfig, ItemRepository, TaskEventSink, TaskRecord } from '@bigfish/core'

import { DaemonClient } from '../src/client.ts'
import { startDaemon } from '../src/server.ts'
import type { Daemon } from '../src/server.ts'
import type {
  ImportAccountHandler,
  LoginAccountHandler,
  ReferenceCollectHandler,
  RequestShutdown,
  RetryTaskHandler,
  VerifyAccountHandler,
} from '../src/routes.ts'
import type { SettingsStore } from '../src/settings.ts'
import type { AccountSummary } from '../src/account-list.ts'
import { FakeQueue } from './fake-queue.ts'

/** 临时目录根：.scratch 已 gitignore，仓库根下便于排查残留。 */
const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-http/', import.meta.url))

/** 原始请求参数；token 缺省读 token 文件，null 表示不带 Authorization。 */
export interface RawRequest {
  method: string
  path: string
  token?: string | null
  headers?: Record<string, string>
  body?: string | Uint8Array
  contentType?: string
}

/** 原始响应。 */
export interface RawResponse {
  status: number
  contentType: string
  text: string
  body: unknown
}

/** 夹具对象。 */
export interface DaemonHarness {
  readonly daemon: Daemon
  readonly client: DaemonClient
  readonly config: DaemonConfig
  readonly queue: FakeQueue
  readonly items: ItemRepository | undefined
  readonly baseUrl: string
  readonly tokenPath: string
  now(): number
  setNow(value: number): void
  token(): Promise<string>
  rawRequest(input: RawRequest): Promise<RawResponse>
}

export interface HarnessOptions {
  version?: string
  /** 注入商品表以测试 GET /items 的过滤；缺省时不注入。 */
  items?: ItemRepository
  /** 已保存账号列表提供者（测试 /status.accounts）。 */
  accounts?: () => string[]
  /** 熔断器（测试 /status.circuits 与 /circuits/reset）。 */
  circuits?: CircuitBreaker
  /** 账号导入能力（测试 POST /accounts/import）；缺省时不注入，路由应返回 UNSUPPORTED。 */
  importAccount?: ImportAccountHandler
  /** 扫码登录能力（测试 POST /accounts/login）；缺省时不注入，路由应返回 UNSUPPORTED。 */
  loginAccount?: LoginAccountHandler
  /** 登录态校验能力（测试 POST /accounts/:id/verify）；缺省时不注入，路由应返回 UNSUPPORTED。 */
  verifyAccount?: VerifyAccountHandler
  /** 账号摘要能力（测试 GET /accounts）；缺省时不注入，路由应返回空数组。 */
  accountSummaries?: () => Promise<AccountSummary[]>
  /** 人工重新入队能力；缺省时接 FakeQueue.requeue，保证路由测试覆盖真实状态校验。 */
  retryTask?: RetryTaskHandler
  /** 参考采集能力（测试 POST /reference）；缺省时不注入，路由应返回 UNSUPPORTED。 */
  referenceCollect?: ReferenceCollectHandler
  /** 设置存储（测试 GET/PUT /settings）；缺省时不注入，路由应返回 UNSUPPORTED。 */
  settings?: SettingsStore
  /** 优雅关停能力（测试 POST /shutdown）；缺省时不注入，路由应返回 UNSUPPORTED。 */
  requestShutdown?: RequestShutdown
  /** 任务事件流（测试 GET /events）；缺省时不注入，路由应返回 UNSUPPORTED。 */
  events?: TaskEventSink
}

/** 建夹具；t.after 负责关服务与清理目录。 */
export async function createHarness(t: { after(fn: () => Promise<void>): void }, options: HarnessOptions = {}): Promise<DaemonHarness> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'run-'))
  const loaded = loadDaemonConfig({}, {
    dbPath: join(dir, 'bigfish.db'),
    credentialsDir: join(dir, 'credentials'),
    circuitPath: join(dir, 'circuits.json'),
    tokenPath: join(dir, 'daemon.token'),
  })
  // port=0：由系统分配，避免并行测试抢 47001；core 的配置校验不接受 0，所以这里覆盖。
  const config: DaemonConfig = { ...loaded, port: 0 }
  let nowMs = 1_700_000_000_000
  const queue = new FakeQueue({ now: (): number => nowMs })
  const daemon = await startDaemon({
    config,
    queue,
    now: (): number => nowMs,
    version: options.version ?? '9.9.9',
    ...(options.items === undefined ? {} : { items: options.items }),
    ...(options.accounts === undefined ? {} : { accounts: options.accounts }),
    ...(options.circuits === undefined ? {} : { circuits: options.circuits }),
    ...(options.importAccount === undefined ? {} : { importAccount: options.importAccount }),
    ...(options.accountSummaries === undefined ? {} : { accountSummaries: options.accountSummaries }),
    ...(options.loginAccount === undefined ? {} : { loginAccount: options.loginAccount }),
    ...(options.verifyAccount === undefined ? {} : { verifyAccount: options.verifyAccount }),
    // 默认接 FakeQueue 的真 requeue：路由测试覆盖「状态校验 → 记录变更 → 200」整条路径；
    // 需要断言注入是否被调用（例如唤醒 worker）时再用 options.retryTask 覆盖。
    retryTask: options.retryTask ?? ((id: string): TaskRecord => queue.requeue(id)),
    ...(options.referenceCollect === undefined ? {} : { referenceCollect: options.referenceCollect }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.requestShutdown === undefined ? {} : { requestShutdown: options.requestShutdown }),
    ...(options.events === undefined ? {} : { events: options.events }),
  })
  const client = new DaemonClient({ baseUrl: daemon.url, tokenPath: config.tokenPath })
  const baseUrl = daemon.url
  const tokenPath = config.tokenPath

  const token = async (): Promise<string> => (await readFile(tokenPath, 'utf8')).trim()

  const rawRequest = async (input: RawRequest): Promise<RawResponse> => {
    const headers: Record<string, string> = { accept: 'application/json', ...input.headers }
    if (input.contentType !== undefined) headers['content-type'] = input.contentType
    else if (input.body !== undefined) headers['content-type'] = 'application/json'
    const bearer = input.token === undefined ? await token() : input.token
    if (bearer !== null) headers.authorization = 'Bearer ' + bearer
    const init: RequestInit = { method: input.method, headers }
    if (input.body !== undefined) init.body = input.body
    const response = await fetch(baseUrl + input.path, init)
    const text = await response.text()
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', text, body: parseJson(text) }
  }

  t.after(async (): Promise<void> => {
    await daemon.close()
    await rm(dir, { recursive: true, force: true })
  })

  return {
    daemon,
    client,
    config,
    queue,
    items: options.items,
    baseUrl,
    tokenPath,
    now: (): number => nowMs,
    setNow: (value: number): void => {
      nowMs = value
    },
    token,
    rawRequest,
  }
}

/** 收窄成对象，失败即断言错误（测试专用）。 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('期望 JSON 对象，实际为：' + JSON.stringify(value))
  }
  return value as Record<string, unknown>
}

/** 取成功信封里的 data；断言 ok:true。 */
export function dataOf(response: RawResponse): unknown {
  const envelope = asRecord(response.body)
  if (envelope.ok !== true) throw new TypeError('期望成功信封，实际为：' + response.text)
  return envelope.data
}

/** 取失败信封里的 error；断言 ok:false。 */
export function errorOf(response: RawResponse): { code: string; message: string; retryable: boolean } {
  const envelope = asRecord(response.body)
  if (envelope.ok !== false) throw new TypeError('期望失败信封，实际为：' + response.text)
  const error = asRecord(envelope.error)
  return {
    code: typeof error.code === 'string' ? error.code : '',
    message: typeof error.message === 'string' ? error.message : '',
    retryable: error.retryable === true,
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}