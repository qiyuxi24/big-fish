/**
 * client ↔ host rpc 桥：面板（client bundle）经宿主通道请求「读数据 / 触发动作」。
 * 为什么要这一层：
 * - client bundle 不能 fetch、不能读文件（AGENTS §4），面板要看实时队列/账号/批次只能经宿主；
 * - 宿主给第三方插件唯一受支持的通道是 \`ctx.connection.rpc.handle(频道, handler)\`，
 *   不能复用 /api（DSH Gateway 已占用，rpc.intercept 会抛错，见 docs/adr/0004）；
 * - 边界在这一层：daemon HTTP 调用、字段白名单、写操作 confirm 全部留在 host，
 *   面板永远拿不到 cookie / token，也拼不出白名单之外的请求。
 * handler 永不抛错：成功 \`{ok:true,value}\`，失败 \`{ok:false,error:{code,message,details?}}\`。
 * 端点白名单与 payload 形状见 docs/adr/0004-client-host-rpc.md（client 侧按同一份契约调用）。
 *
 * @module @bigfish/plugin-ops/rpc
 */
import { startDaemon, stopDaemon } from './daemon-control.js'

/**
 * 自定义 rpc 频道。不能用 '/api'：DSH Gateway 已把它注册成 interceptor，
 * 再 rpc.intercept('/api') 会直接抛「channel already has an interceptor」。
 */
export const RPC_CHANNEL = '/bigfish'

/** 与 daemon 客户端同构的错误码；未知 code 收敛为 INTERNAL，避免把内部字符串透给面板。 */
const KNOWN_CODES = new Set([
  'VALIDATION', 'AUTH_EXPIRED', 'RISK_CONTROL', 'RATE_LIMITED', 'CIRCUIT_OPEN',
  'NETWORK', 'STORAGE', 'UNSUPPORTED', 'INTERNAL', 'UNAUTHORIZED',
])

const TASK_STATES = new Set(['queued', 'leased', 'done', 'failed', 'needs_review'])
const TASK_KINDS = new Set(['publish', 'deliver', 'polish', 'reply', 'probe'])
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const BATCH_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const ITEM_ID_RE = /^\d{1,20}$/
const MAX_BATCH_ITEMS = 20
const MAX_REFERENCE_ITEMS = 20
const PUBLISH_MIN_INTERVAL_MS = 180_000
const PUBLISH_MIN_INTERVAL_MIN_MS = 30_000
const PUBLISH_MIN_INTERVAL_MAX_MS = 3_600_000
const MAX_BATCH_ITEMS_LIMIT = 20
const LOGIN_TIMEOUT_MAX_MS = 180_000
/** 停止 daemon 后的存活探测：250ms 一次、最多 10 秒。 */
const STOP_POLL_INTERVAL_MS = 250
const STOP_POLL_TIMEOUT_MS = 10_000
const STOP_HEALTH_TIMEOUT_MS = 800
/** 扫码登录是长轮询（daemon 等到 180s），HTTP 超时必须比它再宽一点。 */
const LOGIN_REQUEST_MARGIN_MS = 20_000
const IMPORT_TIMEOUT_MS = 120_000
/** settings 的可写字段；不在这张表里的键一律拒绝（未知字段不转发）。 */
const SETTINGS_FIELDS = new Set([
  'copyStyle', 'defaultCategory', 'defaultAddress', 'shipping',
  'publishMinIntervalMs', 'maxBatchItems', 'imageProvider',
])

/**
 * 写类端点：必须 payload.confirm === true 才放行。
 * 面板误触/模型幻觉都可能带上写参数；confirm 是 host 侧唯一能确认「人真的点了」的信号。
 */
const WRITE_ENDPOINTS = new Set([
  'tasks.retry', 'accounts.import', 'accounts.login', 'batch.enqueue', 'settings.put',
  // 停 daemon 会中断正在执行的任务：和写闲鱼一样要求 confirm:true。
  'daemon.stop',
])


/** 字段校验失败：只在 host 内部抛，handle() 会翻译成 VALIDATION 信封。 */
class RpcPayloadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RpcPayloadError'
    this.code = 'VALIDATION'
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bad(message) {
  throw new RpcPayloadError(message)
}

function failEnvelope(code, message) {
  return { ok: false, error: { code, message } }
}

/** 任何异常都翻译成信封；details 只在确实是对象时透出（字符串细节会破坏客户端解析）。 */
function errorEnvelope(error) {
  const rawCode = error === null || error === undefined ? undefined : error.code
  const code = typeof rawCode === 'string' && KNOWN_CODES.has(rawCode) ? rawCode : 'INTERNAL'
  const message = error instanceof Error ? error.message : 'rpc 调用失败：' + String(error).slice(0, 200)
  const details = isRecord(error) && isRecord(error.details) ? error.details : undefined
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } }
}

