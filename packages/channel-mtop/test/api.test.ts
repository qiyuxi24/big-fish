import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XianyuError } from '@bigfish/core'
import {
  MTOP_APIS,
  MTOP_API_VERSIONS,
  buildItemDetailData,
  buildPolishData,
  parseItemDetail,
} from '../src/index.ts'

/** 断言同步调用抛指定 code 的 XianyuError。 */
function expectSyncCode(code: string, fn: () => unknown): XianyuError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, code)
    return error
  }
  assert.fail('预期抛出 XianyuError')
}

const NOW = 1_700_000_000_000

test('MTOP_APIS：只读通道用到的 8 个接口名与抓包一致', () => {
  assert.deepEqual(MTOP_APIS, {
    search: 'mtop.taobao.idlemtopsearch.pc.search',
    detail: 'mtop.taobao.idle.pc.detail',
    polish: 'mtop.taobao.idle.item.polish',
    publish: 'mtop.idle.pc.idleitem.publish',
    backendPublish: 'mtop.idle.pc.backend.idleitem.publish',
    propertyRecommend: 'mtop.taobao.kgraph.property.recommend',
    poi: 'mtop.taobao.idle.local.poi.get',
    loginToken: 'mtop.taobao.idlemessage.pc.login.token',
  })
})

test('MTOP_API_VERSIONS：擦亮与属性预测是 2.0，其余接口不在此表', () => {
  assert.deepEqual(MTOP_API_VERSIONS, { polish: '2.0', propertyRecommend: '2.0' })
})

test('buildItemDetailData：只带 itemId，并去掉首尾空白', () => {
  assert.deepEqual(buildItemDetailData({ itemId: '  6677889900  ' }), { itemId: '6677889900' })
  assert.deepEqual(Object.keys(buildItemDetailData({ itemId: '1' })), ['itemId'])
})

test('buildItemDetailData：itemId 非字符串或空白时抛 VALIDATION', () => {
  assert.equal(expectSyncCode('VALIDATION', () => buildItemDetailData({ itemId: 123 } as unknown as { itemId: string })).code, 'VALIDATION')
  assert.equal(expectSyncCode('VALIDATION', () => buildItemDetailData({ itemId: '   ' })).code, 'VALIDATION')
  assert.equal(expectSyncCode('VALIDATION', () => buildItemDetailData({} as unknown as { itemId: string })).code, 'VALIDATION')
  assert.equal(expectSyncCode('VALIDATION', () => buildItemDetailData(null as unknown as { itemId: string })).code, 'VALIDATION')
})

test('buildPolishData：只带 itemId（版本由 MTOP_API_VERSIONS.polish 决定）', () => {
  assert.deepEqual(buildPolishData({ itemId: '42' }), { itemId: '42' })
  assert.equal(expectSyncCode('VALIDATION', () => buildPolishData({ itemId: '' })).code, 'VALIDATION')
  assert.equal(expectSyncCode('VALIDATION', () => buildPolishData({ itemId: 42 } as unknown as { itemId: string })).code, 'VALIDATION')
})

test('parseItemDetail：itemDO 形态，priceText 元文本转整数分', () => {
  const summary = parseItemDetail(
    {
      ret: ['SUCCESS::调用成功'],
      data: {
        itemDO: {
          itemId: '6677889900',
          title: '  九成新机械键盘  ',
          priceText: '¥1,299.00',
          itemStatus: '0',
          soldPrice: '1299',
        },
        sellerDO: { sellerId: 'seller-1', nick: '测试卖家' },
      },
    },
    'acc-1',
    NOW,
  )
  assert.deepEqual(summary, {
    itemId: '6677889900',
    accountId: 'acc-1',
    title: '九成新机械键盘',
    priceCents: 129_900,
    state: 'online',
    updatedAt: NOW,
  })
})

test('parseItemDetail：itemCardDO 形态 + priceInfo 元文本', () => {
  const summary = parseItemDetail(
    { data: { itemCardDO: { id: '1001', title: '测试卡', priceInfo: { price: '12.34', preText: '¥' }, itemStatus: 0 } } },
    'acc-1',
    NOW,
  )
  assert.equal(summary.itemId, '1001')
  assert.equal(summary.priceCents, 1234)
  assert.equal(summary.state, 'online')
})

test('parseItemDetail：data 扁平且已剥 ret 的响应也可解析', () => {
  const summary = parseItemDetail({ data: { itemId: '1002', title: '扁平商品', price: 1299, itemStatus: '在售' } }, 'acc-1', NOW)
  assert.equal(summary.itemId, '1002')
  assert.equal(summary.priceCents, 129_900)
  assert.equal(summary.state, 'online')
})

test('parseItemDetail：价格字段缺失时 priceCents=0', () => {
  const summary = parseItemDetail({ data: { itemId: '1003', title: '未标价商品' } }, 'acc-1', NOW)
  assert.equal(summary.priceCents, 0)
})

test('parseItemDetail：分字段 priceInCent 优先于元字段', () => {
  const candidate = { itemId: '1004', title: '分优先', price: '99.99', priceInCent: 1234 }
  assert.equal(parseItemDetail({ data: candidate }, 'acc-1', NOW).priceCents, 1234)
})

test('parseItemDetail：itemPriceDTO.priceInCent 同样优先于 price', () => {
  const candidate = { itemId: '1005', title: 'DTO 分', price: '99.99', itemPriceDTO: { priceInCent: 500 } }
  assert.equal(parseItemDetail({ data: candidate }, 'acc-1', NOW).priceCents, 500)
})

