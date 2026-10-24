/**
 * 市场简报：把已采集入库的他人商品快照（seller_items）折成「价位带 + 文案/图片结构」，
 * 给链路的第 2 步（生成文案 / 定价）当输入。
 *
 * 为什么独立成文件：仓储层（seller-items.ts）只该管 SQL；统计口径必须是纯函数、零 IO、
 * 可单测，也方便将来插件 / agent 直接调。它与 channel-mtop 的 summarizeReferences
 * 形状相近但语义不同：后者是「单次采集会话」的汇总（含关键词/类目），这里则是
 * **跨采集、跨商家**的行情快照，两者不互相 import（AGENTS §2 依赖方向）。
 *
 * 金额口径：一律整数分，分位用最近秩法（nearest-rank），全程整数加法与整数除法，
 * 不对金额做浮点乘法（AGENTS §3）。比例字段保留两位小数。
 * @module @bigfish/core/market-brief
 */
import { fail } from './errors.ts'
import type { SellerItemCopyFeatures, SellerItemImageFeatures } from './seller-features.ts'

/** 聚合输入：只带统计用到的维度；titleLength 由调用方从 title 算（仓储不重复存）。 */
export interface MarketBriefItem {
  priceCents: number
  titleLength: number
  imageCount: number
  /** 采集时没算就缺省：缺省项不参与对应均值，也不记成 0。 */
  copyFeatures?: SellerItemCopyFeatures
  /** 采集时没算就缺省：缺省项在主图比例分布里计入 unknown（保证分布合计 = sampleSize）。 */
  imageFeatures?: SellerItemImageFeatures
}

/** 商品成色档位；与「发布前处理」面板的成色选项一致。 */
export type PriceCondition = 'new' | 'like-new' | 'light-wear' | 'visible-wear' | 'flawed'

/** 市场简报：一堆样本的价格分位与结构均值。 */
export interface MarketBrief {
  sampleSize: number
  priceCents: { p25: number; p50: number; p75: number; min: number; max: number }
  titleLength: { min: number; max: number; avg: number }
  titleSegmentsAvg: number
  descSentencesAvg: number
  /** 带行动号召的文案占比（0..1，两位小数）。 */
  ctaRatio: number
  /** 用【】[]（）打标签的文案占比（0..1，两位小数）。 */
  bracketTagRatio: number
  imageCountAvg: number
  /** 主图比例分布（**件数**，不是占比；合计 = sampleSize）。 */
  imageAspect: Record<SellerItemImageFeatures['aspect'], number>
}

/** 建议价：区间 + 中位 + 依据；basis 只含整数分与万分比，便于原样回显给用户。 */
export interface PriceSuggestion {
  lowCents: number
  suggestedCents: number
  highCents: number
  basis: string
}

/**
 * 成色系数（万分比，10000 = 不加价也不折价）。
 *
 * 为什么是这几个数：二手平台的实际成交价主要由「同款在售价的中位」决定，成色只做
 * 一档修正，不做精细估价——平台没有公开成交样本，过度拟合反而制造假精确。
 * 档位取 5% / 10% 的整数步长，面板上一眼看懂、也便于以后整体调档：
 * - new（全新未拆）+20%：同款全新可对标官方价下浮空间；
 * - like-new（近全新）不动：默认锚点，即「中位价就是这类货的价」；
 * - light-wear（轻微痕迹）-15%、visible-wear（明显使用痕迹）-30%；
 * - flawed（有瑕疵）-50%：瑕疵品的成交价折半是二手市场常见区间，再低就该当配件卖。
 * 全部用整数万分比而不是 1.2/0.85 这类浮点，避免浮点乘金额（AGENTS §3）。
 */
const CONDITION_FACTOR_BP: Readonly<Record<PriceCondition, number>> = {
  new: 12000,
  'like-new': 10000,
  'light-wear': 8500,
  'visible-wear': 7000,
  flawed: 5000,
}

/** 夹取下限：闲鱼最低可挂 ¥1（100 分），低于它的建议价没有可执行性。 */
const MIN_PRICE_CENTS = 100

/** 空样本简报：分位与均值一律 0，绝不编造一个「参考价」。 */
function emptyBrief(): MarketBrief {
  return {
    sampleSize: 0,
    priceCents: { p25: 0, p50: 0, p75: 0, min: 0, max: 0 },
    titleLength: { min: 0, max: 0, avg: 0 },
    titleSegmentsAvg: 0,
    descSentencesAvg: 0,
    ctaRatio: 0,
    bracketTagRatio: 0,
    imageCountAvg: 0,
    imageAspect: { square: 0, portrait: 0, landscape: 0, mixed: 0, unknown: 0 },
  }
}

/** 非负安全整数（库里已校验过一次，这里再挡直接调用方与损坏数据）。 */
function readCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('VALIDATION', 'market brief 的 ' + field + ' 必须是非负安全整数：' + String(value).slice(0, 40))
  }
  return value
}

/**
 * 最近秩法分位：第 ceil(p/100 × n) 个样本（1 基），0 基下标 = floor((p×n - 1) / 100)。
 * 为什么不用线性插值：插值要对金额做除法与四舍五入，口径被浮点细节左右；
 * 最近秩在采集样本量很小（通常 20..200 件）时更稳、也更好向用户解释「这是第几件价」。
 */
