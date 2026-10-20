/**
 * daemon 的 HTTP 客户端：DSH 插件与测试共用的一条入口。
 *
 * 为什么每次请求都重读 token 文件：daemon 可能在运行期重建 token（删文件后重启），
 * 客户端缓存 token 会静默 401；多读一次小文件的代价远小于排查 401。
 * @module @bigfish/daemon/client
 */
import { readFile } from 'node:fs/promises'

import { ERROR_CODES, XianyuError, fail } from '@bigfish/core'
import type { DaemonStatus, EnqueueInput, ItemSummary, TaskFilter, TaskRecord } from '@bigfish/core'

/** 单个请求的默认超时（毫秒），与 AGENTS.md 的 IO 超时约定一致。 */
const DEFAULT_TIMEOUT_MS = 15_000

/** 客户端构造参数；fetchImpl 注入用于测试与代理场景。 */
export interface DaemonClientOptions {
  /** daemon 基地址，如 http://127.0.0.1:47001。 */
  baseUrl: string
  /** Bearer token 文件路径；每次请求重新读取。 */
  tokenPath: string
  /** 单请求超时（毫秒），默认 15s。 */
  timeoutMs?: number
  /** fetch 实现注入点，默认全局 fetch。 */
  fetchImpl?: typeof fetch
}

/** GET /health 的返回体。 */
export interface HealthPayload {
  version: string
  uptimeMs: number
  pid: number
}

type FetchLike = typeof fetch
type HttpMethod = 'GET' | 'POST'

/** daemon HTTP 客户端。 */
export class DaemonClient {
  private readonly baseUrl: string
  private readonly tokenPath: string
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(options: DaemonClientOptions) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl)
    this.tokenPath = options.tokenPath
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** 健康检查；公开路由，不带 token。 */
  async health(): Promise<HealthPayload> {
    return this.request<HealthPayload>('GET', '/health', false)
  }

  async status(): Promise<DaemonStatus> {
    return this.request<DaemonStatus>('GET', '/status', true)
  }

  async listTasks(filter: TaskFilter = {}): Promise<TaskRecord[]> {
    return this.request<TaskRecord[]>('GET', '/tasks' + tasksQuery(filter), true)
  }

  async getTask(id: string): Promise<TaskRecord> {
    return this.request<TaskRecord>('GET', '/tasks/' + encodeURIComponent(id), true)
  }

  async enqueue(input: EnqueueInput): Promise<TaskRecord> {
    return this.request<TaskRecord>('POST', '/tasks', true, input)
  }

  async ack(id: string, owner: string): Promise<TaskRecord> {
    return this.request<TaskRecord>('POST', taskActionPath(id, 'ack'), true, { owner })
  }

  async fail(id: string, owner: string, error: string, nonRetryable?: boolean): Promise<TaskRecord> {
    const body = nonRetryable === undefined ? { owner, error } : { owner, error, nonRetryable }
    return this.request<TaskRecord>('POST', taskActionPath(id, 'fail'), true, body)
  }

  async release(id: string, owner: string): Promise<TaskRecord> {
    return this.request<TaskRecord>('POST', taskActionPath(id, 'release'), true, { owner })
  }

  /** P0 固定返回空数组；P1 接 store 后由 daemon 返回真实商品摘要。 */
  async listItems(): Promise<ItemSummary[]> {
    return this.request<ItemSummary[]>('GET', '/items', true)
  }

  /** 发请求 + 解信封；所有错误都转成 XianyuError。 */
  private async request<T>(method: HttpMethod, path: string, auth: boolean, body?: unknown): Promise<T> {
    const url = this.baseUrl + path
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (auth) headers.Authorization = 'Bearer ' + (await this.readToken())
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw networkError(url, error, this.timeoutMs)
    }
    return readEnvelope<T>(response, url)
  }

  /** 读 token 文件；缺失或为空都是 UNAUTHORIZED（配置问题，不是网络问题）。 */
  private async readToken(): Promise<string> {
    let raw: string
    try {
      raw = await readFile(this.tokenPath, 'utf8')
    } catch (error) {
      throw new XianyuError({ code: 'UNAUTHORIZED', message: '无法读取 daemon token 文件：' + this.tokenPath, cause: error })
    }
    const token = raw.trim()
    if (token.length === 0) fail('UNAUTHORIZED', 'daemon token 文件为空：' + this.tokenPath)
    return token
  }
}

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end -= 1
  return value.slice(0, end)
}

function taskActionPath(id: string, action: 'ack' | 'fail' | 'release'): string {
  return '/tasks/' + encodeURIComponent(id) + '/' + action
}

/** 把 TaskFilter 拼成查询串；undefined 字段不出现在 URL 里。 */
function tasksQuery(filter: TaskFilter): string {
  const parts: string[] = []
  if (filter.state !== undefined) parts.push('state=' + encodeURIComponent(filter.state))
  if (filter.kind !== undefined) parts.push('kind=' + encodeURIComponent(filter.kind))
  if (filter.limit !== undefined) parts.push('limit=' + String(filter.limit))
  return parts.length === 0 ? '' : '?' + parts.join('&')
}

/** 网络层失败（含超时）；message 带 URL，但绝不放 Authorization 头。 */
function networkError(url: string, error: unknown, timeoutMs: number): XianyuError {
  const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
  const reason = timedOut ? '请求超时（' + String(timeoutMs) + 'ms）' : error instanceof Error ? error.message : String(error)
  return new XianyuError({ code: 'NETWORK', message: '无法访问 daemon：' + url + '（' + reason + '）', cause: error })
}

/** 解析 ApiResult 信封：成功取 data，失败按 error.code 还原 XianyuError。 */
async function readEnvelope<T>(response: Response, url: string): Promise<T> {
  const text = await response.text()
  const payload = parseJson(text)
  if (payload === undefined) {
    throw new XianyuError({
      code: response.ok ? 'INTERNAL' : 'NETWORK',
      message: 'daemon 返回的不是合法 JSON（HTTP ' + String(response.status) + '）：' + url,
      details: { httpStatus: response.status },
    })
  }
  if (response.ok && isRecord(payload) && payload.ok === true) return payload.data as T
  throw envelopeError(payload, response.status)
}

function envelopeError(payload: unknown, status: number): XianyuError {
  const record = isRecord(payload) ? payload : {}
  const rawError = record.ok === false && isRecord(record.error) ? record.error : {}
  const rawCode = typeof rawError.code === 'string' && ERROR_CODES.has(rawError.code as never) ? rawError.code : 'INTERNAL'
  const message = typeof rawError.message === 'string' ? rawError.message : 'daemon 请求失败（HTTP ' + String(status) + '）'
  const retryable = typeof rawError.retryable === 'boolean' ? rawError.retryable : undefined
  return new XianyuError({
    code: rawCode as XianyuError['code'],
    message,
    details: { httpStatus: status },
    ...(retryable === undefined ? {} : { retryable }),
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
