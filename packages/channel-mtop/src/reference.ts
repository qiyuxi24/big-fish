/**
 * 商品详情 → 「参考分析」用的富字段解析 + 汇总（纯函数、零 IO）。
 *
 * 为什么要单独一层：`parseItemDetail` 只产出 core 的 ItemSummary（6 个字段，供 items 落库），
 * 而「采集参考」要的是**结构统计**（价格带 / 标题长度 / 类目分布 / 属性 / 卖点词频 / 商家量级），
 * 这些字段只在详情响应里，且字段名是平台内部形态，必须一处收口、单独测。
 *
 * 实测抓包（2026-10-21，CDP 登录态 + mtop.taobao.idle.pc.detail，样本见 .scratch/collect/detail.json）：
 * data.itemDO{itemId(数字),title,desc,richTextDesc{children...},soldPrice("100" 元字符串),
 *   categoryId,itemCatDTO{catId,rootChannelCatId,level2ChannelCatId,...},imageInfos[*]{url,widthSize,heightSize},
 *   cpvLabels[{propertyName,valueName}],browseCnt,wantCnt,collectCnt,soldCnt,quantity,gmtCreate(毫秒)}
 * data.b2cItemDO.wantBuyCount（移动端形态的「想要」数）
 * data.sellerDO{sellerId(数字),nick,city,itemCount,userRegDay(注册年份),hasSoldNumInteger,xianyuSummary,
 *   sellerItems[*]{itemId,title,text:"¥30",attributeMap{gmtShelf,firstPrice,poiName}}}
 *
 * 合规红线（AGENTS §1.6 不搬运他人商品、不倒卖数据）：本模块**只产出统计与文本结构**，
 * 不下载原图、不返回可直接复用的图片地址、不拼装可发布草稿。要不要放开「跨账号搬家自己的商品」
 * 属于产品决策，不在这里实现（见 docs/repost-feature-parity.md）。
 * @module @bigfish/channel-mtop/reference
 */
import { fail } from '@bigfish/core'
import type { SellerItemCopyFeatures, SellerItemImageFeatures } from '@bigfish/core'
import { centsFromYuan } from './api.ts'
import { analyzeCopyStructure, analyzeImageFeatures } from './features.ts'

type UnknownRecord = Record<string, unknown>

/** 商家量级摘要；响应里没有的字段保持 undefined，绝不填 0。 */
export interface ReferenceSeller {
  sellerId: string
  nick?: string
  city?: string
  itemCount?: number
  /** 平台给的注册年份（userRegDay），不是完整时间戳。 */
  registeredYear?: number
  soldCount?: number
  summary?: string
}

/** 平台属性（成色/类型/服务区域…），只保留「属性名 → 取值文本」。 */
export interface ReferenceProperty {
  name: string
  value: string
}

/** 商家其它在售商品的轻量条目（用于看价位带与品类组合，不取图）。 */
export interface ReferenceSiblingItem {
  itemId: string
  title: string
  priceCents?: number
}

/** 单件商品的参考分析原料。 */
export interface ReferenceItem {
  itemId: string
  title: string
  desc?: string
  priceCents: number
  originalPriceCents?: number
  categoryId?: string
  properties: ReferenceProperty[]
  /** 主图数量（只计数，不返回图片地址）。 */
  imageCount: number
  browseCount?: number
  wantCount?: number
  collectCount?: number
  soldCount?: number
  /** 发布时间（毫秒）；itemDO.gmtCreate 不在时缺省。 */
  publishedAt?: number
  seller: ReferenceSeller
  siblingItems: ReferenceSiblingItem[]
  /** 文案结构特征（只数字与开关，不含原文）。 */
  copyFeatures: SellerItemCopyFeatures
  /** 主图构成特征（张数 + 比例分类，不含地址）。 */
  imageFeatures: SellerItemImageFeatures
}

/** 汇总结果：一堆商品的价位带、标题长度、类目分布、卖点词。 */
export interface ReferenceSummary {
  count: number
  priceCents: { min: number; median: number; max: number; avg: number }
  titleLength: { min: number; max: number; avg: number }
  imageCountAvg: number
  /** 带描述的商品占比（0..1）。 */
  descRatio: number
  categories: { categoryId: string; count: number }[]
  keywords: { word: string; count: number }[]
  /** 主图比例分布（学「这个类目都拍什么比例」用）。 */
  imageAspect: Record<SellerItemImageFeatures['aspect'], number>
  /** 文案结构均值：标题段数 / 描述句数 / 带标签占比 / 有行动号召占比。 */
  copyStructure: {
    titleSegmentsAvg: number
    descSentencesAvg: number
    bracketTagRatio: number
    ctaRatio: number
  }
}

