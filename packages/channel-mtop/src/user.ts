/**
 * 闲鱼商家主页（user.page.head）与商品列表（xyh.item.list）的请求体构造 + 响应解析。
 * 纯函数、零 IO：签名/发请求/分页节奏由调用方（daemon 取品任务）负责。
 *
 * 抓包事实（2026-10-21 CDP 实测，见 docs/p1.3-plan.md §2.1）：
 * - 请求 `mtop.idle.web.user.page.head` data={"self":false,"userId":"<id>"}；
 *   响应 data.baseInfo{encryptedUserId,kcUserId,self,tags}、data.module.tabs.item{number,name}、
 *   data.module.social{followStatus,followers,following}、data.module.base{displayName,avatar,ipLocation}
 * - 请求 `mtop.idle.web.xyh.item.list` data={"needGroupInfo":true,"pageNumber":1,"userId":"<id>","pageSize":20}；
 *   响应 data.cardList[*].cardData.detailParams{itemId(字符串),title,soldPrice(元),...} + data.hasMore/pageNumber
 * - 详情 `mtop.taobao.idle.pc.detail` 响应 data.sellerDO.sellerId（数字）= 商家唯一 ID
 *
 * 合规红线（docs/p1.3-plan.md §2.2）：默认只允许拉**自己账号**的店铺；调用方拉列表前
 * 必须用 parseUserHead 的 isSelf 判定，或由用户显式输入 sellerId 并确认有权使用素材。
 * 本模块只解析平台事实，不做授权判断。
 * @module @bigfish/channel-mtop/user
 */
import { fail } from '@bigfish/core'
import type { ItemSummary } from '@bigfish/core'
import { centsFromYuan } from './api.ts'

/** 商家主页/商品列表用到的 mtop 接口名（抓包事实，不是密钥）。 */
export const USER_MTOP_APIS = {
  head: 'mtop.idle.web.user.page.head',
  itemList: 'mtop.idle.web.xyh.item.list',
} as const

/** 商家主页请求入参。 */
export interface UserHeadInput {
  userId: string
}

/** 商品列表请求入参；userId 是商家唯一 ID（主页 URL 的 userId）。 */
export interface ItemListInput {
  userId: string
  /** 从 1 开始；缺省 1。 */
  pageNumber?: number
  /** 平台实测单页 20；缺省 20，超出 1..20 直接 VALIDATION，避免接口行为漂移。 */
  pageSize?: number
}

/** 商家主页解析结果；响应里没有的字段保持 undefined，不填 0/空串。 */
export interface UserHeadProfile {
  /** 入参的商家唯一 ID（响应只带加密 id，没有明文 userId）。 */
  userId: string
  /** baseInfo.self：true 表示就是当前登录账号自己的主页（合规红线判定用）。 */
  isSelf?: boolean
  encryptedUserId?: string
  kcUserId?: string
  displayName?: string
  avatar?: string
  ipLocation?: string
  followers?: number
  following?: number
  followStatus?: boolean
  itemCount?: number
  itemTabName?: string
  /** baseInfo.tags 的 real_name_certification* 标记为真时给出 true。 */
  realNameCertified?: boolean
}

/** 商品列表一页的解析结果；分页由调用方按 hasMore 推进。 */
export interface ItemListPage {
  items: ItemSummary[]
  hasMore: boolean
  pageNumber: number
}

type UnknownRecord = Record<string, unknown>

/** 平台实测单页 20（docs/p1.3-plan.md §2.1）。 */
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 20
const DEFAULT_PAGE_NUMBER = 1

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 兼容两种入参：完整 mtop 响应（{ret,data}）或 parseMtopResponse 已剥出的 data。
 * 响应带 ret 却缺 data 时给出明确 VALIDATION，避免把错误信封当业务数据解析。
 */
function unwrapData(raw: unknown, purpose: string): UnknownRecord {
  if (!isRecord(raw)) {
    fail('VALIDATION', purpose + ' 需要 mtop 响应对象：' + String(raw).slice(0, 40))
  }
  const data = raw.data
  if (isRecord(data)) return data
  if (Object.hasOwn(raw, 'data')) {
    fail('VALIDATION', purpose + ' 响应缺少 data 对象')
  }
  return raw
}

function requireUserId(value: unknown, purpose: string): string {
  if (typeof value !== 'string') {
    fail('VALIDATION', purpose + ' 的 userId 必须是字符串')
  }
  const userId = value.trim()
  if (userId.length === 0) {
    fail('VALIDATION', purpose + ' 的 userId 不能为空')
  }
  return userId
}

/** 字符串字段：去空白；非字符串或空白都视为缺失，不报错（平台会按降级场景少给字段）。 */
function optionalString(source: UnknownRecord, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length === 0 ? undefined : text
}

