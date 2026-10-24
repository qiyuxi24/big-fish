/**
 * 「市场简报」HTTP 路由：把已入库的他人商品快照折成行情，供第 2 步「生成文案 / 定价」消费。
 *
 * 为什么单独成文件：这是**跨商家**的读聚合，不属于「采集」域（seller-routes 只读单商家），
 * 也不该把统计口径写进路由——数值统计在 core（纯函数、可单测），这里只做取数与组装。
 * 纯读：不写库、不触网、不调 LLM。
 * @module @bigfish/daemon/routes-market
 */
import { fail, suggestPriceCents, summarizeMarketBrief } from '@bigfish/core'
import type { MarketBrief, MarketBriefItem, PriceCondition, PriceSuggestion, SellerItemRecord, SellerRepository } from '@bigfish/core'
import { extractTitleKeywords } from '@bigfish/channel-mtop'
import { asRecord, ok, optionalPositiveInt, optionalString, readJsonBody, sendJson } from './http.ts'
import type { Route, RouteContext } from './routes.ts'

/** 缺省条数：一次采集上限 500 件，默认取 200 已足够让分位稳定又不必扫全库。 */
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500
/** 关键词条数与 extractTitleKeywords 的缺省一致（面板一行放得下 10 个）。 */
const MAX_KEYWORDS = 10
/** 缺省成色：近全新 = 锚点（中位价本身就是「这类货的价」）。 */
const DEFAULT_CONDITION: PriceCondition = 'like-new'
const CONDITION_VALUES = new Set<string>(['new', 'like-new', 'light-wear', 'visible-wear', 'flawed'])
const ID_RE = /^[0-9]{1,20}$/

/** 解析后的简报请求；condition 已窄化成 PriceCondition，下游不必再校验。 */
interface BriefQuery {
  categoryId?: string
  sellerId?: string
  limit: number
  condition: PriceCondition
}

/** 简报响应体：无样本时 brief/priceSuggestion 为 null，其余字段保持形状稳定。 */
interface MarketBriefResponse {
  brief: MarketBrief | null
  priceSuggestion: PriceSuggestion | null
  sampleSize: number
  keywords: { word: string; count: number }[]
}

/** 市场简报路由；拼进 routes.ts 的 ROUTES（紧挨 sellerRoutes，同属「采集」相关读接口）。 */
export const marketRoutes: readonly Route[] = [
  { method: 'POST', pattern: /^\/market\/brief\/?$/, handler: marketBriefHandler },
]

async function marketBriefHandler(ctx: RouteContext): Promise<void> {
  const body = asRecord(await readJsonBody(ctx.req, undefined, true), '市场简报请求体')
  const query = parseBriefQuery(body)
  const repo = ctx.sellerItems ?? fail('UNSUPPORTED', 'daemon 未注入采集结果仓储')
  const rows = readRows(repo, query)
  // 无样本是正常状态（还没采集过）：200 + brief:null，让面板提示「先去采集」。
  if (rows.length === 0) {
    await sendJson(ctx.res, 200, ok(emptyResponse()), ctx.redact)
    return
  }
  const brief = summarizeRows(rows)
  const data: MarketBriefResponse = {
    brief,
    priceSuggestion: suggestPriceCents(brief, query.condition),
    sampleSize: brief.sampleSize,
    keywords: extractTitleKeywords(rows.map((row) => row.title), MAX_KEYWORDS),
  }
  await sendJson(ctx.res, 200, ok(data), ctx.redact)
}

/** 三种口径：给 sellerId 读单商家，给 categoryId 读类目，都不给读全库。 */
function readRows(repo: SellerRepository, query: BriefQuery): SellerItemRecord[] {
  if (query.sellerId !== undefined) return repo.listItems(query.sellerId, query.limit)
  if (query.categoryId !== undefined) return repo.listItemsByCategory(query.categoryId, query.limit)
  return repo.listAllItems({ limit: query.limit })
}

function parseBriefQuery(body: Record<string, unknown>): BriefQuery {
  const categoryId = readId(body, 'categoryId')
  const sellerId = readId(body, 'sellerId')
  // 两个口径同时给会让「取谁的数据」含糊；宁可让调用方明确一个。
  if (categoryId !== undefined && sellerId !== undefined) fail('VALIDATION', 'categoryId 与 sellerId 只能给一个')
  const rawLimit = optionalPositiveInt(body, 'limit', '市场简报请求体')
  if (rawLimit !== undefined && rawLimit > MAX_LIMIT) {
    fail('VALIDATION', 'limit 必须在 1..' + MAX_LIMIT + ' 之间：' + rawLimit)
  }
  const rawCondition = optionalString(body, 'condition', '市场简报请求体')
  if (rawCondition !== undefined && !CONDITION_VALUES.has(rawCondition)) {
    fail('VALIDATION', 'condition 必须是 new/like-new/light-wear/visible-wear/flawed 之一：' + rawCondition.slice(0, 20))
  }
  const condition = (rawCondition ?? DEFAULT_CONDITION) as PriceCondition
  return {
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(sellerId === undefined ? {} : { sellerId }),
    limit: rawLimit ?? DEFAULT_LIMIT,
    condition,
  }
}

/** 平台 id 是纯数字串；格式不对按 VALIDATION 拒，别让它进 SQL 参数再报 STORAGE。 */
function readId(body: Record<string, unknown>, key: 'categoryId' | 'sellerId'): string | undefined {
  const value = optionalString(body, key, '市场简报请求体')
  if (value === undefined) return undefined
  if (!ID_RE.test(value)) fail('VALIDATION', key + ' 必须是纯数字串：' + value.slice(0, 40))
  return value
}

/** 仓储行 → 统计输入；标题长度按字符（码点）数，避免 emoji 被算成 2 个字符。 */
function summarizeRows(rows: readonly SellerItemRecord[]): MarketBrief {
  const items: MarketBriefItem[] = rows.map((row) => ({
    priceCents: row.priceCents,
    titleLength: Array.from(row.title).length,
    imageCount: row.imageCount,
    ...(row.copyFeatures === undefined ? {} : { copyFeatures: row.copyFeatures }),
    ...(row.imageFeatures === undefined ? {} : { imageFeatures: row.imageFeatures }),
  }))
  return summarizeMarketBrief(items)
}

function emptyResponse(): MarketBriefResponse {
  return { brief: null, priceSuggestion: null, sampleSize: 0, keywords: [] }
}
