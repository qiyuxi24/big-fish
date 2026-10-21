/**
 * 参考采集器（daemon 侧）测试：只读、串行、失败隔离。
 * 全部 fake transport，不触网；断言「发了几次请求、发给谁」而不只看结果。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'
import type { MtopHttpRequest, MtopHttpResponse, MtopTransport } from '@bigfish/channel-mtop'

import { MAX_REFERENCE_ITEMS, createReferenceCollector, parseReferenceRequest } from '../src/reference.ts'

const SELLER_ID = '2200000000001'
const NOW = 1_700_000_000_000

function ok(text: string): MtopHttpResponse {
  return { status: 200, headers: {}, text }
}

function success(data: unknown): MtopHttpResponse {
  return ok(JSON.stringify({ ret: ['SUCCESS::调用成功'], data }))
}

/** 详情响应：结构与真机抓包一致（itemDO + sellerDO）。 */
function detailRaw(itemId: string, extra: Record<string, unknown> = {}): MtopHttpResponse {
  return success({
    itemDO: {
      itemId,
      title: '机械键盘 有线 背光 全新未拆',
      desc: '自用键盘，功能正常',
      soldPrice: '129',
      originalPrice: '299',
      categoryId: 50023914,
      imageInfos: [{ url: 'https://img.example/a.jpg' }],
      cpvLabels: [{ propertyName: '成色', valueName: '几乎全新' }],
      browseCnt: 12,
      wantCnt: 3,
      collectCnt: 1,
      soldCnt: 0,
      gmtCreate: 1792591919000,
      ...extra,
    },
    sellerDO: { sellerId: SELLER_ID, nick: '某商家', city: '西安', itemCount: 7, userRegDay: 2012, soldCount: 2 },
  })
}

function listRaw(itemIds: ReadonlyArray<string>): MtopHttpResponse {
  return success({
    cardList: itemIds.map((itemId) => ({ cardData: { detailParams: { itemId, title: '商品', soldPrice: '129' } } })),
    hasMore: false,
    pageNumber: 1,
  })
}

function headRaw(): MtopHttpResponse {
  return success({
    baseInfo: { kcUserId: SELLER_ID, encryptedUserId: 'QWma6tgLyd31UYx/44RiHg==' },
    module: { base: { displayName: '某商家', ipLocation: '西安' } },
  })
}

interface Fake {
  transport: MtopTransport
  calls: MtopHttpRequest[]
}

/** 按调用顺序回放；用尽即抛错，防止「多发请求」被漏掉。 */
function sequenceTransport(responses: ReadonlyArray<MtopHttpResponse | Error>): Fake {
  const calls: MtopHttpRequest[] = []
  const transport: MtopTransport = {
    request: async (request) => {
      calls.push(request)
      const next = responses[calls.length - 1]
      if (next === undefined) throw new Error('fake transport 响应已用尽：调用方多发了请求')
      if (next instanceof Error) throw next
      return next
    },
  }
  return { transport, calls }
}

/** 接口名在 URL 查询串里（body 只有 data=…），别从 body 取。 */
function apiOf(request: MtopHttpRequest): string {
  return new URL(request.url).searchParams.get('api') ?? ''
}

function firstCall(fake: Fake): MtopHttpRequest {
  const first = fake.calls[0]
  if (first === undefined) throw new Error('期望至少发过一次请求')
  return first
}

function dataOf(request: MtopHttpRequest): Record<string, unknown> {
  const raw = new URLSearchParams(request.body).get('data')
  if (raw === null) return {}
  const parsed: unknown = JSON.parse(raw)
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}

function collector(responses: ReadonlyArray<MtopHttpResponse | Error>): { fake: Fake; subject: ReturnType<typeof createReferenceCollector> } {
  const fake = sequenceTransport(responses)
  return { fake, subject: createReferenceCollector({ transport: fake.transport, now: () => NOW }) }
}

const COOKIES = { unb: '2200000000001', _m_h5_tk: 'tok' }

