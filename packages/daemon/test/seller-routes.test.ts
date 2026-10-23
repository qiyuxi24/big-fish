/**
 * 采集模块路由：POST /resolve、POST /sellers/collect、GET /sellers、GET /sellers/:id/items。
 * 不触网：采集能力假实现，仓储用 ':memory:' 真库。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError, createSellerRepository, openStore } from '@bigfish/core'
import type { SellerRepository } from '@bigfish/core'

import type { SellerCollectReport } from '../src/seller-collect.ts'
import type { SellerCollectHandler } from '../src/seller-routes.ts'
import { createHarness, dataOf, errorOf } from './harness.ts'

const SELLER_ID = '2200000000001'
const NOW = 1_700_000_000_000

function emptyReport(): SellerCollectReport {
  return {
    accountId: 'acc1',
    sellerId: SELLER_ID,
    seller: { userId: SELLER_ID, displayName: '某商家' },
    items: 0,
    summary: {
      count: 0,
      priceCents: { min: 0, median: 0, max: 0, avg: 0 },
      titleLength: { min: 0, max: 0, avg: 0 },
      imageCountAvg: 0,
      descRatio: 0,
      categories: [],
      keywords: [],
    },
    skipped: [],
    stored: 0,
    truncated: false,
    self: true,
  }
}

interface Call {
  accountId: string
  sellerId: string
  maxItems?: number
  acknowledgeOther?: boolean
  hasSignal: boolean
}

function stubCollector(calls: Call[]): SellerCollectHandler {
  return async (input): Promise<SellerCollectReport> => {
    calls.push({
      accountId: input.accountId,
      sellerId: input.sellerId,
      ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
      ...(input.acknowledgeOther === undefined ? {} : { acknowledgeOther: input.acknowledgeOther }),
      hasSignal: input.signal instanceof AbortSignal,
    })
    return emptyReport()
  }
}

function makeRepo(): SellerRepository {
  const store = openStore({ path: ':memory:', now: () => NOW })
  return createSellerRepository({ store, now: () => NOW })
}

describe('POST /resolve', () => {
  it('商家链接 → { kind:seller, sellerId }；不注入能力也能用（纯解析）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/resolve',
      body: JSON.stringify({ link: 'https://www.goofish.com/personal?userId=' + SELLER_ID }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { kind: 'seller', sellerId: SELLER_ID })
  })

  it('商品链接带 categoryId；非法链接 → 400，缺字段 → 400', async (t) => {
    const harness = await createHarness(t)
    const ok = await harness.rawRequest({
      method: 'POST',
      path: '/resolve',
      body: JSON.stringify({ link: 'https://www.goofish.com/item?id=42&categoryId=50023914' }),
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(dataOf(ok), { kind: 'item', itemId: '42', categoryId: '50023914' })

    const bad = await harness.rawRequest({ method: 'POST', path: '/resolve', body: '{"link":"123456"}' })
    assert.equal(bad.status, 400)
    assert.equal(errorOf(bad).code, 'VALIDATION')

    const missing = await harness.rawRequest({ method: 'POST', path: '/resolve', body: '{}' })
    assert.equal(missing.status, 400)
  })
})

describe('POST /sellers/collect', () => {
  it('未注入能力 → 500 UNSUPPORTED', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/sellers/collect',
      body: JSON.stringify({ accountId: 'acc1', sellerId: SELLER_ID }),
    })
    assert.equal(response.status, 500)
    assert.match(errorOf(response).message, /未注入商家商品采集能力/)
  })

  it('入参非法 → 400 且不调用采集器', async (t) => {
    const calls: Call[] = []
    const harness = await createHarness(t, { sellerCollect: stubCollector(calls) })
    for (const body of ['{}', '{"accountId":"acc1"}', '{"accountId":"acc1","sellerId":"abc"}', '{"accountId":"..","sellerId":"1"}', '{"accountId":"acc1","sellerId":"1","maxItems":61}']) {
      const response = await harness.rawRequest({ method: 'POST', path: '/sellers/collect', body })
      assert.equal(response.status, 400, body)
      assert.equal(errorOf(response).code, 'VALIDATION', body)
    }
    assert.deepEqual(calls, [])
  })

  it('合法请求透传 sellerId / maxItems / acknowledgeOther 与 signal', async (t) => {
    const calls: Call[] = []
    const harness = await createHarness(t, { sellerCollect: stubCollector(calls) })
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/sellers/collect',
      body: JSON.stringify({ accountId: 'acc1', sellerId: SELLER_ID, maxItems: 5, acknowledgeOther: true }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), emptyReport())
    assert.deepEqual(calls, [{ accountId: 'acc1', sellerId: SELLER_ID, maxItems: 5, acknowledgeOther: true, hasSignal: true }])
  })

  it('他人店铺未确认 → UNAUTHORIZED（不被压成 400）', async (t) => {
    const harness = await createHarness(t, {
      sellerCollect: async (): Promise<SellerCollectReport> => {
        throw new XianyuError({ code: 'UNAUTHORIZED', message: '不是当前账号的店铺' })
      },
    })
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/sellers/collect',
      body: JSON.stringify({ accountId: 'acc1', sellerId: SELLER_ID }),
    })
    // daemon 的非 VALIDATION 错误统一 500（与 STORAGE/NETWORK 一致），语义靠稳定 code 表达。
    assert.equal(response.status, 500)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })
})

describe('GET /sellers 与 /sellers/:id/items', () => {
  it('未注入仓储：都返回空，不报错', async (t) => {
    const harness = await createHarness(t)
    const list = await harness.rawRequest({ method: 'GET', path: '/sellers' })
    assert.equal(list.status, 200)
    assert.deepEqual(dataOf(list), [])

    const items = await harness.rawRequest({ method: 'GET', path: '/sellers/' + SELLER_ID + '/items' })
    assert.equal(items.status, 200)
    assert.deepEqual(dataOf(items), { sellerId: SELLER_ID, total: 0, items: [] })
  })

  it('注入仓储：商家列表带 storedCount，商品列表按商家隔离', async (t) => {
    const repo = makeRepo()
    repo.saveProfile({ sellerId: SELLER_ID, nick: '某商家', isSelf: true, collectedAt: NOW })
    repo.saveItem({ itemId: '1', sellerId: SELLER_ID, accountId: SELLER_ID, title: '键盘', priceCents: 9900, imageCount: 2, collectedAt: NOW })
    repo.saveItem({ itemId: '2', sellerId: '999', accountId: SELLER_ID, title: '别家的', priceCents: 100, imageCount: 1, collectedAt: NOW })
    const harness = await createHarness(t, { sellerItems: repo })

    const list = await harness.rawRequest({ method: 'GET', path: '/sellers' })
    assert.equal(list.status, 200)
    const profiles = dataOf(list) as Array<Record<string, unknown>>
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0]?.sellerId, SELLER_ID)
    assert.equal(profiles[0]?.storedCount, 1)
    assert.equal(profiles[0]?.isSelf, true)

    const items = await harness.rawRequest({ method: 'GET', path: '/sellers/' + SELLER_ID + '/items' })
    const payload = dataOf(items) as { total: number; items: Array<Record<string, unknown>> }
    assert.equal(payload.total, 1)
    assert.equal(payload.items.length, 1)
    assert.equal(payload.items[0]?.itemId, '1')
    // 红线：接口也不返回描述与图片地址（表里根本没有这两列）。
    assert.equal(JSON.stringify(payload).includes('desc'), false)
  })

  it('非法商家 id / 越界 limit → 400', async (t) => {
    const harness = await createHarness(t, { sellerItems: makeRepo() })
    const badId = await harness.rawRequest({ method: 'GET', path: '/sellers/abc/items' })
    assert.equal(badId.status, 400)
    assert.equal(errorOf(badId).code, 'VALIDATION')

    const badLimit = await harness.rawRequest({ method: 'GET', path: '/sellers/' + SELLER_ID + '/items?limit=501' })
    assert.equal(badLimit.status, 400)
  })
})