/** 标题里没有被当成「卖点词」的字（虚词/高频停用字），只用于过滤纯虚词片段。 */
const STOP_CHARS = '的了和与及或在是有我你他她它们这那个一不就都也还很更最让把被从而且然后因为所以如果就是吗呢吧啊哦嗯么之其以为对将会能可要需请拍下链接'

/** 汇总默认取前 10 个词、前 5 个类目。 */
const DEFAULT_TOP_KEYWORDS = 10
const DEFAULT_TOP_CATEGORIES = 5

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapData(raw: unknown, purpose: string): UnknownRecord {
  if (!isRecord(raw)) fail('VALIDATION', purpose + ' 需要对象响应')
  const data = raw.data
  if (isRecord(data)) return data
  return raw
}

/** 平台 id 字段可能是数字或字符串；空值/非法值一律当「没有」。 */
function optionalId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return undefined
}

function requireId(value: unknown, field: string): string {
  const id = optionalId(value)
  if (id === undefined) fail('VALIDATION', '详情响应缺少 ' + field + '，无法做参考分析')
  return id
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length === 0 ? undefined : text
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const num = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  if (!Number.isSafeInteger(num) || num < 0) {
    fail('VALIDATION', field + ' 不是合法的非负整数：' + String(value).slice(0, 40))
  }
  return num
}

