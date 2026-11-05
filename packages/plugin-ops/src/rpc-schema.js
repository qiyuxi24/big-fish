/**
 * rpc 边界契约与窄化校验：端点常量/白名单/上限、失败信封、面板 payload 的 unknown → 已知形状转换。
 * 从 rpc.js 拆出（2026-10-24，守 AGENTS §3「文件 ≤400 行」）；对面板的契约不变。
 * 信封必须恒带 details 对象（原因见 failEnvelope 的注释与 docs/STATUS.md §6）。
 *
 * @module @bigfish/plugin-ops/rpc-schema
 */
import { CONDITIONS } from './copy.js'

/** 与 daemon 客户端同构的错误码；未知 code 收敛为 INTERNAL，避免把内部字符串透给面板。 */
const KNOWN_CODES = new Set([
  'VALIDATION', 'AUTH_EXPIRED', 'RISK_CONTROL', 'RATE_LIMITED', 'CIRCUIT_OPEN',
  'NETWORK', 'STORAGE', 'UNSUPPORTED', 'INTERNAL', 'UNAUTHORIZED',
  'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'UNKNOWN',
])

const TASK_STATES = new Set(['queued', 'leased', 'done', 'failed', 'needs_review'])
const TASK_KINDS = new Set(['publish', 'deliver', 'polish', 'reply', 'probe'])
/** 商品状态与 core 的 ITEM_STATES 一致；上限与 core 的 MAX_LIST_LIMIT 一致（500）。 */
const ITEM_STATES = new Set(['online', 'offline', 'unknown'])
const MAX_ITEM_LIMIT = 500
export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
export const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
export const BATCH_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const ITEM_ID_RE = /^\d{1,20}$/
const MAX_BATCH_ITEMS = 20
const MAX_REFERENCE_ITEMS = 20
/** 商家商品采集的件数上限，与 daemon 的 MAX_SELLER_ITEMS 保持一致。 */
const MAX_SELLER_ITEMS = 60
/** 链接长度上限：闲鱼分享文案可能带说明文字，但没必要更长。 */
const MAX_LINK_CHARS = 2_048
const PUBLISH_MIN_INTERVAL_MS = 180_000
const PUBLISH_MIN_INTERVAL_MIN_MS = 30_000
const PUBLISH_MIN_INTERVAL_MAX_MS = 3_600_000
const MAX_BATCH_ITEMS_LIMIT = 20
export const LOGIN_TIMEOUT_MAX_MS = 180_000
/** GET /events 的 limit 上限，与 daemon 端事件表读取保持一致。 */
const MAX_EVENTS_LIMIT = 1000
/** 停止 daemon 后的存活探测：250ms 一次、最多 10 秒。 */
const STOP_POLL_INTERVAL_MS = 250
const STOP_POLL_TIMEOUT_MS = 10_000
const STOP_HEALTH_TIMEOUT_MS = 800
/** 扫码登录是长轮询（daemon 等到 180s），HTTP 超时必须比它再宽一点。 */
export const LOGIN_REQUEST_MARGIN_MS = 20_000
export const IMPORT_TIMEOUT_MS = 120_000
/** 校验登录态会真调一次 mtop（可能含一次令牌刷新重试），HTTP 超时要比 daemon 客户端默认 15s 宽。 */
export const VERIFY_REQUEST_TIMEOUT_MS = 40_000
/** settings 的可写字段；不在这张表里的键一律拒绝（未知字段不转发）。 */
const SETTINGS_FIELDS = new Set([
  'copyStyle', 'defaultCategory', 'defaultAddress', 'shipping',
  'publishMinIntervalMs', 'maxBatchItems', 'imageProvider',
  // 账号模块（2026-10-23）：当前账号 / 登录保活开关与间隔。
  'activeAccountId', 'keepAliveEnabled', 'keepAliveIntervalMs',
])
/** 保活间隔：面板按秒输入，host 侧统一存毫秒（60s ~ 1h）。 */
const KEEP_ALIVE_INTERVAL_MIN_MS = 60_000
const KEEP_ALIVE_INTERVAL_MAX_MS = 3_600_000