/** 计数/页码只接受非负安全整数或纯数字字符串；字段存在但非法时 VALIDATION（不静默写 0）。 */
function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let parsed: number | undefined
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim())
  }
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    fail('VALIDATION', field + ' 不是合法的非负整数：' + String(value).slice(0, 40))
  }
  return parsed
}

/** 平台布尔字段（true/1/'1'/'true'）归一；无法识别时返回 undefined，不猜。 */
function optionalFlag(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  return undefined
}

/** 商家主页请求体：抓包固定 self=false（以访客视角看主页），userId 去空白。 */
export function buildUserHeadData(input: UserHeadInput): UnknownRecord {
  if (!isRecord(input)) {
    fail('VALIDATION', 'buildUserHeadData 需要 { userId } 对象')
  }
  return { self: false, userId: requireUserId(input.userId, USER_MTOP_APIS.head) }
}

function requirePageNumber(value: unknown): number {
  const pageNumber = optionalInteger(value, 'pageNumber') ?? DEFAULT_PAGE_NUMBER
  if (pageNumber < 1) {
    fail('VALIDATION', 'pageNumber 必须从 1 开始，收到：' + String(value))
  }
  return pageNumber
}

function requirePageSize(value: unknown): number {
  const pageSize = optionalInteger(value, 'pageSize') ?? DEFAULT_PAGE_SIZE
  if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    fail('VALIDATION', 'pageSize 必须在 1..' + MAX_PAGE_SIZE + ' 之间（平台实测单页 20），收到：' + String(value))
  }
  return pageSize
}

/** 商品列表请求体：needGroupInfo=true 与网页端一致；pageSize 有上限，避免一次拉爆。 */
export function buildItemListData(input: ItemListInput): UnknownRecord {
  if (!isRecord(input)) {
    fail('VALIDATION', 'buildItemListData 需要 { userId, pageNumber?, pageSize? } 对象')
  }
  const userId = requireUserId(input.userId, USER_MTOP_APIS.itemList)
  const pageNumber = requirePageNumber(input.pageNumber)
  const pageSize = requirePageSize(input.pageSize)
  return { needGroupInfo: true, pageNumber, userId, pageSize }
}

/** 把 baseInfo 里 docs 确认过的字段搬进结果；tags 里的实名标记按前缀找。 */
function assignBaseInfo(profile: UserHeadProfile, baseInfo: UnknownRecord): void {
  const isSelf = optionalFlag(baseInfo.self)
  if (isSelf !== undefined) profile.isSelf = isSelf
  const encryptedUserId = optionalString(baseInfo, 'encryptedUserId')
  if (encryptedUserId !== undefined) profile.encryptedUserId = encryptedUserId
  const kcUserId = optionalString(baseInfo, 'kcUserId')
  if (kcUserId !== undefined) profile.kcUserId = kcUserId
  const tags = baseInfo.tags
  if (isRecord(tags)) {
    const certified = tagByPrefix(tags, 'real_name_certification')
    if (certified !== undefined) profile.realNameCertified = certified
  }
}

/**
 * tags 的键带数字后缀（抓包见 real_name_certification_77），值可能是 bool/0-1/文本，
 * 因此按前缀取第一个能判定的键；全认不出就不给结论。
 */
function tagByPrefix(tags: UnknownRecord, prefix: string): boolean | undefined {
  for (const [key, value] of Object.entries(tags)) {
    if (!key.startsWith(prefix)) continue
    const flag = optionalFlag(value)
    if (flag !== undefined) return flag
    if (typeof value === 'string') return value.trim().length > 0
    if (isRecord(value) || Array.isArray(value)) return true
  }
  return undefined
}

/** module 下三个子块（tabs/social/base）都是可选：缺哪个就少给哪个字段。 */
function assignModule(profile: UserHeadProfile, module: UnknownRecord): void {
  const tabs = module.tabs
  const itemTab = isRecord(tabs) ? tabs.item : undefined
  if (isRecord(itemTab)) {
    const itemCount = optionalInteger(itemTab.number, 'module.tabs.item.number')
    if (itemCount !== undefined) profile.itemCount = itemCount
    const itemTabName = optionalString(itemTab, 'name')
    if (itemTabName !== undefined) profile.itemTabName = itemTabName
  }
  const social = module.social
  if (isRecord(social)) {
    const followers = optionalInteger(social.followers, 'module.social.followers')
    if (followers !== undefined) profile.followers = followers
    const following = optionalInteger(social.following, 'module.social.following')
    if (following !== undefined) profile.following = following
    const followStatus = optionalFlag(social.followStatus)
    if (followStatus !== undefined) profile.followStatus = followStatus
  }
  const base = module.base
  if (isRecord(base)) {
    const displayName = optionalString(base, 'displayName')
    if (displayName !== undefined) profile.displayName = displayName
    const avatar = optionalString(base, 'avatar')
    if (avatar !== undefined) profile.avatar = avatar
    const ipLocation = optionalString(base, 'ipLocation')
    if (ipLocation !== undefined) profile.ipLocation = ipLocation
  }
}