/** 富文本 desc 是 Slate 形态；只把 Text 节点拼起来，别把结构塞进描述。 */
function flattenRichText(node: unknown, depth = 0): string {
  if (depth > 8 || node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map((child) => flattenRichText(child, depth + 1)).join('')
  const record = node as UnknownRecord
  const text = typeof record.text === 'string' ? record.text : ''
  const children = Array.isArray(record.children) ? record.children.map((child) => flattenRichText(child, depth + 1)).join('') : ''
  return (text + children).trim()
}

function pickDesc(item: UnknownRecord): string | undefined {
  const direct = optionalText(item.desc)
  if (direct !== undefined) return direct
  const rich = flattenRichText(item.richTextDesc)
  return rich.length === 0 ? undefined : rich
}

/** cpvLabels 是平台属性列表；只保留能读的「属性名/取值」，跳过硬凑形态。 */
function pickProperties(item: UnknownRecord): ReferenceProperty[] {
  const raw = item.cpvLabels
  if (!Array.isArray(raw)) return []
  const out: ReferenceProperty[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const name = optionalText(entry.propertyName)
    const value = optionalText(entry.valueName)
    if (name === undefined || value === undefined) continue
    out.push({ name, value })
    if (out.length >= 30) break
  }
  return out
}

function pickPriceCents(item: UnknownRecord): number | undefined {
  for (const field of ['soldPrice', 'price', 'defaultPrice', 'originalPrice']) {
    const cents = centsFromYuan(item[field], field)
    if (cents !== undefined) return cents
  }
  return undefined
}

function pickSeller(data: UnknownRecord): ReferenceSeller {
  const seller = isRecord(data.sellerDO) ? data.sellerDO : isRecord(data.b2cSellerDO) ? data.b2cSellerDO : {}
  const sellerId = optionalId(seller.sellerId)
  if (sellerId === undefined) fail('VALIDATION', '详情响应缺少 sellerDO.sellerId，无法做参考分析')
  const registeredYear = optionalCount(seller.userRegDay, 'sellerDO.userRegDay')
  const soldCount = optionalCount(seller.hasSoldNumInteger, 'sellerDO.hasSoldNumInteger')
  const itemCount = optionalCount(seller.itemCount, 'sellerDO.itemCount')
  const nick = optionalText(seller.nick)
  const city = optionalText(seller.city)
  const summary = optionalText(seller.xianyuSummary)
  return {
    sellerId,
    ...(nick === undefined ? {} : { nick }),
    ...(city === undefined ? {} : { city }),
    ...(itemCount === undefined ? {} : { itemCount }),
    ...(registeredYear === undefined ? {} : { registeredYear }),
    ...(soldCount === undefined ? {} : { soldCount }),
    ...(summary === undefined ? {} : { summary }),
  }
}

/** sellerItems 里的价格是展示文案（"¥30"），解析不出来就不给价格，不猜。 */
function priceCentsFromText(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const match = /^[^0-9]*(\d+(?:\.\d{1,2})?)/.exec(text)
  if (match === null) return undefined
  return centsFromYuan(match[1], 'sellerItems.text')
}

function pickSiblings(data: UnknownRecord): ReferenceSiblingItem[] {
  const seller = isRecord(data.sellerDO) ? data.sellerDO : {}
  const raw = seller.sellerItems
  if (!Array.isArray(raw)) return []
  const out: ReferenceSiblingItem[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const itemId = optionalId(entry.itemId)
    const title = optionalText(entry.title)
    if (itemId === undefined || title === undefined) continue
    const priceCents = priceCentsFromText(optionalText(entry.text))
    out.push({ itemId, title, ...(priceCents === undefined ? {} : { priceCents }) })
    if (out.length >= 20) break
  }
  return out
}

function countImages(item: UnknownRecord): number {
  const infos = item.imageInfos
  return Array.isArray(infos) ? infos.length : 0
}

/**
 * 详情响应 → ReferenceItem。
 * 容错 `{data:{itemDO}}`、`{data:{itemCardDO}}`、`{data:{...扁平}}` 三种形态。
 */
export function parseItemReference(raw: unknown): ReferenceItem {
  const data = unwrapData(raw, 'parseItemReference')
  const candidates = [data.itemDO, data.itemCardDO]
  const item = candidates.find((candidate): candidate is UnknownRecord => isRecord(candidate) && Object.keys(candidate).length > 0) ?? data
  const itemId = requireId(item.itemId ?? data.itemId, 'itemId')
  const title = optionalText(item.title)
  if (title === undefined) fail('VALIDATION', '详情响应缺少 title，无法做参考分析')
  const desc = pickDesc(item)
  const priceCents = pickPriceCents(item) ?? 0
  const originalPriceCents = centsFromYuan(item.originalPrice, 'originalPrice')
  const categoryId = optionalId(item.categoryId) ?? optionalId(isRecord(item.itemCatDTO) ? item.itemCatDTO.catId : undefined)
  const b2c = isRecord(data.b2cItemDO) ? data.b2cItemDO : {}
  const browseCount = optionalCount(item.browseCnt, 'itemDO.browseCnt')
  const wantCount = optionalCount(item.wantCnt, 'itemDO.wantCnt') ?? optionalCount(b2c.wantBuyCount, 'b2cItemDO.wantBuyCount')
  const collectCount = optionalCount(item.collectCnt, 'itemDO.collectCnt')
  const soldCount = optionalCount(item.soldCnt, 'itemDO.soldCnt')
  const publishedAt = optionalCount(item.gmtCreate, 'itemDO.gmtCreate')
  return {
    itemId,
    title,
    ...(desc === undefined ? {} : { desc }),
    priceCents,
    ...(originalPriceCents === undefined ? {} : { originalPriceCents }),
    ...(categoryId === undefined ? {} : { categoryId }),
    properties: pickProperties(item),
    imageCount: countImages(item),
    ...(browseCount === undefined ? {} : { browseCount }),
    ...(wantCount === undefined ? {} : { wantCount }),
    ...(collectCount === undefined ? {} : { collectCount }),
    ...(soldCount === undefined ? {} : { soldCount }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    seller: pickSeller(data),
    siblingItems: pickSiblings(data),
    copyFeatures: analyzeCopyStructure(title, desc),
    imageFeatures: analyzeImageFeatures(item.imageInfos),
  }
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) sum += value
  return Math.round(sum / values.length)
}

/** 纯虚词片段（每个字都在停用表里）没有区分度，直接丢掉。 */
function isMeaningless(fragment: string): boolean {
  for (const char of fragment) {
    if (!STOP_CHARS.includes(char)) return false
  }
  return true
}

/**
 * 从标题里抽「卖点词」：中文片段按 2..6 字整段计一次 + 段内 2-gram 计一次，
 * 英文/数字按连续串（≥2）计一次。确定性、零依赖（不引入分词库，AGENTS §3 禁新增依赖）。
 */
export function extractTitleKeywords(titles: readonly string[], limit = DEFAULT_TOP_KEYWORDS): { word: string; count: number }[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail('VALIDATION', 'extractTitleKeywords 的 limit 必须在 1..100 之间：' + String(limit))
  }
  const counts = new Map<string, number>()
  // 片段内部的 2-gram 常常跨词边界（「考研数学笔记」切出「研数」「学笔」），直接进高频词就是把噪声喂给文案提示词。
  // 只保留出现在片段首尾的 2-gram；整段片段与英文/数字串本来就可信，不进这个「可疑」集合。
  const innerOnly = new Set<string>()
  const boundary = new Set<string>()
  const bump = (word: string): void => {
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  for (const title of titles) {
    const cjkRuns = title.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
    for (const run of cjkRuns) {
      if (run.length <= 6 && !isMeaningless(run)) bump(run)
      // 2 字片段上面已经整段计过一次，再走 2-gram 会重复计，故只在 3 字以上时切 bigram。
      if (run.length > 2) {
        for (let index = 0; index + 2 <= run.length; index += 1) {
          const bigram = run.slice(index, index + 2)
          if (isMeaningless(bigram)) continue
          bump(bigram)
          if (index === 0 || index + 2 === run.length) boundary.add(bigram)
          else innerOnly.add(bigram)
        }
      }
    }
    const latin = title.match(/[A-Za-z0-9]{2,}/g) ?? []
    for (const word of latin) bump(word)
  }
  return [...counts.entries()]
    .filter(([word, count]) => count >= 2 && !(innerOnly.has(word) && !boundary.has(word)))
    .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }))
}

