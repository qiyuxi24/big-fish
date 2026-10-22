/**
 * /bigfish 面板 rpc 的 webServer 兼容路由（绕过 DSH 0.1.5-rc.2 的宿主 bug）。
 *
 * 为什么存在：host 的 connection 插件在 register() 里用 **插件自己** 的 ctx 调
 * `owner.webServer.register(route)`，而它的 ctx 没有 inject webServer，所以
 * `connection.rpc.handle('/bigfish', ...)` 必抛 `cannot get property "webServer" without inject`。
 * 官方修好之前，本插件在自己的 ctx 里 inject webServer，按宿主 rpcFetchHandler 的
 * 线上协议（信封 / 状态码 / content-type）复刻一条 prefix 路由，client bundle 一行不用改。
 *
 * 安全边界（fail-closed）：必须先过 `connection.requestRejection(request)` 才继续；
 * 拿不到鉴权入口就不注册路由（由 index.js 判定），绝不在无鉴权情况下暴露 daemon 数据。
 *
 * @module @bigfish/plugin-ops/src/host-route
 */

/** 与宿主 rpc-host.ts 的 CHANNEL_PATTERN 一致；"/api" 是宿主自己的保留前缀。 */
const RPC_CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/

/** 与宿主 ENDPOINT_SEGMENT_PATTERN 一致：endpoint 每一段允许的字符集（不含 percent 解码）。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** 信封不合法且拿不到 rpcId 时回显的占位 rpcId（与宿主 INVALID_REQUEST_RPC_ID 一致）。 */
const INVALID_REQUEST_RPC_ID = 'invalid-request'

/** 单条请求体上限：面板只传小对象，1 MiB 足够，且比宿主默认 300 MiB 更保守。 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** 请求体读超时：客户端卡住不拖死 webServer 连接。 */
const DEFAULT_BODY_TIMEOUT_MS = 15_000

/** 网关层错误码：与宿主 rpcFetchHandler 的 bad-request 保持一致，client 只认稳定 code。 */
const GATEWAY_BAD_REQUEST = 'gateway/bad-request'

/** 判断是否是普通对象（排除 null 与数组），用于信封校验。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验 rpc channel：前缀必须形如 /bigfish，且不能占用宿主保留的 /api。
 *
 * @param {string} channel - 路由前缀。
 * @returns {void}
 */
export function assertRpcChannel(channel) {
  if (typeof channel !== 'string' || !RPC_CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error('非法的 rpc channel：' + String(channel))
  }
}

/**
 * 从 pathname 解析 endpoint；与宿主 endpointFromPath 行为一致（空段 / . / .. / 非法字符一律无效）。
 * 刻意不做 decodeURIComponent：percent 编码不得绕过字符集校验。
 *
 * @param {string} channel - 路由前缀，如 "/bigfish"。
 * @param {string} pathname - 请求路径（不含 query）。
 * @returns {string | undefined} endpoint，非法时 undefined。
 */
export function endpointFromPath(channel, pathname) {
  const prefix = channel + '/'
  if (typeof pathname !== 'string' || !pathname.startsWith(prefix)) return undefined
  const endpoint = pathname.slice(prefix.length)
  for (const segment of endpoint.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return undefined
    if (!ENDPOINT_SEGMENT_PATTERN.test(segment)) return undefined
  }
  return endpoint
}

/** 组装 server-response 信封；result 由 bridge 或网关错误决定。 */
function serverResponse(rpcId, result) {
  return { type: 'server-response', rpcId, result }
}

/** 网关错误 result（HTTP 200，但 result.ok === false）。 */
function gatewayError(rpcId, message) {
  return { ok: false, error: { code: GATEWAY_BAD_REQUEST, message, details: { issues: [] } } }
}

/** 取信封里的 rpcId：能回显就回显，否则用占位值（client 只在成功路径校验回显）。 */
function envelopeRpcId(body) {
  return isRecord(body) && typeof body.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID
}

/** 写纯文本响应（404/415/408/413/500，与宿主 bridge 的文本错误对齐）。 */
function sendText(response, status, message, extraHeaders) {
  if (response.writableEnded || response.destroyed) return
  const headers = { 'content-type': 'text/plain; charset=utf-8', ...extraHeaders }
  response.writeHead(status, headers)
  response.end(message)
}

/** 写 JSON 响应（rpc 信封一律 HTTP 200 + application/json）。 */
function sendJson(response, status, payload) {
  if (response.writableEnded || response.destroyed) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * 读请求体：带大小上限与超时，错误通过 outcome 返回而不抛，方便 handler 逐一映射状态码。
 *
 * @param {import('node:http').IncomingMessage} request - 原始请求。
 * @param {number} maxBytes - 允许的最大字节数。
 * @param {number} timeoutMs - 读超时（毫秒）。
 * @returns {Promise<{ok: true, text: string} | {ok: false, status: number, message: string}>} 读取结果。
 */
function readBody(request, maxBytes, timeoutMs) {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.resolve({ ok: false, status: 413, message: 'payload too large' })
  }
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.removeListener('data', onData)
      request.removeListener('end', onEnd)
      request.removeListener('error', onError)
      resolve(outcome)
    }
    const onData = (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        finish({ ok: false, status: 413, message: 'payload too large' })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    const onError = () => finish({ ok: false, status: 400, message: 'body read failed' })
    const timer = setTimeout(() => finish({ ok: false, status: 408, message: 'body read timeout' }), timeoutMs)
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}