/**
 * 解析商家主页响应为 UserHeadProfile（纯函数）。
 * baseInfo 与 module 至少有一个是对象，否则视为错误信封；单个字段缺失不报错。
 */
export function parseUserHead(raw: unknown, userId: string): UserHeadProfile {
  const sellerId = requireUserId(userId, 'parseUserHead')
  const data = unwrapData(raw, 'parseUserHead')
  const baseInfo = data.baseInfo
  const module = data.module
  if (!isRecord(baseInfo) && !isRecord(module)) {
    fail('VALIDATION', '商家主页响应缺少 baseInfo/module，无法解析')
  }
  const profile: UserHeadProfile = { userId: sellerId }
  if (isRecord(baseInfo)) assignBaseInfo(profile, baseInfo)
  if (isRecord(module)) assignModule(profile, module)
  return profile
}

/** now 只影响 updatedAt；注入整数毫秒让测试可复现。 */
function resolveNow(now: unknown): number {
  const updatedAt = now === undefined ? Date.now() : now
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    fail('VALIDATION', 'now 必须是整数毫秒：' + String(now))
  }
  return updatedAt
}

/** itemId 是落库主键：字符串或安全整数都接受，缺失抛 VALIDATION。 */
function requireCardItemId(value: unknown, index: number): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return fail('VALIDATION', '商品列表第 ' + (index + 1) + ' 个卡片缺少 itemId，无法落库')
}

/**
 * 单个卡片 → ItemSummary：detailParams 里取 itemId/title/soldPrice。
 * title 缺失返回 undefined 由调用方跳过（平台偶发空标题卡片，留着会卡住落库）；
 * 接口只返回「宝贝」tab 的在售商品，卡片里没有状态字段，故 state 固定 online。
 */
function parseItemCard(card: unknown, index: number, accountId: string, updatedAt: number): ItemSummary | undefined {
  if (!isRecord(card)) {
    fail('VALIDATION', '商品列表第 ' + (index + 1) + ' 个卡片不是对象')
  }
  const cardData = isRecord(card.cardData) ? card.cardData : card
  const params = isRecord(cardData.detailParams) ? cardData.detailParams : cardData
  const itemId = requireCardItemId(params.itemId, index)
  const title = optionalString(params, 'title')
  if (title === undefined) return undefined
  const priceField = '商品列表第 ' + (index + 1) + ' 个卡片的 soldPrice'
  return {
    itemId,
    accountId,
    title,
    priceCents: centsFromYuan(params.soldPrice, priceField) ?? 0,
    state: 'online',
    updatedAt,
  }
}

/**
 * 解析商品列表响应为 ItemListPage（纯函数）。
 * 价格按「元」用既有的元→分换算（与 parseItemDetail 同一份实现）；
 * 分页继续条件用 hasMore（缺省 false，宁少拉不多拉）；pageNumber 缺省 1。
 */
export function parseItemList(raw: unknown, accountId: string, now?: number): ItemListPage {
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    fail('VALIDATION', 'parseItemList 需要非空 accountId')
  }
  const updatedAt = resolveNow(now)
  const data = unwrapData(raw, 'parseItemList')
  const cardList = data.cardList
  if (!Array.isArray(cardList)) {
    fail('VALIDATION', '商品列表响应缺少 cardList 数组')
  }
  const items: ItemSummary[] = []
  for (const [index, card] of cardList.entries()) {
    const item = parseItemCard(card, index, accountId.trim(), updatedAt)
    if (item !== undefined) items.push(item)
  }
  return {
    items,
    hasMore: optionalFlag(data.hasMore) ?? false,
    pageNumber: optionalInteger(data.pageNumber, 'pageNumber') ?? DEFAULT_PAGE_NUMBER,
  }
}

/**
 * 从商品详情响应取 sellerDO.sellerId（商家唯一 ID），字符串/数字都接受。
 * 商品链接 → 商家 ID → 商品列表这条链路的入口；缺失时 VALIDATION（绝不猜一个 id）。
 */
export function extractSellerIdFromDetail(raw: unknown): string {
  const data = unwrapData(raw, 'extractSellerIdFromDetail')
  const sellerDO = data.sellerDO
  if (!isRecord(sellerDO)) {
    fail('VALIDATION', '详情响应缺少 sellerDO，无法确定商家 ID')
  }
  const sellerId = sellerDO.sellerId
  if (typeof sellerId === 'string' && sellerId.trim().length > 0) return sellerId.trim()
  if (typeof sellerId === 'number' && Number.isSafeInteger(sellerId) && sellerId >= 0) return String(sellerId)
  return fail('VALIDATION', '详情响应缺少 sellerDO.sellerId，无法确定商家 ID')
}