describe('parseReferenceRequest', () => {
  it('接受 itemIds 与 sellerId 两种入口，并对 itemIds 去重', () => {
    const byItems = parseReferenceRequest({ accountId: 'acc1', itemIds: ['1', '2', '1'] })
    assert.deepEqual(byItems.itemIds, ['1', '2'])
    const bySeller = parseReferenceRequest({ accountId: 'acc1', sellerId: SELLER_ID })
    assert.equal(bySeller.sellerId, SELLER_ID)
  })

  it('两个入口都不给、账 号非法、itemId 非数字、超过上限都拒绝', () => {
    assert.throws(() => parseReferenceRequest(null), /VALIDATION|必须是对象/)
    assert.throws(() => parseReferenceRequest({ accountId: '..', itemIds: ['1'] }), /accountId 非法/)
    assert.throws(() => parseReferenceRequest({ accountId: 'acc1' }), /至少一个/)
    assert.throws(() => parseReferenceRequest({ accountId: 'acc1', itemIds: [] }), /不能是空数组/)
    assert.throws(() => parseReferenceRequest({ accountId: 'acc1', itemIds: ['abc'] }), /纯数字串/)
    assert.throws(() => parseReferenceRequest({ accountId: 'acc1', sellerId: 'x1' }), /sellerId 必须是纯数字串/)
    const tooMany = Array.from({ length: MAX_REFERENCE_ITEMS + 1 }, (_, i) => String(i + 1))
    assert.throws(() => parseReferenceRequest({ accountId: 'acc1', itemIds: tooMany }), /最多 20 条/)
  })
})

describe('createReferenceCollector', () => {
  it('只给 itemIds：逐件取详情，汇总价格/类目/关键词，不带商家主页', async () => {
    const { fake, subject } = collector([
      detailRaw('812345678901'),
      detailRaw('812345678902', { title: '机械键盘 背光 九成新', soldPrice: '200', categoryId: 50023915 }),
    ])
    const report = await subject.collect({ accountId: 'acc1', cookies: COOKIES, itemIds: ['812345678901', '812345678902'] })
    assert.equal(report.items.length, 2)
    assert.equal(report.summary.count, 2)
    assert.equal(report.summary.priceCents.min, 12900)
    assert.equal(report.summary.priceCents.max, 20000)
    assert.equal(report.summary.categories.length, 2)
    assert.equal(report.seller, undefined)
    assert.deepEqual(report.sellers.map((s) => s.sellerId), [SELLER_ID])
    assert.deepEqual(report.skipped, [])
    assert.deepEqual(fake.calls.map(apiOf), ['mtop.taobao.idle.pc.detail', 'mtop.taobao.idle.pc.detail'])
    assert.equal(dataOf(firstCall(fake)).itemId, '812345678901')
    // 只读铁律：报告里不得出现图片直链。
    assert.equal(JSON.stringify(report).includes('img.example'), false)
  })

  it('只给 sellerId：先取商家主页，再取列表，再逐件取详情', async () => {
    const { fake, subject } = collector([headRaw(), listRaw(['812345678901']), detailRaw('812345678901')])
    const report = await subject.collect({ accountId: 'acc1', cookies: COOKIES, sellerId: SELLER_ID })
    assert.equal(report.seller?.userId, SELLER_ID)
    assert.equal(report.items.length, 1)
    assert.deepEqual(fake.calls.map(apiOf), [
      'mtop.idle.web.user.page.head',
      'mtop.idle.web.xyh.item.list',
      'mtop.taobao.idle.pc.detail',
    ])
    assert.equal(dataOf(fake.calls[1] as MtopHttpRequest).userId, SELLER_ID)
  })

  it('单件详情失败只记进 skipped，不拖垮整批', async () => {
    const bad = new XianyuError({ code: 'VALIDATION', message: '详情响应缺少 sellerDO，无法确定商家 ID' })
    const { subject } = collector([bad, detailRaw('812345678902')])
    const report = await subject.collect({ accountId: 'acc1', cookies: COOKIES, itemIds: ['812345678901', '812345678902'] })
    assert.deepEqual(report.skipped, ['812345678901'])
    assert.equal(report.items.length, 1)
  })

  it('登录态失效中止整批（不能继续拿别人商品试探）', async () => {
    const expired = new XianyuError({ code: 'AUTH_EXPIRED', message: '令牌过期' })
    const { fake, subject } = collector([expired, detailRaw('812345678902')])
    await assert.rejects(
      () => subject.collect({ accountId: 'acc1', cookies: COOKIES, itemIds: ['812345678901', '812345678902'] }),
      (error: unknown) => error instanceof XianyuError && error.code === 'AUTH_EXPIRED',
    )
    assert.equal(fake.calls.length, 1)
  })

  it('请求非法时不发任何请求', async () => {
    const { fake, subject } = collector([])
    await assert.rejects(() => subject.collect({ accountId: 'acc1', cookies: COOKIES }), /至少一个/)
    assert.equal(fake.calls.length, 0)
  })
})