/**
 * 造一条挂在 webServer 上的 prefix 路由：只处理 /bigfish/<endpoint> 的 POST JSON 信封。
 *
 * 校验顺序刻意与宿主 rpcFetchHandler 一致（非 POST / 坏 endpoint → 404，content-type → 415，
 * JSON 解析 → 400，信封 → 200 错误信封，method 不匹配 → 200 错误信封），这样 client 侧
 * `ctx.connection.rpc.call` 的行为与走官方通道时完全一致。
 *
 * @param {object} options - 路由依赖。
 * @param {string} options.channel - rpc 前缀，固定 "/bigfish"。
 * @param {{handle: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>}} options.bridge - createRpcBridge 的返回值。
 * @param {{requestRejection: (request: import('node:http').IncomingMessage) => number | undefined}} options.connection - 宿主 connection 服务（提供鉴权判定）。
 * @param {(error: unknown) => void} [options.onInternalError] - 处理异常时的回调（只记录，不改变响应）。
 * @param {number} [options.maxRequestBodyBytes] - 请求体上限。
 * @param {number} [options.bodyTimeoutMs] - 请求体读超时。
 * @returns {{kind: 'prefix', path: string, handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}} webServer 路由。
 */
export function createPanelRoute(options) {
  const { channel, bridge, connection, onInternalError } = options ?? {}
  assertRpcChannel(channel)
  if (!isRecord(bridge) || typeof bridge.handle !== 'function') {
    throw new Error('createPanelRoute 需要 bridge.handle')
  }
  // fail-closed：没有鉴权判定入口就不允许创建路由，避免 daemon 数据裸奔。
  if (!isRecord(connection) || typeof connection.requestRejection !== 'function') {
    throw new Error('createPanelRoute 需要 connection.requestRejection（无鉴权不暴露 daemon 数据）')
  }
  const maxBytes = Number.isInteger(options.maxRequestBodyBytes) ? options.maxRequestBodyBytes : DEFAULT_MAX_BODY_BYTES
  const timeoutMs = Number.isInteger(options.bodyTimeoutMs) ? options.bodyTimeoutMs : DEFAULT_BODY_TIMEOUT_MS

  const handler = async (request, response) => {
    try {
      // 第一道闸：复用宿主 connection 的信任域 / 登录态判定（403 不可信来源、401 未登录）。
      const rejection = connection.requestRejection(request)
      if (rejection !== undefined) {
        sendText(response, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const pathname = new URL(String(request.url ?? '/'), 'http://127.0.0.1').pathname
      const endpoint = endpointFromPath(channel, pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        sendText(response, 404, 'not found')
        return
      }
      const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendText(response, 415, 'content type must be application/json')
        return
      }
      const body = await readBody(request, maxBytes, timeoutMs)
      if (!body.ok) {
        sendText(response, body.status, body.message, { connection: 'close' })
        request.resume()
        return
      }
      let envelope
      try {
        envelope = JSON.parse(body.text)
      } catch {
        sendText(response, 400, 'body is not JSON')
        return
      }
      // 信封校验与宿主 clientRequestSchema 等价：type 固定、rpcId/method 是 string、payload 任意。
      const valid = isRecord(envelope) && envelope.type === 'client-request'
        && typeof envelope.rpcId === 'string' && typeof envelope.method === 'string'
      if (!valid) {
        sendJson(response, 200, serverResponse(envelopeRpcId(envelope), gatewayError(envelopeRpcId(envelope), 'invalid client-request message')))
        return
      }
      if (envelope.method !== endpoint) {
        const message = 'method ' + JSON.stringify(envelope.method) + ' does not match endpoint ' + JSON.stringify(endpoint)
        sendJson(response, 200, serverResponse(envelope.rpcId, gatewayError(envelope.rpcId, message)))
        return
      }
      const controller = new AbortController()
      const onClose = () => {
        if (!response.writableEnded) controller.abort()
      }
      response.on('close', onClose)
      try {
        const result = await bridge.handle(endpoint, envelope.payload, controller.signal)
        sendJson(response, 200, serverResponse(envelope.rpcId, result))
      } finally {
        response.removeListener('close', onClose)
      }
    } catch (error) {
      if (typeof onInternalError === 'function') onInternalError(error)
      const message = error instanceof Error ? error.message : String(error)
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendText(response, 500, 'handler failure: ' + message)
    }
  }

  return { kind: 'prefix', path: channel, handler }
}
