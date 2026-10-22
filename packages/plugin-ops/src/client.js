/**
 * daemon 的 HTTP 客户端（插件侧唯一的外部依赖面）。
 *
 * 约定：daemon 所有响应都是 { ok: true, data } | { ok: false, error }；
 * 本模块把任何失败都翻译成带稳定 code 的 DaemonError，供工具层转成模型可读文本。
 *
 * @module @bigfish/plugin-ops/client
 */
import { readFile } from 'node:fs/promises'

/** 与 @bigfish/core 的 ErrorCode 保持同构；未知 code 收敛为 INTERNAL。 */
const KNOWN_CODES = new Set([
  'VALIDATION', 'AUTH_EXPIRED', 'RISK_CONTROL', 'RATE_LIMITED', 'CIRCUIT_OPEN',
  'NETWORK', 'STORAGE', 'UNSUPPORTED', 'INTERNAL', 'UNAUTHORIZED',
])

/** daemon 调用失败。code 可以直接展示给模型/用户。 */
export class DaemonError extends Error {
  /**
   * @param {string} code - 稳定错误码。
   * @param {string} message - 面向用户的中文说明。
   * @param {{retryable?: boolean, cause?: unknown}} [options] - 重试语义与底层原因。
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DaemonError'
    this.code = code
    this.retryable = options.retryable ?? false
  }
}

/**
 * 建客户端。所有方法都返回 data 本体，失败抛 DaemonError。
 *
 * @param {{daemonUrl: string, tokenPath: string, timeoutMs?: number, fetchImpl?: typeof fetch, readFileImpl?: typeof readFile}} options
 * @returns {{request: Function, health: Function, status: Function, listTasks: Function, listEvents: Function, enqueue: Function, taskAction: Function, listItems: Function, listAccounts: Function, importAccount: Function, collectReferences: Function, daemonUrl: string, tokenPath: string}}
 */
export function createDaemonClient(options) {
  const { daemonUrl, tokenPath, timeoutMs = 15_000 } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const readFileImpl = options.readFileImpl ?? readFile
  if (typeof fetchImpl !== 'function') throw new TypeError('bigfish-ops: 当前运行环境没有 fetch')

  /** 每次调用都重读 token（daemon 可能轮换），失败给出可操作的提示。 */
  async function readToken() {
    try {
      const token = (await readFileImpl(tokenPath, 'utf8')).trim()
      if (token.length === 0) throw new Error('token 文件为空')
      return token
    } catch (cause) {
      throw new DaemonError('UNAUTHORIZED', `读不到 daemon token：${tokenPath}。先启动 daemon（它会生成 token），或用 dataDir/tokenPath 配置指向正确位置`, { cause })
    }
  }

  async function request(pathname, init = {}) {
    const { method = 'GET', body, auth = true, timeoutMs: callTimeoutMs = timeoutMs } = init
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (auth) headers.authorization = `Bearer ${await readToken()}`

    let response
    try {
      response = await fetchImpl(new URL(pathname, daemonUrl), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(callTimeoutMs),
      })
    } catch (cause) {
      const timedOut = cause?.name === 'TimeoutError'
      throw new DaemonError(
        'NETWORK',
        timedOut
          ? `daemon 请求超时（${callTimeoutMs}ms）：${pathname}`
          : `连不上 daemon：${daemonUrl}（是否已启动？日程可先跑 xy_daemon_health 检查）`,
        { retryable: true, cause },
      )
    }

    let payload
    try {
      payload = await response.json()
    } catch (cause) {
      throw new DaemonError('INTERNAL', `daemon 返回非 JSON 响应（HTTP ${response.status}）：${pathname}`, { cause })
    }
    if (payload === null || typeof payload !== 'object') {
      throw new DaemonError('INTERNAL', `daemon 响应结构非法（HTTP ${response.status}）：${pathname}`)
    }
    if (response.status === 401) {
      throw new DaemonError('UNAUTHORIZED', `daemon 拒绝访问：token 不匹配或已轮换（${tokenPath}）`)
    }
    if (payload.ok === false) {
      const error = payload.error ?? {}
      const code = KNOWN_CODES.has(error.code) ? error.code : 'INTERNAL'
      throw new DaemonError(code, String(error.message ?? 'daemon 返回错误'), { retryable: Boolean(error.retryable) })
    }
    if (!response.ok) {
      throw new DaemonError('INTERNAL', `daemon 返回 HTTP ${response.status}：${pathname}`)
    }
    return payload.data
  }

  return {
    daemonUrl,
    tokenPath,
    request,
    health: () => request('/health', { auth: false }),
    status: () => request('/status'),
    listTasks: (filter = {}) => {
      const query = new URLSearchParams()
      if (filter.state) query.set('state', String(filter.state))
      if (filter.kind) query.set('kind', String(filter.kind))
      if (filter.limit !== undefined) query.set('limit', String(filter.limit))
      const suffix = query.size > 0 ? `?${query.toString()}` : ''
      return request(`/tasks${suffix}`)
    },
    // 步骤事件流：since 是排他游标，返回 {items, nextSince}；面板据此增量刷新「现在在干嘛」。
    listEvents: (filter = {}) => {
      const query = new URLSearchParams()
      if (filter.since !== undefined) query.set('since', String(filter.since))
      if (filter.limit !== undefined) query.set('limit', String(filter.limit))
      if (filter.taskId) query.set('taskId', String(filter.taskId))
      if (filter.batchId) query.set('batchId', String(filter.batchId))
      const suffix = query.size > 0 ? `?${query.toString()}` : ''
      return request(`/events${suffix}`)
    },
    enqueue: (input) => request('/tasks', { method: 'POST', body: input }),
    getTask: (id) => request(`/tasks/${encodeURIComponent(id)}`),
    taskAction: (id, action, body = {}) => request(`/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', body }),
    // 批次进度：一次批量发布的聚合视图（总量 + 五状态计数 + 明细）。
    getBatch: (id) => request(`/batches/${encodeURIComponent(id)}`),
    // 设置落在 daemon 的 settings.json；PUT 只接受补丁（缺省字段保持不变）。
    getSettings: () => request('/settings'),
    putSettings: (patch) => request('/settings', { method: 'PUT', body: patch }),
    listItems: () => request('/items'),
    // 只读摘要：账号 id / 更新时间 / 字段数 / 是否可用，不含任何 cookie 值。
    listAccounts: () => request('/accounts'),
    // 登录态导入是写操作（落加密凭据），插件侧门禁会先拦一次人工确认。
    importAccount: (input = {}) => request('/accounts/import', { method: 'POST', body: input }),
    // 参考采集是只读统计（最坏 20 件串行，每件一次 mtop 调用），单独放宽超时。
    collectReferences: (input = {}) => request('/reference', { method: 'POST', body: input, timeoutMs: 90_000 }),
  }
}