/** 多件商品的统计汇总（价格带/标题长度/类目/卖点词/主图数/描述覆盖率）。 */
export function summarizeReferences(
  items: readonly ReferenceItem[],
  options: { topKeywords?: number; topCategories?: number } = {},
): ReferenceSummary {
  if (!Array.isArray(items)) fail('VALIDATION', 'summarizeReferences 需要 ReferenceItem 数组')
  const topKeywords = options.topKeywords ?? DEFAULT_TOP_KEYWORDS
  const topCategories = options.topCategories ?? DEFAULT_TOP_CATEGORIES
  const prices = items.map((item) => item.priceCents).sort((left, right) => left - right)
  const lengths = items.map((item) => item.title.length)
  const categoryCounts = new Map<string, number>()
  for (const item of items) {
    if (item.categoryId === undefined) continue
    categoryCounts.set(item.categoryId, (categoryCounts.get(item.categoryId) ?? 0) + 1)
  }
  const categories = [...categoryCounts.entries()]
    .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))
    .slice(0, topCategories)
    .map(([categoryId, count]) => ({ categoryId, count }))
  const withDesc = items.filter((item) => (item.desc ?? '').length > 0).length
  const aspectCount = (target: SellerItemImageFeatures['aspect']): number =>
    items.filter((item) => item.imageFeatures.aspect === target).length
  const ratio = (hit: number): number => (items.length === 0 ? 0 : Math.round((hit / items.length) * 100) / 100)
  return {
    count: items.length,
    priceCents: {
      min: prices[0] ?? 0,
      median: median(prices),
      max: prices[prices.length - 1] ?? 0,
      avg: average(prices),
    },
    titleLength: {
      min: lengths.length === 0 ? 0 : Math.min(...lengths),
      max: lengths.length === 0 ? 0 : Math.max(...lengths),
      avg: average(lengths),
    },
    imageCountAvg: average(items.map((item) => item.imageCount)),
    descRatio: ratio(withDesc),
    categories,
    keywords: extractTitleKeywords(items.map((item) => item.title), topKeywords),
    imageAspect: {
      square: aspectCount('square'),
      portrait: aspectCount('portrait'),
      landscape: aspectCount('landscape'),
      mixed: aspectCount('mixed'),
      unknown: aspectCount('unknown'),
    },
    copyStructure: {
      titleSegmentsAvg: average(items.map((item) => item.copyFeatures.titleSegments)),
      descSentencesAvg: average(items.map((item) => item.copyFeatures.descSentences)),
      bracketTagRatio: ratio(items.filter((item) => item.copyFeatures.hasBracketTag).length),
      ctaRatio: ratio(items.filter((item) => item.copyFeatures.ctaCount > 0).length),
    },
  }
}
