/**
 * 商家商品采集器（daemon 侧）：串行取数 + 落库 + 他人店铺需确认 + 失败隔离。
 * 全部 fake transport；只用 ':memory:' 库，断言「发了几次请求、存了几行」。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { XianyuError, createSellerRepository, openStore } from '@bigfish/core'
import type { SellerRepository } from '@bigfish/core'
import type { MtopHttpRequest, MtopHttpResponse, MtopTransport } from '@bigfish/channel-mtop'
import { MAX_SELLER_ITEMS, createSellerCollector, parseSellerCollectRequest } from '../src/seller-collect.ts'

const SELLER_ID = '2200000000001'
const OTHER_SELLER_ID = '3300000000002'
const NOW = 1_700_000_000_000

function success(data: unknown): MtopHttpResponse {
  return { status: 200, headers: {}, text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data }) }
}

function headRaw(sellerId = SELLER_ID, itemCount?: number): MtopHttpResponse {
  return success({
    baseInfo: { kcUserId: sellerId, encryptedUserId: 'QWma6tgLyd31UYx/44RiHg==' },
    module: { base: { displayName: '某商家', ipLocation: '西安' }, tabs: itemCount === undefined ? {} : { item: { number: itemCount } } },
  })
}

function listRaw(itemIds: ReadonlyArray<string>, hasMore = false, pageNumber = 1): MtopHttpResponse {
  return success({
    cardList: itemIds.map((itemId) => ({ cardData: { detailParams: { itemId, title: '商品', soldPrice: '129' } } })),
    hasMore,
    pageNumber,
  })
}

function detailRaw(itemId: string, extra: Record<string, unknown> = {}): MtopHttpResponse {
  return success({
    itemDO: {
      itemId,
      title: '机械键盘 有线 背光',
      desc: '这段描述绝不能被落库',
      soldPrice: '129',
      categoryId: 50023914,
      imageInfos: [{ url: 'https://img.example/a.jpg' }, { url: 'https://img.example/b.jpg' }],
      browseCnt: 12,
      wantCnt: 3,
      collectCnt: 1,
      soldCnt: 0,
      gmtCreate: 1792591919000,
      ...extra,
    },
    sellerDO: { sellerId: SELLER_ID, nick: '某商家', city: '西安', itemCount: 7 },
  })
}

interface Fake {
  transport: MtopTransport
  calls: MtopHttpRequest[]
}

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

function apiOf(request: MtopHttpRequest): string {
  return new URL(request.url).searchParams.get('api') ?? ''
}

function dataOf(request: MtopHttpRequest | undefined): Record<string, unknown> {
  if (request === undefined) return {}
  const raw = new URLSearchParams(request.body).get('data')
  if (raw === null) return {}
  const parsed: unknown = JSON.parse(raw)
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}

function ensureCode(code: string, body: () => unknown): void {
  try {
    body()
  } catch (error) {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, code)
    return
  }
  assert.fail('预期抛出 ' + code)
}

function makeRepo(): SellerRepository {
  const store = openStore({ path: ':memory:', now: () => NOW })
  return createSellerRepository({ store, now: () => NOW })
}

function makeSubject(responses: ReadonlyArray<MtopHttpResponse | Error>) {
  const fake = sequenceTransport(responses)
  const sellers = makeRepo()
  const subject = createSellerCollector({ transport: fake.transport, sellers, now: () => NOW })
  return { fake, sellers, subject }
}

const OWN_COOKIES = { unb: SELLER_ID, _m_h5_tk: 'tok' }

describe('parseSellerCollectRequest', () => {
  it('接受 accountId + sellerId，maxItems 有上限', () => {
    const ok = parseSellerCollectRequest({ accountId: 'acc_1', sellerId: SELLER_ID })
    assert.equal(ok.sellerId, SELLER_ID)
    assert.equal(ok.maxItems, undefined)
    assert.equal(parseSellerCollectRequest({ accountId: 'acc_1', sellerId: '7', maxItems: MAX_SELLER_ITEMS }).maxItems, MAX_SELLER_ITEMS)
  })

  it('非法字段一律 VALIDATION', () => {
    ensureCode('VALIDATION', () => parseSellerCollectRequest(null))
    ensureCode('VALIDATION', () => parseSellerCollectRequest({ sellerId: SELLER_ID }))
    ensureCode('VALIDATION', () => parseSellerCollectRequest({ accountId: '../x', sellerId: SELLER_ID }))
    ensureCode('VALIDATION', () => parseSellerCollectRequest({ accountId: 'acc', sellerId: 'abc' }))
    ensureCode('VALIDATION', () => parseSellerCollectRequest({ accountId: 'acc', sellerId: '7', maxItems: MAX_SELLER_ITEMS + 1 }))
    ensureCode('VALIDATION', () => parseSellerCollectRequest({ accountId: 'acc', sellerId: '7', acknowledgeOther: 'yes' }))
  })
})

describe('createSellerCollector', () => {
  it('自己的店：主页 → 列表 → 逐件详情，落库字段只含元数据', async () => {
    const { fake, sellers, subject } = makeSubject([
      headRaw(SELLER_ID, 2),
      listRaw(['1091933071728', '1091933071729']),
      detailRaw('1091933071728'),
      detailRaw('1091933071729', { soldPrice: '88' }),
    ])
    const report = await subject.collect({ accountId: SELLER_ID, cookies: OWN_COOKIES, sellerId: SELLER_ID })

    assert.equal(report.self, true)
    assert.equal(report.items, 2)
    assert.equal(report.stored, 2)
    assert.deepEqual(report.skipped, [])
    assert.equal(report.truncated, false)
    assert.equal(report.summary.count, 2)
    assert.equal(report.seller.displayName, '某商家')

    // 请求形状：head → x2 列表？只有一页；详情各一次。
    assert.deepEqual(fake.calls.map(apiOf), [
      'mtop.idle.web.user.page.head',
      'mtop.idle.web.xyh.item.list',
      'mtop.taobao.idle.pc.detail',
      'mtop.taobao.idle.pc.detail',
    ])
    assert.equal(dataOf(fake.calls[1]).userId, SELLER_ID)
    assert.equal(dataOf(fake.calls[2]).itemId, '1091933071728')

    const rows = sellers.listItems(SELLER_ID)
    assert.equal(rows.length, 2)
    const first = rows.find((row) => row.itemId === '1091933071728')
    assert.ok(first !== undefined)
    assert.equal(first.priceCents, 12900)
    assert.equal(first.imageCount, 2)
    assert.equal(first.categoryId, '50023914')
    assert.equal(first.browseCount, 12)
    // 结构特征：fixture 的图只有 url（没宽高）→ 比例 unknown；标题 3 段、描述 1 句。
    assert.equal(first.imageFeatures?.count, 2)
    assert.equal(first.imageFeatures?.aspect, 'unknown')
    assert.equal(first.imageFeatures?.measured, 0)
    assert.equal(first.copyFeatures?.titleSegments, 3)
    assert.equal(first.copyFeatures?.descSentences, 1)
    // 红线：描述与图片地址都不落库。
    assert.equal('desc' in first, false)
    assert.equal(JSON.stringify(first).includes('img.example'), false)
    assert.equal(JSON.stringify(first).includes('这段描述'), false)

    const profile = sellers.listProfiles()[0]
    assert.ok(profile !== undefined)
    assert.equal(profile.sellerId, SELLER_ID)
    assert.equal(profile.isSelf, true)
    assert.equal(profile.itemCount, 2)
  })

  it('他人店铺未确认：UNAUTHORIZED，且一次 mtop 请求都不发', async () => {
    const { fake, sellers, subject } = makeSubject([])
    await assert.rejects(
      subject.collect({ accountId: SELLER_ID, cookies: OWN_COOKIES, sellerId: OTHER_SELLER_ID }),
      (error: unknown) => {
        assert.ok(error instanceof XianyuError)
        assert.equal(error.code, 'UNAUTHORIZED')
        assert.match(error.message, /看行情/)
        return true
      },
    )
    assert.equal(fake.calls.length, 0)
    assert.equal(sellers.listProfiles().length, 0)
  })

  it('他人店铺明确确认后放行，isSelf 落 false', async () => {
    const { sellers, subject } = makeSubject([
      headRaw(OTHER_SELLER_ID, 1),
      listRaw(['5']),
      detailRaw('5'),
    ])
    const report = await subject.collect({
      accountId: SELLER_ID, cookies: OWN_COOKIES, sellerId: OTHER_SELLER_ID, acknowledgeOther: true,
    })
    assert.equal(report.self, false)
    assert.equal(report.stored, 1)
    assert.equal(sellers.listProfiles()[0]?.isSelf, false)
  })

  it('单件详情失败进 skipped，其余照常落库', async () => {
    const { sellers, subject } = makeSubject([
      headRaw(SELLER_ID, 3),
      listRaw(['1', '2', '3']),
      detailRaw('1'),
      success({ itemDO: { title: '缺 itemId' }, sellerDO: { sellerId: SELLER_ID } }),
      detailRaw('3'),
    ])
    const report = await subject.collect({ accountId: SELLER_ID, cookies: OWN_COOKIES, sellerId: SELLER_ID })
    assert.deepEqual(report.skipped, ['2'])
    assert.equal(report.items, 2)
    assert.equal(report.stored, 2)
    assert.deepEqual(sellers.listItems(SELLER_ID).map((row) => row.itemId).sort(), ['1', '3'])
  })

  it('AUTH_EXPIRED 中止整批（不做「部分成功」），已采到的仍已落库', async () => {
    const authError = new XianyuError({ code: 'AUTH_EXPIRED', message: '令牌过期' })
    const { sellers, subject } = makeSubject([
      headRaw(SELLER_ID, 2),
      listRaw(['1', '2']),
      detailRaw('1'),
      authError,
    ])
    await assert.rejects(
      subject.collect({ accountId: SELLER_ID, cookies: OWN_COOKIES, sellerId: SELLER_ID }),
      (error: unknown) => error instanceof XianyuError && error.code === 'AUTH_EXPIRED',
    )
    assert.deepEqual(sellers.listItems(SELLER_ID).map((row) => row.itemId), ['1'])
  })

  it('分页：hasMore=true 翻第二页；maxItems 到顶时标记 truncated', async () => {
    const { fake, subject } = makeSubject([
      headRaw(SELLER_ID, 4),
      listRaw(['1', '2'], true, 1),
      detailRaw('1'),
      detailRaw('2'),
    ])
    const report = await subject.collect({ accountId: SELLER_ID, cookies: OWN_COOKIES, sellerId: SELLER_ID, maxItems: 2 })
    assert.equal(report.items, 2)
    assert.equal(report.truncated, true)
    // 只发了 head + 第一页 list + 两件详情（没有为了「确认截断」多打一页）。
    assert.equal(fake.calls.length, 4)
    assert.equal(dataOf(fake.calls[1]).pageNumber, 1)
  })

  it('平台说还有更多但页数到顶：truncated=true，不无限翻页', async () => {
    const responses: Array<MtopHttpResponse> = [headRaw(SELLER_ID, 100)]
    const listedIds: string[] = []
    // collectIds 先翻完页再逐件取详情，回放顺序必须是「head → 三页列表 → 六件详情」。
    for (let page = 1; page <= 3; page += 1) {
      const ids = [String(page * 10 + 1), String(page * 10 + 2)]
      listedIds.push(...ids)
      responses.push(listRaw(ids, true, page))
    }
    for (const itemId of listedIds) responses.push(detailRaw(itemId))
    const { fake, subject } = makeSubject(responses)
    const report = await subject.collect({ accountId: SELLER_ID, cookies: OWN_COOKIES, sellerId: SELLER_ID, maxItems: MAX_SELLER_ITEMS })
    assert.equal(report.items, 6)
    assert.equal(report.truncated, true)
    // head + 3 页列表 + 6 件详情，一页都没多翻。
    assert.equal(fake.calls.length, 10)
  })
})