test('parseItemDetail：没有分字段时回退 soldPrice（元）', () => {
  const summary = parseItemDetail({ data: { itemId: '1006', title: '只给 soldPrice', soldPrice: '88' } }, 'acc-1', NOW)
  assert.equal(summary.priceCents, 8800)
})

test('parseItemDetail：搜索卡 price 是 [{text}] 数组时拼接后解析', () => {
  const candidate = { itemId: '1007', title: '搜索卡', price: [{ text: '当前价' }, { text: '¥' }, { text: '1,299' }] }
  assert.equal(parseItemDetail({ data: candidate }, 'acc-1', NOW).priceCents, 129_900)
})

test('parseItemDetail：带「万」的价格文本按十倍放大', () => {
  assert.equal(parseItemDetail({ data: { itemId: '1008', title: '万元商品', priceText: '1.2万' } }, 'acc-1', NOW).priceCents, 1_200_000)
})

test('parseItemDetail：itemStatus 数字 0 在售、1 下架；文本 已售出 下架', () => {
  assert.equal(parseItemDetail({ data: { itemId: '1009', title: 't', itemStatus: 0 } }, 'acc-1', NOW).state, 'online')
  assert.equal(parseItemDetail({ data: { itemId: '1010', title: 't', itemStatus: 1 } }, 'acc-1', NOW).state, 'offline')
  assert.equal(parseItemDetail({ data: { itemId: '1011', title: 't', itemStatus: '已售出' } }, 'acc-1', NOW).state, 'offline')
})

test('parseItemDetail：soldOut/offShelf 布尔标记与在线文本', () => {
  assert.equal(parseItemDetail({ data: { itemId: '1012', title: 't', soldOut: true } }, 'acc-1', NOW).state, 'offline')
  assert.equal(parseItemDetail({ data: { itemId: '1013', title: 't', offShelf: '1' } }, 'acc-1', NOW).state, 'offline')
  assert.equal(parseItemDetail({ data: { itemId: '1014', title: 't', itemStatus: '在售' } }, 'acc-1', NOW).state, 'online')
})

test('parseItemDetail：itemId 优先取 itemDO，缺失时回退 data 层', () => {
  const summary = parseItemDetail({ data: { itemDO: { title: '无 id 的 itemDO' }, itemId: '2001' } }, 'acc-1', NOW)
  assert.equal(summary.itemId, '2001')
  assert.equal(summary.title, '无 id 的 itemDO')
})

test('parseItemDetail：数字 itemId 转字符串（避免大数精度问题）', () => {
  assert.equal(parseItemDetail({ data: { itemId: 6677889900, title: 't' } }, 'acc-1', NOW).itemId, '6677889900')
})

test('parseItemDetail：itemId/title 全缺时抛 VALIDATION', () => {
  assert.equal(expectSyncCode('VALIDATION', () => parseItemDetail({ data: { title: 't' } }, 'acc-1', NOW)).code, 'VALIDATION')
  assert.equal(expectSyncCode('VALIDATION', () => parseItemDetail({ data: { itemId: '1' } }, 'acc-1', NOW)).code, 'VALIDATION')
})

test('parseItemDetail：title 取 itemTitle / itemTextDTO.title 回退', () => {
  assert.equal(parseItemDetail({ data: { itemId: '1', itemTitle: '旧字段标题' } }, 'acc-1', NOW).title, '旧字段标题')
  assert.equal(parseItemDetail({ data: { itemId: '1', itemTextDTO: { title: '文本结构标题' } } }, 'acc-1', NOW).title, '文本结构标题')
})

test('parseItemDetail：价格存在但无法解析时抛 VALIDATION（不静默写 0）', () => {
  assert.equal(expectSyncCode('VALIDATION', () => parseItemDetail({ data: { itemId: '1', title: 't', priceText: '面议' } }, 'acc-1', NOW)).code, 'VALIDATION')
  assert.equal(expectSyncCode('VALIDATION', () => parseItemDetail({ data: { itemId: '1', title: 't', priceInCent: 1.5 } }, 'acc-1', NOW)).code, 'VALIDATION')
})

test('parseItemDetail：accountId 为空、now 非法、raw 非对象都抛 VALIDATION', () => {
  assert.equal(expectSyncCode('VALIDATION', () => parseItemDetail({ data: { itemId: '1', title: 't' } }, '  ', NOW)).code, 'VALIDATION')
  assert.equal(expectSyncCode('VALIDATION', () => parseItemDetail({ data: { itemId: '1', title: 't' } }, 'acc-1', 1.5)).code, 'VALIDATION')
  assert.equal(expectSyncCode('VALIDATION', () => parseItemDetail('{}' as unknown, 'acc-1', NOW)).code, 'VALIDATION')
  assert.equal(expectSyncCode('VALIDATION', () => parseItemDetail({ data: 'null' }, 'acc-1', NOW)).code, 'VALIDATION')
})

test('parseItemDetail：now 缺省时 updatedAt 用当前毫秒', () => {
  const before = Date.now()
  const summary = parseItemDetail({ data: { itemId: '1', title: 't' } }, 'acc-1')
  assert.ok(summary.updatedAt >= before && summary.updatedAt <= Date.now())
})

test('parseItemDetail：响应缺 data 但带 ret 时错误信息包含 ret', () => {
  const error = expectSyncCode('VALIDATION', () => parseItemDetail({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] }, 'acc-1', NOW))
  assert.match(error.message, /FAIL_SYS_TOKEN_EXOIRED/)
})