/**
 * 入队里「会写外部系统」的任务种类：publish/deliver/polish 会真去动闲鱼商品，
 * reply（回消息）**会真的发一条消息给买家**，同样是对外动作；
 * 只有 probe（读详情）是纯读。
 * 工具侧（tool-kit.js）与本文件共用这一份，避免两处枚举漂移。
 */
export const CONFIRM_TASK_KINDS = new Set(['publish', 'deliver', 'polish', 'reply'])

/**
 * 写类端点：必须 payload.confirm === true 才放行。
 * 面板误触/模型幻觉都可能带上写参数；confirm 是 host 侧唯一能确认「人真的点了」的信号。
 *
 * 注意 `batch.enqueue` **不在这里**：一次入队是「写闲鱼」还是「只读探测」取决于
 * items[].kind，整体挂闸会让「探测详情」这个纯读动作也要点两次（2026-10-27 自用时实测）。
 * 它的判定下沉到 needsConfirm()，按 kind 决定。
 */
export const WRITE_ENDPOINTS = new Set([
  'tasks.retry', 'accounts.import', 'accounts.login', 'settings.put',
  // 商家商品采集会写本地库（seller_items/sellers），属于写磁盘：必须人工确认。
  'seller.collect',
  // 退出登录只删本地凭据（不注销网页会话），但也是不可逆的本地状态变更，要求 confirm:true。
  'accounts.logout',
  // 停 daemon 会中断正在执行的任务：和写闲鱼一样要求 confirm:true。
  'daemon.stop',
  // 复位熔断＝解除「账号暂停写」的刹车，下一次写就会真的打到闲鱼。
  // 它不触达平台，但决定了后续所有写操作是否放行，所以要人确认一次。
  'circuits.reset',
])

/**
 * 这次 rpc 调用要不要 `confirm:true`。
 *
 * 为什么不能只看端点名：`batch.enqueue` 同时承载「擦亮/发布（写闲鱼）」与「探测详情（只读）」，
 * 端点级挂闸会把纯读动作也变成两次点击；反过来 `daemon.start` 是纯本地拉起、不碰闲鱼，
 * 端点级免确认是合理的（它拉起的 daemon 默认 dry-run）。
 *
 * 判定顺序（保守优先）：
 * 1. 未知端点 → 交给 handle() 报 UNSUPPORTED，这里返回 false 不影响；
 * 2. 在 WRITE_ENDPOINTS 里 → true；
 * 3. batch.enqueue → 任一 item 的 kind 属于写种类就要确认；items 形态异常也返回 true。
 *
 * @param {string} endpoint - rpc 端点名。
 * @param {unknown} payload - 原始 payload（未校验，必须自己窄化）。
 * @returns {boolean} true 表示必须带 confirm:true 才放行。
 */
export function needsConfirm(endpoint, payload) {
  if (WRITE_ENDPOINTS.has(endpoint)) return true
  if (endpoint !== 'batch.enqueue') return false
  if (!isRecord(payload)) return true
  const items = payload.items
  if (!Array.isArray(items) || items.length === 0) return true
  for (const item of items) {
    if (!isRecord(item)) return true
    if (typeof item.kind !== 'string' || CONFIRM_TASK_KINDS.has(item.kind)) return true
  }
  return false
}


/** 字段校验失败：只在 host 内部抛，handle() 会翻译成 VALIDATION 信封。 */
class RpcPayloadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RpcPayloadError'
    this.code = 'VALIDATION'
  }
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function bad(message) {
  throw new RpcPayloadError(message)
}