function percentile(sorted: readonly number[], percent: number): number {
  const rank = Math.floor((percent * sorted.length - 1) / 100)
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? 0
}

/** 整数均值（四舍五入）；空集合返回 0。 */
function average(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) sum += value
  return Math.round(sum / values.length)
}

/** 占比（0..1，两位小数）；空集合返回 0。 */
function ratio(hit: number, total: number): number {
  return total === 0 ? 0 : Math.round((hit * 100) / total) / 100
}

/** 主图比例分布：没采到特征的计 unknown，面板看到的分布合计才等于样本数。 */
function countAspects(items: readonly MarketBriefItem[]): Record<SellerItemImageFeatures['aspect'], number> {
  const counts: Record<SellerItemImageFeatures['aspect'], number> = { square: 0, portrait: 0, landscape: 0, mixed: 0, unknown: 0 }
  for (const item of items) {
    const aspect = item.imageFeatures === undefined ? 'unknown' : item.imageFeatures.aspect
    counts[aspect] += 1
  }
  return counts
}

/** 多件商品的行情汇总；空数组返回 sampleSize=0 的全 0 简报。 */
export function summarizeMarketBrief(items: readonly MarketBriefItem[]): MarketBrief {
  if (!Array.isArray(items)) fail('VALIDATION', 'summarizeMarketBrief 需要 MarketBriefItem 数组')
  if (items.length === 0) return emptyBrief()
  const prices = items.map((item) => readCount(item.priceCents, 'priceCents')).sort((left, right) => left - right)
  const lengths = items.map((item) => readCount(item.titleLength, 'titleLength'))
  const imageCounts = items.map((item) => readCount(item.imageCount, 'imageCount'))
  const copy = items.flatMap((item) => (item.copyFeatures === undefined ? [] : [item.copyFeatures]))
  return {
    sampleSize: items.length,
    priceCents: {
      p25: percentile(prices, 25),
      p50: percentile(prices, 50),
      p75: percentile(prices, 75),
      min: prices[0] ?? 0,
      max: prices[prices.length - 1] ?? 0,
    },
    titleLength: { min: Math.min(...lengths), max: Math.max(...lengths), avg: average(lengths) },
    titleSegmentsAvg: average(copy.map((features) => features.titleSegments)),
    descSentencesAvg: average(copy.map((features) => features.descSentences)),
    ctaRatio: ratio(copy.filter((features) => features.ctaCount > 0).length, copy.length),
    bracketTagRatio: ratio(copy.filter((features) => features.hasBracketTag).length, copy.length),
    imageCountAvg: average(imageCounts),
    imageAspect: countAspects(items),
  }
}

/** 成色系数查找；非法取值按 VALIDATION 拒（不让拼错的 condition 静默按 10000 处理）。 */
function readFactorBp(condition: unknown): number {
  const factor = typeof condition === 'string' && Object.prototype.hasOwnProperty.call(CONDITION_FACTOR_BP, condition)
    ? CONDITION_FACTOR_BP[condition as PriceCondition]
    : undefined
  if (factor === undefined) {
    fail('VALIDATION', 'condition 必须是 new/like-new/light-wear/visible-wear/flawed 之一：' + String(condition).slice(0, 20))
  }
  return factor
}

/** 整数分 × 万分比系数；先乘后除，避免浮点乘金额。 */
function applyFactorBp(cents: number, factorBp: number): number {
  return Math.round((cents * factorBp) / 10000)
}

/** 夹到最低可挂价；只抬下限，不设上限（用户自己的货想高价卖是他的自由）。 */
function clampCents(cents: number): number {
  return cents < MIN_PRICE_CENTS ? MIN_PRICE_CENTS : cents
}

/**
 * 按成色给建议价：区间取 p25..p75 同系数缩放，中位取 p50 同系数缩放。
 * 样本为 0 返回 null（没有行情就不该有建议价）；非法 condition 抛 VALIDATION。
 * 夹取有两层：最低 ¥1，以及保证 low ≤ suggested ≤ high（缩放后可能因下限被抬平）。
 */
export function suggestPriceCents(brief: MarketBrief, condition: PriceCondition): PriceSuggestion | null {
  const factorBp = readFactorBp(condition)
  if (typeof brief !== 'object' || brief === null) fail('VALIDATION', 'suggestPriceCents 需要 MarketBrief 对象')
  const sampleSize = readCount(brief.sampleSize, 'sampleSize')
  if (sampleSize === 0) return null
  const { p25, p50, p75 } = brief.priceCents
  const suggestedCents = clampCents(applyFactorBp(readCount(p50, 'priceCents.p50'), factorBp))
  const lowCents = Math.min(clampCents(applyFactorBp(readCount(p25, 'priceCents.p25'), factorBp)), suggestedCents)
  const highCents = Math.max(clampCents(applyFactorBp(readCount(p75, 'priceCents.p75'), factorBp)), suggestedCents)
  return {
    lowCents,
    suggestedCents,
    highCents,
    basis: 'condition=' + condition + '；anchor=p50 ' + p50 + ' 分；factorBp=' + factorBp
      + '；low=p25 ' + p25 + ' 分；high=p75 ' + p75 + ' 分',
  }
}
