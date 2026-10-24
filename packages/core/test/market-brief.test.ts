/**
 * market-brief.ts 的行为测试：纯函数、整数分、确定性。
 * 分位用最近秩法（nearest-rank），期望值手算后再断言，避免「跑一遍存快照」式测试。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { XianyuError } from '../src/errors.ts'
import { suggestPriceCents, summarizeMarketBrief } from '../src/market-brief.ts'
import type { MarketBriefItem } from '../src/market-brief.ts'
import type { SellerItemCopyFeatures } from '../src/seller-features.ts'

function copy(overrides: Partial<SellerItemCopyFeatures> = {}): SellerItemCopyFeatures {
  return {
    titleChars: 10, descChars: 50, titleSegments: 2, descParagraphs: 1, descSentences: 3,
    avgSentenceChars: 16, bulletLines: 0, hasBracketTag: false, emojiCount: 0, titleDigitGroups: 0,
    ctaCount: 0,
    ...overrides,
  }
}

function sampleItems(): MarketBriefItem[] {
  return [
    { priceCents: 1000, titleLength: 10, imageCount: 1, copyFeatures: copy({ titleSegments: 1, descSentences: 2, ctaCount: 0, hasBracketTag: true }), imageFeatures: { count: 1, aspect: 'square', measured: 1 } },
    { priceCents: 2000, titleLength: 20, imageCount: 2, copyFeatures: copy({ titleSegments: 2, descSentences: 3, ctaCount: 1, hasBracketTag: false }), imageFeatures: { count: 2, aspect: 'portrait', measured: 2 } },
    { priceCents: 3000, titleLength: 30, imageCount: 3, copyFeatures: copy({ titleSegments: 3, descSentences: 4, ctaCount: 1, hasBracketTag: true }), imageFeatures: { count: 3, aspect: 'square', measured: 3 } },
    { priceCents: 4000, titleLength: 40, imageCount: 6 },
  ]
}

test('summarizeMarketBrief：价格分位 / 结构均值 / 主图比例分布', () => {
  const brief = summarizeMarketBrief(sampleItems())
  assert.equal(brief.sampleSize, 4)
  // 最近秩：n=4 时 p25→第 1 件、p50→第 2 件、p75→第 3 件。
  assert.deepEqual(brief.priceCents, { p25: 1000, p50: 2000, p75: 3000, min: 1000, max: 4000 })
  assert.deepEqual(brief.titleLength, { min: 10, max: 40, avg: 25 })
  assert.equal(brief.titleSegmentsAvg, 2)
  assert.equal(brief.descSentencesAvg, 3)
  // 3 件有文案特征：ctaCount>0 的 2 件、带【】的 2 件 → 0.67（两位小数）。
  assert.equal(brief.ctaRatio, 0.67)
  assert.equal(brief.bracketTagRatio, 0.67)
  // (1+2+3+6)/4 = 3，整数均值。
  assert.equal(brief.imageCountAvg, 3)
  // 分布是**件数**且合计 = 样本数；没采到特征的计 unknown。
  assert.deepEqual(brief.imageAspect, { square: 2, portrait: 1, landscape: 0, mixed: 0, unknown: 1 })
  assert.equal(Object.values(brief.imageAspect).reduce((sum, count) => sum + count, 0), brief.sampleSize)
})

test('summarizeMarketBrief：空数组 → sampleSize=0 且分位全 0（不编造参考价）', () => {
  const brief = summarizeMarketBrief([])
  assert.equal(brief.sampleSize, 0)
  assert.deepEqual(brief.priceCents, { p25: 0, p50: 0, p75: 0, min: 0, max: 0 })
  assert.deepEqual(brief.titleLength, { min: 0, max: 0, avg: 0 })
  assert.deepEqual(brief.imageAspect, { square: 0, portrait: 0, landscape: 0, mixed: 0, unknown: 0 })
  assert.equal(brief.ctaRatio, 0)
  assert.equal(suggestPriceCents(brief, 'like-new'), null)
})

test('summarizeMarketBrief：单样本分位都等于该样本价；缺文案特征时比例为 0 而不是 NaN', () => {
  const brief = summarizeMarketBrief([{ priceCents: 888, titleLength: 3, imageCount: 0 }])
  assert.equal(brief.sampleSize, 1)
  assert.deepEqual(brief.priceCents, { p25: 888, p50: 888, p75: 888, min: 888, max: 888 })
  assert.equal(brief.titleSegmentsAvg, 0)
  assert.equal(brief.ctaRatio, 0)
  assert.equal(brief.imageAspect.unknown, 1)
})

test('summarizeMarketBrief：非法输入（负价 / 非整数）→ VALIDATION', () => {
  const bad = (item: MarketBriefItem, code: string): void => {
    assert.throws(() => summarizeMarketBrief([item]), (error: unknown) => error instanceof XianyuError && error.code === code)
  }
  bad({ priceCents: -1, titleLength: 1, imageCount: 0 }, 'VALIDATION')
  bad({ priceCents: 1.5, titleLength: 1, imageCount: 0 }, 'VALIDATION')
  bad({ priceCents: 100, titleLength: Number.NaN, imageCount: 0 }, 'VALIDATION')
  bad({ priceCents: 100, titleLength: 1, imageCount: -3 }, 'VALIDATION')
})

test('suggestPriceCents：各成色档位按万分比缩放，区间取 p25..p75', () => {
  const brief = summarizeMarketBrief(sampleItems())
  const likeNew = suggestPriceCents(brief, 'like-new')
  assert.ok(likeNew !== null)
  assert.deepEqual({ low: likeNew.lowCents, mid: likeNew.suggestedCents, high: likeNew.highCents }, { low: 1000, mid: 2000, high: 3000 })
  assert.match(likeNew.basis, /factorBp=10000/)
  assert.match(likeNew.basis, /anchor=p50 2000 分/)

  const brandNew = suggestPriceCents(brief, 'new')
  assert.deepEqual({ low: brandNew?.lowCents, mid: brandNew?.suggestedCents, high: brandNew?.highCents }, { low: 1200, mid: 2400, high: 3600 })

  const lightWear = suggestPriceCents(brief, 'light-wear')
  assert.deepEqual({ low: lightWear?.lowCents, mid: lightWear?.suggestedCents, high: lightWear?.highCents }, { low: 850, mid: 1700, high: 2550 })

  const flawed = suggestPriceCents(brief, 'flawed')
  assert.deepEqual({ low: flawed?.lowCents, mid: flawed?.suggestedCents, high: flawed?.highCents }, { low: 500, mid: 1000, high: 1500 })
  // 金额必须是整数分（不允许浮点乘出来的 0.1 分）。
  for (const value of [flawed?.lowCents, flawed?.suggestedCents, flawed?.highCents, lightWear?.highCents]) {
    assert.ok(Number.isInteger(value))
  }
})

test('suggestPriceCents：最低 ¥1 夹取，且保证 low ≤ suggested ≤ high', () => {
  const brief = summarizeMarketBrief([{ priceCents: 10, titleLength: 1, imageCount: 0 }])
  const suggestion = suggestPriceCents(brief, 'flawed')
  assert.ok(suggestion !== null)
  assert.deepEqual({ low: suggestion.lowCents, mid: suggestion.suggestedCents, high: suggestion.highCents }, { low: 100, mid: 100, high: 100 })
})

test('suggestPriceCents：样本为 0 → null；condition 非法 → VALIDATION；同输入结果确定', () => {
  const empty = summarizeMarketBrief([])
  assert.equal(suggestPriceCents(empty, 'new'), null)
  const brief = summarizeMarketBrief(sampleItems())
  assert.throws(() => suggestPriceCents(brief, 'mint' as unknown as 'new'), (error: unknown) => error instanceof XianyuError && error.code === 'VALIDATION')
  assert.deepEqual(suggestPriceCents(brief, 'visible-wear'), suggestPriceCents(brief, 'visible-wear'))
})