/**
 * 失败信封**必须**带 details 对象：宿主 client 的 parseConnectionResponse 要求
 * `isRecord(error.details)`，缺字段直接抛 `connection: invalid server-response failure`，
 * 把真实原因（daemon 没起 / 连不上 DevTools / 缺 confirm）替换成一句看不懂的报文。
 * 2026-10-23 面板「导入账号 / 扫码登录」失败时用户只看到这句话，根因全被吞掉。
 */
export function failEnvelope(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/** 任何异常都翻译成信封；details 只在确实是对象时透出，否则补空对象（见 failEnvelope 的说明）。 */
export function errorEnvelope(error) {
  const rawCode = error === null || error === undefined ? undefined : error.code
  const code = typeof rawCode === 'string' && KNOWN_CODES.has(rawCode) ? rawCode : 'INTERNAL'
  const message = error instanceof Error ? error.message : 'rpc 调用失败：' + String(error).slice(0, 200)
  const details = isRecord(error) && isRecord(error.details) ? error.details : {}
  return { ok: false, error: { code, message, details } }
}

export function readRequiredString(body, field, pattern) {
  const raw = body[field]
  if (typeof raw !== 'string' || raw.trim().length === 0) bad(field + ' 必须是非空字符串')
  const value = raw.trim()
  if (pattern !== undefined && !pattern.test(value)) bad(field + ' 格式非法：' + value.slice(0, 40))
  return value
}

export function readOptionalString(body, field, maxLength) {
  const raw = body[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') bad(field + ' 必须是字符串')
  const value = raw.trim()
  if (value.length === 0) bad(field + ' 不能为空')
  if (value.length > maxLength) bad(field + ' 最长 ' + maxLength + ' 个字符')
  return value
}

export function readOptionalPort(body) {
  const raw = body.port
  if (raw === undefined || raw === null) return undefined
  return readIntegerValue(raw, 'port', 1, 65_535)
}

export function readIntegerValue(raw, field, min, max) {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) bad(field + ' 必须是整数')
  if (raw < min || raw > max) bad(field + ' 必须在 ' + min + '..' + max + ' 之间')
  return raw
}

export function readTaskFilter(body) {
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

/**
 * 商品快照的过滤参数：daemon 的 GET /items 一直支持 state / accountId / limit，
 * 但面板以前不发、rpc 也不透传——多账号时「选中账号 B 却勾到 A 的商品」，
 * 擦亮入队就是 itemId(A) + accountId(B) 的错账号写操作。limit 上限与 core 的 MAX_LIST_LIMIT 一致。
 */
export function readItemsFilter(body) {
  const filter = {}
  if (body.state !== undefined) {
    if (typeof body.state !== 'string' || !ITEM_STATES.has(body.state)) bad('item state 非法：' + String(body.state).slice(0, 40))
    filter.state = body.state
  }
  if (body.accountId !== undefined) filter.accountId = readRequiredString(body, 'accountId', ACCOUNT_ID_RE)
  if (body.limit !== undefined) filter.limit = readIntegerValue(body.limit, 'limit', 1, MAX_ITEM_LIMIT)
  return filter
}

/** GET /events 的过滤参数：since 排他游标，limit 上限与 daemon 一致（1000）。 */
export function readEventFilter(body) {
  const filter = {}
  if (body.since !== undefined) filter.since = readIntegerValue(body.since, 'since', 0, Number.MAX_SAFE_INTEGER)
  if (body.limit !== undefined) filter.limit = readIntegerValue(body.limit, 'limit', 1, MAX_EVENTS_LIMIT)
  if (body.taskId !== undefined) filter.taskId = readRequiredString(body, 'taskId', ID_RE)
  if (body.batchId !== undefined) filter.batchId = readRequiredString(body, 'batchId', BATCH_ID_RE)
  return filter
}

export function readReferenceInput(body) {
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

/** 市场简报入参：全是可选过滤条件；上限与 daemon 的 limit 约束一致（1..500）。 */
export function readMarketBriefInput(body) {
  const input = {}
  const categoryId = readOptionalString(body, 'categoryId', 64)
  if (categoryId !== undefined) input.categoryId = categoryId
  if (body.sellerId !== undefined) input.sellerId = readItemId(body.sellerId)
  if (body.limit !== undefined) input.limit = readIntegerValue(body.limit, 'limit', 1, 500)
  if (body.condition !== undefined) {
    if (typeof body.condition !== 'string' || !CONDITIONS.includes(body.condition)) {
      bad('condition 非法：' + String(body.condition).slice(0, 40))
    }
    input.condition = body.condition
  }
  return input
}

export function readItemId(raw) {
  if (typeof raw !== 'string' || !ITEM_ID_RE.test(raw.trim())) bad('itemId/sellerId 必须是纯数字串：' + String(raw).slice(0, 40))
  return raw.trim()
}

/**
 * 链接解析入参。格式校验交给 daemon 的 parseXianyuLink：它才知道
 * 「短链要展开」「纯数字分不清商品/商家」这些可操作提示，host 这里只挡空值与长度。
 */
export function readLinkInput(body) {
  const raw = body.link
  if (typeof raw !== 'string' || raw.trim().length === 0) bad('link 必须是非空字符串')
  const link = raw.trim()
  if (link.length > MAX_LINK_CHARS) bad('link 最长 ' + MAX_LINK_CHARS + ' 个字符')
  return link
}

/** 商家采集入参：sellerId 是纯数字；acknowledgeOther 只在拉他人店铺时需要（daemon 再校验一次）。 */
export function readSellerCollectInput(body) {
  const input = {
    accountId: readRequiredString(body, 'accountId', ACCOUNT_ID_RE),
    sellerId: readItemId(body.sellerId),
  }
  if (body.maxItems !== undefined) input.maxItems = readIntegerValue(body.maxItems, 'maxItems', 1, MAX_SELLER_ITEMS)
  if (body.acknowledgeOther !== undefined) input.acknowledgeOther = readBoolean(body.acknowledgeOther, 'acknowledgeOther')
  return input
}

export function readEnqueueItems(raw) {
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

export function readSettingsPatch(raw) {
  if (!isRecord(raw)) bad('settings.put 需要 patch 对象')
  const keys = Object.keys(raw)
  if (keys.length === 0) bad('patch 不能为空')
  const patch = {}
  for (const key of keys) {
    if (!SETTINGS_FIELDS.has(key)) bad('settings 不支持字段：' + key.slice(0, 40))
    const value = raw[key]
    if (key === 'publishMinIntervalMs') patch[key] = readIntegerValue(value, key, PUBLISH_MIN_INTERVAL_MIN_MS, PUBLISH_MIN_INTERVAL_MAX_MS)
    else if (key === 'keepAliveIntervalMs') patch[key] = readIntegerValue(value, key, KEEP_ALIVE_INTERVAL_MIN_MS, KEEP_ALIVE_INTERVAL_MAX_MS)
    else if (key === 'keepAliveEnabled') patch[key] = readBoolean(value, key)
    else if (key === 'activeAccountId') patch[key] = readActiveAccountId(value)
    else if (key === 'maxBatchItems') patch[key] = readIntegerValue(value, key, 1, MAX_BATCH_ITEMS_LIMIT)
    else if (key === 'imageProvider') patch[key] = readImageProvider(value)
    else if (key === 'shipping') patch[key] = readShipping(value)
    else patch[key] = readSettingsText(value, key)
  }
  return patch
}

function readBoolean(value, field) {
  if (typeof value !== 'boolean') bad(field + ' 必须是布尔')
  return value
}

/** 当前账号：空串表示「没有当前账号」，非空必须是合法 accountId。 */
function readActiveAccountId(value) {
  if (typeof value !== 'string') bad('activeAccountId 必须是字符串')
  const text = value.trim()
  if (text.length > 64) bad('activeAccountId 最长 64 个字符')
  if (text !== '' && !ACCOUNT_ID_RE.test(text)) bad('activeAccountId 格式非法：' + text.slice(0, 40))
  return text
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