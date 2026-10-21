/**
 * 闲鱼 mtop 只读接口表 + 请求体构造 + 商品详情解析（纯函数，零 IO）。
 *
 * 接口与字段来自抓包与参考实现的事实记录（不复制代码）：
 * - 详情请求体 `{"itemId":"<id>"}`：XianYuApis/goofish_apis.py:447、xianyu-super-butler/XianyuAutoAsync.py:4209
 * - 详情响应 `data.itemDO` + `data.sellerDO`：xianyu-auto-reply/common/services/xianyu_detail_client.py:57-60、
 *   XianyuAutoAgent/main.py:496-497（itemDO 内 `title`/`desc`/`soldPrice` 为元）
 * - 擦亮请求体同为 `{"itemId":...}`，但**版本是 2.0**：xianyu-super-butler/utils/item_polish.py:45,59
 * - 类目属性预测与 POI 地址是 2.0/1.0 两种版本：XianYuApis/goofish_apis.py:459-575
 * - 搜索卡片价格是文本数组 `price: [{text}]`：xianyu_spider/xianyu/search.py:66-72
 *
 * 价格口径：`xxxCent` 字段=分；`price`/`priceText`/`soldPrice` 一律按**元**解释
 * （平台上没有 `¥` 前缀的 `1299` 与 `¥1,299.00` 含义相同）。换算用字符串移位，不碰浮点乘法。
 * @module @bigfish/channel-mtop/api
 */
import { fail } from '@bigfish/core'
import type { ItemState, ItemSummary } from '@bigfish/core'

/** 只读通道用到的 mtop 接口名（抓包事实，不是密钥）。 */
export const MTOP_APIS = {
  search: 'mtop.taobao.idlemtopsearch.pc.search',
  detail: 'mtop.taobao.idle.pc.detail',
  polish: 'mtop.taobao.idle.item.polish',
  publish: 'mtop.idle.pc.idleitem.publish',
  backendPublish: 'mtop.idle.pc.backend.idleitem.publish',
  propertyRecommend: 'mtop.taobao.kgraph.property.recommend',
  poi: 'mtop.taobao.idle.local.poi.get',
  loginToken: 'mtop.taobao.idlemessage.pc.login.token',
} as const

/**
 * 与 DEFAULT_VERSION(1.0) 不同的接口版本。
 * 擦亮传 1.0 会报接口不存在（xianyu-super-butler/utils/item_polish.py:58-59）。
 */
export const MTOP_API_VERSIONS = {
  polish: '2.0',
  propertyRecommend: '2.0',
} as const

/** 商品详情入参。 */
export interface ItemDetailInput {
  itemId: string
}

/** 擦亮入参。 */
export interface PolishInput {
  itemId: string
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** itemId 只允许非空字符串；平台 id 是纯数字但一律按字符串传递，避免大数精度问题。 */
function requireItemId(value: unknown, api: string): string {
  if (typeof value !== 'string') {
    fail('VALIDATION', api + ' 的 itemId 必须是字符串')
  }
  const itemId = value.trim()
  if (itemId.length === 0) {
    fail('VALIDATION', api + ' 的 itemId 不能为空')
  }
  return itemId
}

/** 详情请求体：只有 itemId（XianYuApis/goofish_apis.py:447）。 */
export function buildItemDetailData(input: ItemDetailInput): UnknownRecord {
  if (!isRecord(input)) {
    fail('VALIDATION', 'buildItemDetailData 需要 { itemId } 对象')
  }
  return { itemId: requireItemId(input.itemId, MTOP_APIS.detail) }
}

/** 擦亮请求体：同样只有 itemId；版本请用 MTOP_API_VERSIONS.polish。 */
export function buildPolishData(input: PolishInput): UnknownRecord {
  if (!isRecord(input)) {
    fail('VALIDATION', 'buildPolishData 需要 { itemId } 对象')
  }
  return { itemId: requireItemId(input.itemId, MTOP_APIS.polish) }
}

/** 以「分」为单位的字段，优先于任何元文本。 */
const CENT_FIELDS = ['priceInCent', 'priceCent', 'soldPriceInCent'] as const
/** 以「元」为单位的字段，按优先级尝试。 */
const YUAN_FIELDS = ['priceText', 'price', 'soldPrice', 'currentPrice'] as const

/** 分字段：只接受非负整数（也接受纯数字字符串）。 */
function centsFromCentField(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let cents: number
  if (typeof value === 'number') {
    cents = value
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    cents = Number(value.trim())
  } else {
    return fail('VALIDATION', field + ' 不是合法的整数分：' + String(value).slice(0, 40))
  }
  if (!Number.isSafeInteger(cents) || cents < 0) {
    fail('VALIDATION', field + ' 不是合法的整数分：' + String(value).slice(0, 40))
  }
  return cents
}

/** 把任意形态的价格值拍平成文本：字符串/数字/[{text}]/{text|priceText|value}。 */
function yuanText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    return text.length === 0 ? undefined : text
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => yuanText(item)).filter((text): text is string => text !== undefined)
    return parts.length === 0 ? undefined : parts.join('')
  }
  if (isRecord(value)) {
    for (const key of ['text', 'priceText', 'value', 'amount', 'price']) {
      const text = yuanText(value[key])
      if (text !== undefined) return text
    }
  }
  return undefined
}

