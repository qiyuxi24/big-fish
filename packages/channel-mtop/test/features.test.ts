/**
 * 特征提取（features.ts）：文案结构 + 主图构成。
 * 红线断言：返回值里不含标题/描述原文，也不含任何图片地址（只数字与开关）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XianyuError } from '@bigfish/core'
import { analyzeCopyStructure, analyzeImageFeatures, parseItemReference, summarizeReferences } from '../src/index.ts'

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, code)
    return
  }
  assert.fail('预期抛出 ' + code)
}

test('analyzeCopyStructure：分段 / 句数 / 清单行 / 标签 / emoji / 数字组 / 行动号召', () => {
  const features = analyzeCopyStructure(
    '【九成新】机械键盘 87 键 | 白色背光送键帽',
    '自用半年，无划痕。\n· 送一套 PBT 键帽\n· 顺丰包邮\n1. 可小刀，私聊改价',
  )
  assert.equal(features.titleChars, 24)
  assert.equal(features.titleSegments, 4)
  assert.equal(features.hasBracketTag, true)
  assert.equal(features.titleDigitGroups, 1)
  // 描述：4 行、4 句（换行与句号都算句末），清单行 3 条（· ×2 + 1.）。
  assert.equal(features.descParagraphs, 4)
  assert.equal(features.descSentences, 4)
  assert.ok(features.descChars > 0)
  assert.ok(features.avgSentenceChars > 0)
  assert.equal(features.bulletLines, 3)
  assert.equal(features.ctaCount, 4) // 顺丰 / 包邮 / 可小刀 / 私聊（只数出现过的种类）
})

test('analyzeCopyStructure：没有描述时句数与段落数为 0，不猜', () => {
  const features = analyzeCopyStructure('机械键盘', undefined)
  assert.equal(features.descChars, 0)
  assert.equal(features.descParagraphs, 0)
  assert.equal(features.descSentences, 0)
  assert.equal(features.avgSentenceChars, 0)
  assert.equal(features.titleSegments, 1)
  assert.equal(features.hasBracketTag, false)
  assert.equal(features.ctaCount, 0)
})

test('analyzeCopyStructure：入参不合法直接 VALIDATION', () => {
  expectCode('VALIDATION', () => analyzeCopyStructure('', undefined))
  expectCode('VALIDATION', () => analyzeCopyStructure(123, undefined))
  expectCode('VALIDATION', () => analyzeCopyStructure('标题', 42))
})

test('analyzeImageFeatures：宽高齐全时按 ±5% 归到方/竖/横/混排', () => {
  assert.equal(analyzeImageFeatures([{ width: 800, height: 800 }]).aspect, 'square')
  assert.equal(analyzeImageFeatures([{ width: 750, height: 1000 }]).aspect, 'portrait')
  assert.equal(analyzeImageFeatures([{ width: '1600', height: '900' }]).aspect, 'landscape')
  const mixed = analyzeImageFeatures([{ width: 800, height: 800 }, { width: 750, height: 1000 }])
  assert.equal(mixed.aspect, 'mixed')
  assert.equal(mixed.count, 2)
  assert.equal(mixed.measured, 2)
})

test('analyzeImageFeatures：真机 imageInfos 用 widthSize/heightSize（2026-10-23 实测字段）', () => {
  const mixed = analyzeImageFeatures([
    { url: 'https://img.example/a.jpg', widthSize: 512, heightSize: 512 },
    { url: 'https://img.example/b.jpg', widthSize: 2488, heightSize: 1280 },
  ])
  assert.equal(mixed.count, 2)
  assert.equal(mixed.measured, 2)
  assert.equal(mixed.aspect, 'mixed')
  assert.equal(analyzeImageFeatures([{ widthSize: 1224, heightSize: 2776 }]).aspect, 'portrait')
  assert.equal(analyzeImageFeatures([{ widthSize: '800', heightSize: '800' }]).aspect, 'square')
})

test('analyzeImageFeatures：只有 url（平台常见）时 aspect=unknown，只计数不编比例', () => {
  const features = analyzeImageFeatures([{ url: 'https://img.example/a.jpg' }, { url: 'https://img.example/b.jpg' }])
  assert.deepEqual(features, { count: 2, aspect: 'unknown', measured: 0 })
  assert.equal(analyzeImageFeatures(undefined).count, 0)
  assert.equal(analyzeImageFeatures('nope').aspect, 'unknown')
})

test('parseItemReference：带上特征，且结果里没有任何原文与图片地址', () => {
  const ref = parseItemReference({
    data: {
      itemDO: {
        itemId: 1,
        title: '九成新机械键盘 87 键 白色背光',
        desc: '自用半年，无划痕。顺丰包邮。',
        soldPrice: '129',
        imageInfos: [{ url: 'https://img.example/a.jpg', width: 800, height: 800 }],
      },
      sellerDO: { sellerId: 1, nick: '店' },
    },
  })
  assert.equal(ref.imageFeatures.aspect, 'square')
  assert.equal(ref.imageFeatures.count, 1)
  assert.equal(ref.copyFeatures.titleSegments, 4)
  assert.equal(ref.copyFeatures.descSentences, 2)
  assert.equal(ref.copyFeatures.ctaCount, 2) // 顺丰 / 包邮
  // 特征本身不含原文与图片地址（ReferenceItem 仍保留 desc 供统计用，落库那层会剥掉）。
  const featureText = JSON.stringify({ copy: ref.copyFeatures, image: ref.imageFeatures })
  assert.equal(featureText.includes('img.example'), false)
  assert.equal(featureText.includes('自用半年'), false)
  assert.equal(JSON.stringify(ref).includes('img.example'), false)
})

test('summarizeReferences：整体比例分布与结构均值', () => {
  const square = parseItemReference({
    data: {
      itemDO: { itemId: 1, title: '键盘 A 白色', soldPrice: '100', imageInfos: [{ width: 800, height: 800 }] },
      sellerDO: { sellerId: 1 },
    },
  })
  const portrait = parseItemReference({
    data: {
      itemDO: { itemId: 2, title: '键盘 B 黑色', soldPrice: '200', imageInfos: [{ width: 750, height: 1000 }] },
      sellerDO: { sellerId: 1 },
    },
  })
  const summary = summarizeReferences([square, portrait])
  assert.deepEqual(summary.imageAspect, { square: 1, portrait: 1, landscape: 0, mixed: 0, unknown: 0 })
  assert.equal(summary.copyStructure.titleSegmentsAvg, 3)
  assert.equal(summary.copyStructure.descSentencesAvg, 0)
  assert.equal(summary.copyStructure.bracketTagRatio, 0)
  assert.equal(summary.copyStructure.ctaRatio, 0)
})