function readRequiredString(body, field, pattern) {
  const raw = body[field]
  if (typeof raw !== 'string' || raw.trim().length === 0) bad(field + ' 必须是非空字符串')
  const value = raw.trim()
  if (pattern !== undefined && !pattern.test(value)) bad(field + ' 格式非法：' + value.slice(0, 40))
  return value
}

function readOptionalString(body, field, maxLength) {
  const raw = body[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') bad(field + ' 必须是字符串')
  const value = raw.trim()
  if (value.length === 0) bad(field + ' 不能为空')
  if (value.length > maxLength) bad(field + ' 最长 ' + maxLength + ' 个字符')
  return value
}

function readOptionalPort(body) {
  const raw = body.port
  if (raw === undefined || raw === null) return undefined
  return readIntegerValue(raw, 'port', 1, 65_535)
}

function readIntegerValue(raw, field, min, max) {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) bad(field + ' 必须是整数')
  if (raw < min || raw > max) bad(field + ' 必须在 ' + min + '..' + max + ' 之间')
  return raw
}

function readTaskFilter(body) {
  const filter = {}
  if (body.state !== undefined) {
    if (typeof body.state !== 'string' || !TASK_STATES.has(body.state)) bad('state 非法：' + String(body.state).slice(0, 40))
    filter.state = body.state
  }
  if (body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !TASK_KINDS.has(body.kind)) bad('kind 非法：' + String(body.kind).slice(0, 40))
    filter.kind = body.kind
  }
  if (body.limit !== undefined) filter.limit = readIntegerValue(body.limit, 'limit', 1, 200)
  return filter
}

function readReferenceInput(body) {
  const input = { accountId: readRequiredString(body, 'accountId', ACCOUNT_ID_RE) }
  if (body.itemIds !== undefined) {
    if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) bad('itemIds 必须是非空数组')
    if (body.itemIds.length > MAX_REFERENCE_ITEMS) bad('itemIds 最多 ' + MAX_REFERENCE_ITEMS + ' 条')
    const ids = []
    for (const entry of body.itemIds) {
      const id = readItemId(entry)
      if (!ids.includes(id)) ids.push(id)
    }
    input.itemIds = ids
  }
  if (body.sellerId !== undefined) input.sellerId = readItemId(body.sellerId)
  if (input.itemIds === undefined && input.sellerId === undefined) bad('reference.collect 需要 itemIds 或 sellerId 至少一个')
  return input
}

function readItemId(raw) {
  if (typeof raw !== 'string' || !ITEM_ID_RE.test(raw.trim())) bad('itemId/sellerId 必须是纯数字串：' + String(raw).slice(0, 40))
  return raw.trim()
}

function readEnqueueItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) bad('items 必须是非空数组')
  if (raw.length > MAX_BATCH_ITEMS) bad('items 一次最多 ' + MAX_BATCH_ITEMS + ' 条，收到 ' + raw.length)
  return raw.map((entry, index) => readEnqueueItem(entry, index))
}

function readEnqueueItem(entry, index) {
  const where = 'items[' + index + ']'
  if (!isRecord(entry)) bad(where + ' 必须是对象')
  if (typeof entry.kind !== 'string' || !TASK_KINDS.has(entry.kind)) bad(where + '.kind 非法：' + String(entry.kind).slice(0, 40))
  if (!isRecord(entry.payload)) bad(where + '.payload 必须是对象')
  const item = { kind: entry.kind, dedupeKey: readRequiredString(entry, 'dedupeKey', undefined), payload: entry.payload }
  if (entry.availableAt !== undefined) item.availableAt = readIntegerValue(entry.availableAt, where + '.availableAt', 0, Number.MAX_SAFE_INTEGER)
  if (entry.maxAttempts !== undefined) item.maxAttempts = readIntegerValue(entry.maxAttempts, where + '.maxAttempts', 1, 10)
  assertJson(item, where)
  return item
}

/** 入队载荷最终会落 SQLite；等到 daemon 报错不如在边界就说清哪个字段不可序列化。 */
function assertJson(value, where) {
  try {
    JSON.stringify(value)
  } catch {
    bad(where + ' 必须可 JSON 序列化')
  }
}

function readSettingsPatch(raw) {
  if (!isRecord(raw)) bad('settings.put 需要 patch 对象')
  const keys = Object.keys(raw)
  if (keys.length === 0) bad('patch 不能为空')
  const patch = {}
  for (const key of keys) {
    if (!SETTINGS_FIELDS.has(key)) bad('settings 不支持字段：' + key.slice(0, 40))
    const value = raw[key]
    if (key === 'publishMinIntervalMs') patch[key] = readIntegerValue(value, key, PUBLISH_MIN_INTERVAL_MIN_MS, PUBLISH_MIN_INTERVAL_MAX_MS)
    else if (key === 'maxBatchItems') patch[key] = readIntegerValue(value, key, 1, MAX_BATCH_ITEMS_LIMIT)
    else if (key === 'imageProvider') patch[key] = readImageProvider(value)
    else if (key === 'shipping') patch[key] = readShipping(value)
    else patch[key] = readSettingsText(value, key)
  }
  return patch
}