/**
 * 「元」文本 → 整数分：支持 `¥1,299.00`/`1299`/`12.34`/`1.2万`。
 * 只取第一个数字（价格区间 `12.34-15.00` 取起始价）；超过两位小数截断。
 */
function yuanTextToCents(text: string): number | undefined {
  const cleaned = text
    .replace(/[¥￥]/g, '')
    .replace(/,/g, '')
    .replace(/当前价|现价|元/g, '')
    .replace(/\s+/g, '')
  if (cleaned.length === 0) return undefined
  const times = cleaned.includes('万') ? 10_000 : 1
  const match = /(\d+)(?:\.(\d+))?/.exec(cleaned.replace(/万/g, ''))
  if (match === null) return undefined
  const intText = match[1]
  if (intText === undefined) return undefined
  const intPart = Number(intText)
  const fracText = (match[2] ?? '').slice(0, 2).padEnd(2, '0')
  const cents = intPart * 100 + Number(fracText)
  if (!Number.isSafeInteger(cents)) return undefined
  return cents * times
}

/**
 * 「元」字段 → 分；字段存在但解析不出数字时抛 VALIDATION（宁可报错也不写 0）。
 * 导出给 user.ts 的商家商品列表复用，避免价格换算逻辑出现第二份实现。
 */
export function centsFromYuan(value: unknown, field: string): number | undefined {
  const text = yuanText(value)
  if (text === undefined) return undefined
  const cents = yuanTextToCents(text)
  if (cents === undefined) {
    fail('VALIDATION', field + ' 的价格文本无法解析：' + text.slice(0, 40))
  }
  return cents
}

/**
 * 价格解析优先级：分字段（含 itemPriceDTO.priceInCent）→ 元文本字段 → 搜索卡 priceInfo。
 * 返回 undefined 表示响应里根本没有价格字段，调用方按 0 落库。
 */
function resolvePriceCents(candidate: UnknownRecord): number | undefined {
  for (const field of CENT_FIELDS) {
    const cents = centsFromCentField(candidate[field], field)
    if (cents !== undefined) return cents
  }
  const priceDto = candidate.itemPriceDTO
  if (isRecord(priceDto)) {
    const cents = centsFromCentField(priceDto.priceInCent, 'itemPriceDTO.priceInCent')
    if (cents !== undefined) return cents
  }
  for (const field of YUAN_FIELDS) {
    const cents = centsFromYuan(candidate[field], field)
    if (cents !== undefined) return cents
  }
  const priceInfo = candidate.priceInfo
  if (isRecord(priceInfo)) {
    const cents = centsFromYuan(priceInfo, 'priceInfo')
    if (cents !== undefined) return cents
  }
  return undefined
}

/** 明确的「已失效」布尔标记。 */
const OFFLINE_FLAGS = ['soldOut', 'isSoldOut', 'sold_out', 'offShelf', 'isOffShelf', 'off_shelf', 'offline', 'isOffline'] as const
const OFFLINE_TEXT = /sold|offline|off_?shelf|下架|已售|售出|删除|deleted|失效/i
const ONLINE_TEXT = /^(0|online|on_?sale|在售|正常|on)$/i

function isOnFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

/**
 * 状态映射：soldOut/offShelf 等标记或文本 → offline；itemStatus 0 视为在售
 * （xianyu-auto-reply/common/services/xianyu_seller_item_client.py:12 只用 "0" 过滤在售）。
 * 任务约定「否则 online」：无法识别的状态值仍返回 online，避免 daemon 误判为下架。
 */
function resolveItemState(candidate: UnknownRecord): ItemState {
  for (const field of OFFLINE_FLAGS) {
    if (isOnFlag(candidate[field])) return 'offline'
  }
  const raw = candidate.itemStatus ?? candidate.itemState ?? candidate.status ?? candidate.state
  if (typeof raw === 'number') {
    return raw === 0 ? 'online' : 'offline'
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (ONLINE_TEXT.test(text)) return 'online'
    if (OFFLINE_TEXT.test(text)) return 'offline'
  }
  const desc = candidate.itemStatusDesc ?? candidate.statusDesc
  if (typeof desc === 'string' && OFFLINE_TEXT.test(desc)) return 'offline'
  return 'online'
}

/** raw 可能是完整 mtop 响应（含 ret/data），也可能是 parseMtopResponse 已剥出的 data。 */
function detailData(raw: unknown): UnknownRecord {
  if (!isRecord(raw)) {
    fail('VALIDATION', 'parseItemDetail 需要 mtop 响应对象：' + String(raw).slice(0, 40))
  }
  const data = raw.data
  if (isRecord(data)) return data
  if (Array.isArray(raw.ret)) {
    const ret = raw.ret.filter((item): item is string => typeof item === 'string').join(' | ')
    fail('VALIDATION', '详情响应缺少 data 对象（ret=' + ret.slice(0, 80) + '）')
  }
  return raw
}

/** 候选对象依次为 itemDO → itemCardDO → data 扁平。 */
function pickCandidate(data: UnknownRecord): UnknownRecord {
  for (const key of ['itemDO', 'itemCardDO']) {
    const value = data[key]
    if (isRecord(value) && Object.keys(value).length > 0) return value
  }
  return data
}

/** itemId 先取候选对象，再回退 data 层；都没有则 VALIDATION。 */
function pickItemId(candidate: UnknownRecord, data: UnknownRecord): string {
  const values = [candidate.itemId, candidate.id, data.itemId, data.id]
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return fail('VALIDATION', '详情响应缺少 itemId，无法落库')
}

/** 标题取 title/itemTitle/itemTextDTO.title；都空则 VALIDATION。 */
function pickTitle(candidate: UnknownRecord): string {
  const textDto = candidate.itemTextDTO
  const values: unknown[] = [candidate.title, candidate.itemTitle]
  if (isRecord(textDto)) values.push(textDto.title)
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return fail('VALIDATION', '详情响应缺少 title，无法落库')
}

/**
 * 解析商品详情响应为 core 的 ItemSummary（纯函数）。
 * 容错三种形态：`{data:{itemDO}}`、`{data:{itemCardDO}}`、`{data:{...扁平}}`，
 * 也接受已剥出的 data 对象。响应里没有价格时 priceCents=0；价格存在但解析失败抛 VALIDATION。
 */
export function parseItemDetail(raw: unknown, accountId: string, now?: number): ItemSummary {
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    fail('VALIDATION', 'parseItemDetail 需要非空 accountId')
  }
  const updatedAt = now ?? Date.now()
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    fail('VALIDATION', 'parseItemDetail 的 now 必须是整数毫秒：' + String(now))
  }
  const data = detailData(raw)
  const candidate = pickCandidate(data)
  const priceCents = resolvePriceCents(candidate) ?? (candidate === data ? 0 : resolvePriceCents(data)) ?? 0
  return {
    itemId: pickItemId(candidate, data),
    accountId: accountId.trim(),
    title: pickTitle(candidate),
    priceCents,
    state: resolveItemState(candidate),
    updatedAt,
  }
}
