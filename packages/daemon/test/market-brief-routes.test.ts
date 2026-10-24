/**
 * POST /market/brief：真 HTTP + 真 SQLite（':memory:'），不触网。
 * 四条主断言：分位/建议价、空样本、坏参数、关键词；另加 sellerId/类目过滤。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createSellerRepository, openStore } from '@bigfish/core'
import type { SellerItemInput, SellerRepository } from '@bigfish/core'

import { asRecord, createHarness, dataOf, errorOf } from './harness.ts'
import type { DaemonHarness } from './harness.ts'

const NOW = 1_700_000_000_000
const SELLER_A = '2200000000001'
const SELLER_B = '2200000000002'
const CATEGORY = '50023914'

function makeRepo(): SellerRepository {
  const store = openStore({ path: ':memory:', now: () => NOW })
  return createSellerRepository({ store, now: () => NOW })
}

function item(overrides: Partial<SellerItemInput>): SellerItemInput {
  return {
    itemId: 'default',
    sellerId: SELLER_A,
    accountId: 'acc1',
    title: '键盘 罗技',
    priceCents: 1000,
    imageCount: 1,
    categoryId: CATEGORY,
    collectedAt: NOW,
    ...overrides,
  }
}

/** 3 件含共同词「键盘」+ 1 件耳机；价格 1000/2000/3000/4000。 */
function seed(repo: SellerRepository): void {
  repo.saveItem(item({ itemId: 'i1', title: '键盘 罗技', priceCents: 1000, imageCount: 1, collectedAt: NOW, imageFeatures: { count: 1, aspect: 'square', measured: 1 } }))
  repo.saveItem(item({ itemId: 'i2', title: '键盘 雷蛇', priceCents: 2000, imageCount: 2, collectedAt: NOW + 1000, imageFeatures: { count: 2, aspect: 'portrait', measured: 2 } }))
  repo.saveItem(item({ itemId: 'i3', sellerId: SELLER_B, title: '键盘 樱桃', priceCents: 3000, imageCount: 3, collectedAt: NOW + 2000, imageFeatures: { count: 3, aspect: 'landscape', measured: 3 } }))
  repo.saveItem(item({ itemId: 'i4', sellerId: SELLER_B, title: '耳机 索尼', priceCents: 4000, imageCount: 6, collectedAt: NOW + 3000 }))
}

async function burst(harness: DaemonHarness, body: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await harness.rawRequest({ method: 'POST', path: '/market/brief', body })
  return { status: response.status, data: asRecord(dataOf(response)) }
}

describe('POST /market/brief', () => {
  it('样本聚合：价格分位 / 标题均值 / 主图分布 / 默认成色建议价', async (t) => {
    const repo = makeRepo()
    seed(repo)
    const harness = await createHarness(t, { sellerItems: repo })

    const { status, data } = await burst(harness, '{}')
    assert.equal(status, 200)
    assert.equal(data.sampleSize, 4)
    assert.deepEqual(data.brief, {
      sampleSize: 4,
      priceCents: { p25: 1000, p50: 2000, p75: 3000, min: 1000, max: 4000 },
      titleLength: { min: 5, max: 5, avg: 5 },
      titleSegmentsAvg: 0,
      descSentencesAvg: 0,
      ctaRatio: 0,
      bracketTagRatio: 0,
      imageCountAvg: 3,
      imageAspect: { square: 1, portrait: 1, landscape: 1, mixed: 0, unknown: 1 },
    })
    // 缺省 condition=like-new：建议价 = 中位价，区间 = p25..p75。
    assert.deepEqual(data.priceSuggestion, {
      lowCents: 1000,
      suggestedCents: 2000,
      highCents: 3000,
      basis: 'condition=like-new；anchor=p50 2000 分；factorBp=10000；low=p25 1000 分；high=p75 3000 分',
    })
  })

  it('关键词：3 条标题含共同词「键盘」→ keywords[0] = {word:键盘,count:3}', async (t) => {
    const repo = makeRepo()
    seed(repo)
    const harness = await createHarness(t, { sellerItems: repo })

    const { data } = await burst(harness, '{}')
    assert.deepEqual(data.keywords, [{ word: '键盘', count: 3 }])
  })

  it('空样本：200 + brief:null（不是错误，面板提示先采集）', async (t) => {
    const harness = await createHarness(t, { sellerItems: makeRepo() })
    const { status, data } = await burst(harness, '{}')
    assert.equal(status, 200)
    assert.deepEqual(data, { brief: null, priceSuggestion: null, sampleSize: 0, keywords: [] })
  })

  it('坏参数 → 400 VALIDATION（condition/limit/双口径/非数字 id）', async (t) => {
    const repo = makeRepo()
    seed(repo)
    const harness = await createHarness(t, { sellerItems: repo })
    const bodies = [
      '{"condition":"mint"}',
      '{"condition":5}',
      '{"limit":0}',
      '{"limit":501}',
      '{"limit":2.5}',
      '{"categoryId":"50023914","sellerId":"2200000000001"}',
      '{"sellerId":"abc"}',
      '{"categoryId":"50023914","limit":"10"}',
    ]
    for (const body of bodies) {
      const response = await harness.rawRequest({ method: 'POST', path: '/market/brief', body })
      assert.equal(response.status, 400, body)
      assert.equal(errorOf(response).code, 'VALIDATION', body)
    }
  })

  it('sellerId / categoryId 过滤各自生效，condition=new 按 1.2 倍给建议价', async (t) => {
    const repo = makeRepo()
    seed(repo)
    // 别的类目塞一件天价：按类目查时必须被排除。
    repo.saveItem(item({ itemId: 'other', categoryId: '999', priceCents: 99900, collectedAt: NOW + 4000 }))
    const harness = await createHarness(t, { sellerItems: repo })

    const bySeller = await burst(harness, '{"sellerId":"' + SELLER_B + '","condition":"new"}')
    assert.equal(bySeller.data.sampleSize, 2)
    const sellerBrief = asRecord(bySeller.data.brief)
    assert.deepEqual(sellerBrief.priceCents, { p25: 3000, p50: 3000, p75: 4000, min: 3000, max: 4000 })
    assert.deepEqual(bySeller.data.priceSuggestion, {
      lowCents: 3600,
      suggestedCents: 3600,
      highCents: 4800,
      basis: 'condition=new；anchor=p50 3000 分；factorBp=12000；low=p25 3000 分；high=p75 4000 分',
    })

    const byCategory = await burst(harness, '{"categoryId":"' + CATEGORY + '"}')
    assert.equal(byCategory.data.sampleSize, 4)
    assert.equal(asRecord(asRecord(byCategory.data.brief).priceCents).max, 4000)
  })

  it('未注入仓储 → 500 UNSUPPORTED（与其它路由一致）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'POST', path: '/market/brief', body: '{}' })
    assert.equal(response.status, 500)
    assert.match(errorOf(response).message, /未注入采集结果仓储/)
  })
})