function readSettingsText(value, field) {
  if (typeof value !== 'string') bad(field + ' 必须是字符串')
  const text = value.trim()
  if (text.length === 0) bad(field + ' 不能为空')
  if (text.length > 200) bad(field + ' 最长 200 个字符')
  return text
}

function readShipping(value) {
  if (typeof value === 'boolean') return value
  return readSettingsText(value, 'shipping')
}

function readImageProvider(value) {
  if (!isRecord(value)) bad('imageProvider 必须是对象')
  const allowed = new Set(['endpointUrl', 'model', 'enabled'])
  const out = {}
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) bad('imageProvider 不支持字段：' + key.slice(0, 40))
    if (key === 'enabled') {
      if (typeof value.enabled !== 'boolean') bad('imageProvider.enabled 必须是布尔')
      out.enabled = value.enabled
      continue
    }
    const text = readSettingsText(value[key], 'imageProvider.' + key)
    if (key === 'endpointUrl' && text.length > 2_048) bad('imageProvider.endpointUrl 最长 2048 个字符')
    if (key === 'model' && text.length > 120) bad('imageProvider.model 最长 120 个字符')
    out[key] = text
  }
  return out
}

/** 串行入队：单账号写串行（AGENTS §1.3），并发 enqueue 会让去重与 availableAt 交错。 */
async function enqueueSequentially(client, items, batchId) {
  const results = []
  for (const item of items) {
    results.push(await client.enqueue(batchId === undefined ? item : { ...item, batchId }))
  }
  return results
}

function extractTask(result) {
  return isRecord(result) && isRecord(result.task) ? result.task : result
}

function extractCreated(result) {
  return isRecord(result) && typeof result.created === 'boolean' ? result.created : null
}

function summarizeEnqueue(batchId, results) {
  return {
    batchId: batchId === undefined ? null : batchId,
    tasks: results.map(extractTask),
    created: results.map(extractCreated),
  }
}

function storeMethod(settingsStore, primary, fallback) {
  if (settingsStore === undefined || settingsStore === null) return undefined
  for (const name of [primary, fallback]) {
    if (typeof settingsStore[name] === 'function') return settingsStore[name].bind(settingsStore)
  }
  return undefined
}

function readSettingsEndpoint(settingsStore, client) {
  const read = storeMethod(settingsStore, 'read', 'get')
  if (read !== undefined) return read()
  // daemon 侧 GET /settings（lead 负责接线）；客户端还没加同名方法时走通用 request。
  return client.request('/settings')
}

function writeSettingsEndpoint(settingsStore, client, patch) {
  const write = storeMethod(settingsStore, 'write', 'update')
  if (write !== undefined) return write(patch)
  return client.request('/settings', { method: 'PUT', body: patch })
}

function retryTaskEndpoint(client, id) {
  if (typeof client.retryTask === 'function') return client.retryTask(id)
  return client.request('/tasks/' + encodeURIComponent(id) + '/retry', { method: 'POST' })
}

function getBatchEndpoint(client, id) {
  if (typeof client.getBatch === 'function') return client.getBatch(id)
  return client.request('/batches/' + encodeURIComponent(id))
}

function importAccountEndpoint(client, body) {
  const input = {}
  const accountId = readOptionalString(body, 'accountId', 64)
  if (accountId !== undefined) {
    if (!ACCOUNT_ID_RE.test(accountId)) bad('accountId 格式非法：' + accountId.slice(0, 40))
    input.accountId = accountId
  }
  const port = readOptionalPort(body)
  if (port !== undefined) input.port = port
  if (typeof client.importAccount === 'function') return client.importAccount(input)
  return client.request('/accounts/import', { method: 'POST', body: input, timeoutMs: IMPORT_TIMEOUT_MS })
}

function loginAccountEndpoint(client, body) {
  const input = {}
  const accountId = readOptionalString(body, 'accountId', 64)
  if (accountId !== undefined) {
    if (!ACCOUNT_ID_RE.test(accountId)) bad('accountId 格式非法：' + accountId.slice(0, 40))
    input.accountId = accountId
  }
  const port = readOptionalPort(body)
  if (port !== undefined) input.port = port
  if (body.timeoutMs !== undefined) input.timeoutMs = readIntegerValue(body.timeoutMs, 'timeoutMs', 1, LOGIN_TIMEOUT_MAX_MS)
  if (typeof client.loginAccount === 'function') return client.loginAccount(input)
  const timeoutMs = (input.timeoutMs === undefined ? LOGIN_TIMEOUT_MAX_MS : input.timeoutMs) + LOGIN_REQUEST_MARGIN_MS
  return client.request('/accounts/login', { method: 'POST', body: input, timeoutMs })
}

function enqueueBatchEndpoint(client, body) {
  const batchId = readOptionalString(body, 'batchId', 64)
  if (batchId !== undefined && !BATCH_ID_RE.test(batchId)) bad('batchId 格式非法：' + batchId.slice(0, 40))
  const items = readEnqueueItems(body.items)
  return enqueueSequentially(client, items, batchId).then((results) => summarizeEnqueue(batchId, results))
}

/** 默认端点表；handler 只做「白名单字段 → 形状校验 → daemon 调用」，业务校验留给 daemon。 */
function createDefaultHandlers(options) {
  const client = options.client
  const settingsStore = options.settingsStore
  return {
    health: () => client.health(),
    status: () => client.status(),
    accounts: () => client.listAccounts(),
    'items.list': () => client.listItems(),
    'tasks.list': (body) => client.listTasks(readTaskFilter(body)),
    'tasks.retry': (body) => retryTaskEndpoint(client, readRequiredString(body, 'id', ID_RE)),
    'batches.get': (body) => getBatchEndpoint(client, readRequiredString(body, 'id', ID_RE)),
    'reference.collect': (body) => client.collectReferences(readReferenceInput(body)),
    'settings.get': () => readSettingsEndpoint(settingsStore, client),
    'settings.put': (body) => writeSettingsEndpoint(settingsStore, client, readSettingsPatch(body.patch)),
    'accounts.import': (body) => importAccountEndpoint(client, body),
    'accounts.login': (body) => loginAccountEndpoint(client, body),
    'batch.enqueue': (body) => enqueueBatchEndpoint(client, body),
    // 面板「进程管理」按钮：start 让宿主拉起 daemon（跳过冷却，人点了就要试），
    // stop 是写操作（会打断在飞任务），因此挂在 WRITE_ENDPOINTS 后面等 confirm。
    'daemon.start': () => startDaemon(options.supervisor),
    'daemon.stop': () => stopDaemon(client),
  }
}

/** endpoints 选项：给嵌入方/测试覆盖或追加端点；只能传函数。 */
function readOverrides(raw) {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) throw new TypeError('createRpcBridge: endpoints 必须是对象')
  const overrides = {}
  for (const [name, handler] of Object.entries(raw)) {
    if (typeof handler !== 'function') throw new TypeError('createRpcBridge: endpoints.' + name + ' 必须是函数')
    overrides[name] = handler
  }
  return overrides
}

/**
 * 建 rpc 桥。
 *
 * @param {{client: object, settingsStore?: {read?: Function, get?: Function, write?: Function, update?: Function}, supervisor?: {ensure(reason?: string, options?: {force?: boolean}): Promise<object>}, endpoints?: Record<string, Function>}} options
 *   client 是 createDaemonClient 的返回值；settingsStore 可选（有它就不走 daemon HTTP）；
 *   supervisor 提供「启动 daemon」能力（面板按钮）；endpoints 覆盖默认表（测试/嵌入）。
 * @returns {{handle: (endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<{ok: boolean, value?: unknown, error?: {code: string, message: string, details?: object}}>, endpoints: readonly string[], channel: string}}
 */
export function createRpcBridge(options = {}) {
  if (!isRecord(options) || options.client === undefined || options.client === null || typeof options.client !== 'object') {
    throw new TypeError('createRpcBridge 需要 daemon 客户端（client）')
  }
  const handlers = {
    ...createDefaultHandlers({ client: options.client, settingsStore: options.settingsStore, supervisor: options.supervisor }),
    ...readOverrides(options.endpoints),
  }
  const endpoints = Object.freeze(Object.keys(handlers))

  async function handle(endpoint, payload, signal) {
    try {
      const handler = typeof endpoint === 'string' && Object.prototype.hasOwnProperty.call(handlers, endpoint) ? handlers[endpoint] : undefined
      if (handler === undefined) return failEnvelope('UNSUPPORTED', '不支持的 rpc endpoint：' + String(endpoint).slice(0, 80))
      const body = payload === undefined || payload === null ? {} : payload
      if (!isRecord(body)) return failEnvelope('VALIDATION', 'rpc payload 必须是对象')
      if (WRITE_ENDPOINTS.has(endpoint) && body.confirm !== true) return failEnvelope('VALIDATION', '需要 confirm:true')
      return { ok: true, value: await handler(body, { signal }) }
    } catch (error) {
      return errorEnvelope(error)
    }
  }

  return { handle, endpoints, channel: RPC_CHANNEL }
}

