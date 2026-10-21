import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XianyuError } from '@bigfish/core'
import {
  USER_MTOP_APIS,
  buildItemListData,
  buildUserHeadData,
  extractSellerIdFromDetail,
  parseItemList,
  parseUserHead,
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

const USER_ID = '2206569289277'
const NOW = 1_700_000_000_000

/** 脱敏 fixture：结构照 2026-10-21 真机抓包，昵称/加密 id/头像已替换。 */
const BASE_INFO = {
  encryptedUserId: 'enc-aa11bb22',
  kcUserId: 'kc-cc33dd44',
  self: false,
  tags: { real_name_certification_77: '1' },
}
const MODULE_BLOCK = {
  tabs: { item: { number: 2, name: '宝贝' }, rate: { number: 5, name: '评价' } },
  social: { followStatus: false, followers: 128, following: 7 },
  base: {
    displayName: '闲鱼小铺（脱敏）',
    avatar: 'https://img.example.com/avatar.jpg',
    ipLocation: '浙江 杭州',
  },
}
const HEAD_DATA = { baseInfo: BASE_INFO, module: MODULE_BLOCK }

/** 脱敏商品列表响应；detailParams 的字段集合与抓包一致（只留本模块用到的）。 */
const LIST_RESPONSE = {
  ret: ['SUCCESS::调用成功'],
  data: {
    cardList: [
      {
        cardData: {
          detailParams: {
            itemId: '812345678901',
            title: '九成新机械键盘',
            picUrl: 'https://img.example.com/kb.jpg',
            soldPrice: '129',
            categoryId: '50023914',
            auctionType: '0',
          },
        },
      },
      {
        cardData: {
          detailParams: { itemId: '812345678902', title: '键盘键帽一套', soldPrice: 30.5 },
        },
      },
    ],
    hasMore: true,
    pageNumber: 1,
  },
}

test('USER_MTOP_APIS：主页与商品列表接口名与抓包一致', () => {
  assert.deepEqual(USER_MTOP_APIS, {
    head: 'mtop.idle.web.user.page.head',
    itemList: 'mtop.idle.web.xyh.item.list',
  })
})

test('buildUserHeadData：固定 self=false，userId 去空白', () => {
  assert.deepEqual(buildUserHeadData({ userId: ' ' + USER_ID + ' ' }), { self: false, userId: USER_ID })
})

test('buildUserHeadData：userId 非字符串或空串抛 VALIDATION', () => {
  expectSyncCode('VALIDATION', () => buildUserHeadData({ userId: '' }))
  expectSyncCode('VALIDATION', () => buildUserHeadData({ userId: '   ' }))
  expectSyncCode('VALIDATION', () => buildUserHeadData({ userId: 2206569289277 as unknown as string }))
  expectSyncCode('VALIDATION', () => buildUserHeadData(null as unknown as { userId: string }))
})

test('buildItemListData：缺省 pageNumber=1、pageSize=20、needGroupInfo=true', () => {
  assert.deepEqual(buildItemListData({ userId: USER_ID }), {
    needGroupInfo: true,
    pageNumber: 1,
    userId: USER_ID,
    pageSize: 20,
  })
})

test('buildItemListData：pageNumber/pageSize 边界与非法值', () => {
  assert.deepEqual(buildItemListData({ userId: USER_ID, pageNumber: 3, pageSize: 1 }), {
    needGroupInfo: true,
    pageNumber: 3,
    userId: USER_ID,
    pageSize: 1,
  })
  expectSyncCode('VALIDATION', () => buildItemListData({ userId: USER_ID, pageSize: 21 }))
  expectSyncCode('VALIDATION', () => buildItemListData({ userId: USER_ID, pageSize: 0 }))
  expectSyncCode('VALIDATION', () => buildItemListData({ userId: USER_ID, pageNumber: 0 }))
  expectSyncCode('VALIDATION', () => buildItemListData({ userId: USER_ID, pageNumber: 1.5 }))
})

test('buildItemListData：userId 为空抛 VALIDATION', () => {
  expectSyncCode('VALIDATION', () => buildItemListData({ userId: '  ' }))
  expectSyncCode('VALIDATION', () => buildItemListData(undefined as unknown as { userId: string }))
})

test('parseUserHead：解析抓包确认的全部字段', () => {
  const profile = parseUserHead({ ret: ['SUCCESS::调用成功'], data: HEAD_DATA }, USER_ID)
  assert.deepEqual(profile, {
    userId: USER_ID,
    isSelf: false,
    encryptedUserId: 'enc-aa11bb22',
    kcUserId: 'kc-cc33dd44',
    displayName: '闲鱼小铺（脱敏）',
    avatar: 'https://img.example.com/avatar.jpg',
    ipLocation: '浙江 杭州',
    followers: 128,
    following: 7,
    followStatus: false,
    itemCount: 2,
    itemTabName: '宝贝',
    realNameCertified: true,
  })
})

test('parseUserHead：已剥出的 data 与完整响应结果一致', () => {
  assert.deepEqual(parseUserHead(HEAD_DATA, USER_ID), parseUserHead({ data: HEAD_DATA }, USER_ID))
})

test('parseUserHead：缺失字段保持 undefined，不填空值', () => {
  const profile = parseUserHead({ data: { baseInfo: {} } }, USER_ID)
  assert.deepEqual(profile, { userId: USER_ID })
})

test('parseUserHead：baseInfo.self 数字 1/字符串 true 归一为 isSelf=true', () => {
  const withSelf = (self: unknown) => parseUserHead({ data: { baseInfo: { ...BASE_INFO, self } } }, USER_ID)
  assert.equal(withSelf(1).isSelf, true)
  assert.equal(withSelf('true').isSelf, true)
  assert.equal(withSelf('0').isSelf, false)
  assert.equal(withSelf(undefined).isSelf, undefined)
})

test('parseUserHead：实名 tags 按前缀匹配，0 为 false、缺 tags 为 undefined', () => {
  const withTags = (tags: unknown) =>
    parseUserHead({ data: { baseInfo: { ...BASE_INFO, tags } } }, USER_ID)
  assert.equal(withTags({ real_name_certification_77: '0' }).realNameCertified, false)
  assert.equal(withTags({ real_name_certification: true }).realNameCertified, true)
  assert.equal(withTags({}).realNameCertified, undefined)
  assert.equal(withTags(undefined).realNameCertified, undefined)
})

test('parseUserHead：计数非法时抛 VALIDATION', () => {
  const badFollowers = { ...MODULE_BLOCK, social: { ...MODULE_BLOCK.social, followers: 'abc' } }
  expectSyncCode('VALIDATION', () => parseUserHead({ data: { baseInfo: BASE_INFO, module: badFollowers } }, USER_ID))
  const badCount = { ...MODULE_BLOCK, tabs: { item: { ...MODULE_BLOCK.tabs.item, number: -1 } } }
  expectSyncCode('VALIDATION', () => parseUserHead({ data: { baseInfo: BASE_INFO, module: badCount } }, USER_ID))
})

test('parseUserHead：非对象/缺 baseInfo+module 抛 VALIDATION', () => {
  expectSyncCode('VALIDATION', () => parseUserHead('{}' as unknown, USER_ID))
  expectSyncCode('VALIDATION', () => parseUserHead(null as unknown, USER_ID))
  expectSyncCode('VALIDATION', () => parseUserHead({ data: { ret: ['FAIL_SYS'] } }, USER_ID))
  expectSyncCode('VALIDATION', () => parseUserHead(HEAD_DATA, ' '))
})

test('parseItemList：两卡片解析 itemId/价格元→分/state/updatedAt', () => {
  const page = parseItemList(LIST_RESPONSE, 'acc-1', NOW)
  assert.equal(page.hasMore, true)
  assert.equal(page.pageNumber, 1)
  assert.deepEqual(page.items, [
    {
      itemId: '812345678901',
      accountId: 'acc-1',
      title: '九成新机械键盘',
      priceCents: 12_900,
      state: 'online',
      updatedAt: NOW,
    },
    {
      itemId: '812345678902',
      accountId: 'acc-1',
      title: '键盘键帽一套',
      priceCents: 3_050,
      state: 'online',
      updatedAt: NOW,
    },
  ])
})

test('parseItemList：title 缺失跳过卡片，数字 itemId 转字符串，已剥 data 可用', () => {
  const page = parseItemList(
    {
      cardList: [
        { cardData: { detailParams: { itemId: 812345678901, soldPrice: '129' } } },
        { cardData: { detailParams: { itemId: '812345678903', title: '有标题' } } },
      ],
      hasMore: false,
    },
    'acc-1',
    NOW,
  )
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0]?.itemId, '812345678903')
  assert.equal(page.items[0]?.title, '有标题')
})

test('parseItemList：itemId 缺失抛 VALIDATION 且定位到第 N 个卡片', () => {
  const error = expectSyncCode('VALIDATION', () =>
    parseItemList(
      {
        cardList: [
          { cardData: { detailParams: { itemId: '1', title: '正常' } } },
          { cardData: { detailParams: { title: '没有 itemId' } } },
        ],
      },
      'acc-1',
      NOW,
    ),
  )
  assert.match(error.message, /第 2 个卡片/)
})

test('parseItemList：soldPrice 缺失=0，无法解析抛 VALIDATION', () => {
  const page = parseItemList({ cardList: [{ detailParams: { itemId: '1', title: '无价' } }] }, 'acc-1', NOW)
  assert.equal(page.items[0]?.priceCents, 0)
  expectSyncCode('VALIDATION', () =>
    parseItemList({ cardList: [{ detailParams: { itemId: '1', title: '面议', soldPrice: '面议' } }] }, 'acc-1', NOW),
  )
})

test('parseItemList：cardList 缺失抛 VALIDATION', () => {
  expectSyncCode('VALIDATION', () => parseItemList({ data: { hasMore: true } }, 'acc-1', NOW))
  expectSyncCode('VALIDATION', () => parseItemList({ data: { cardList: {} } }, 'acc-1', NOW))
})

test('parseItemList：hasMore 字符串归一、缺省 false，pageNumber 字符串归一', () => {
  const page = parseItemList({ cardList: [], hasMore: 'true', pageNumber: '2' }, 'acc-1', NOW)
  assert.equal(page.hasMore, true)
  assert.equal(page.pageNumber, 2)
  const empty = parseItemList({ data: { cardList: [] } }, 'acc-1', NOW)
  assert.equal(empty.hasMore, false)
  assert.equal(empty.pageNumber, 1)
  assert.deepEqual(empty.items, [])
})

test('parseItemList：accountId 为空、now 非法、raw 非对象抛 VALIDATION', () => {
  expectSyncCode('VALIDATION', () => parseItemList(LIST_RESPONSE, '  ', NOW))
  expectSyncCode('VALIDATION', () => parseItemList(LIST_RESPONSE, 'acc-1', 1.5))
  expectSyncCode('VALIDATION', () => parseItemList('{}' as unknown, 'acc-1', NOW))
  expectSyncCode('VALIDATION', () => parseItemList({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'], data: null }, 'acc-1', NOW))
})

test('parseItemList：卡片直接平铺 detailParams 也能解析', () => {
  const page = parseItemList({ cardList: [{ detailParams: { itemId: '1', title: '平铺', soldPrice: '9.9' } }] }, 'acc-1', NOW)
  assert.equal(page.items[0]?.title, '平铺')
  assert.equal(page.items[0]?.priceCents, 990)
})

test('extractSellerIdFromDetail：数字/字符串 sellerId 统一为字符串', () => {
  const detail = { ret: ['SUCCESS::调用成功'], data: { itemDO: { title: 't' }, sellerDO: { sellerId: 2206569289277 } } }
  assert.equal(extractSellerIdFromDetail(detail), USER_ID)
  assert.equal(extractSellerIdFromDetail({ data: { sellerDO: { sellerId: USER_ID } } }), USER_ID)
})

test('extractSellerIdFromDetail：缺 sellerDO/sellerId 非法抛 VALIDATION', () => {
  expectSyncCode('VALIDATION', () => extractSellerIdFromDetail({ data: { itemDO: { title: 't' } } }))
  expectSyncCode('VALIDATION', () => extractSellerIdFromDetail({ data: { sellerDO: {} } }))
  expectSyncCode('VALIDATION', () => extractSellerIdFromDetail({ data: { sellerDO: { sellerId: '  ' } } }))
  expectSyncCode('VALIDATION', () => extractSellerIdFromDetail({ data: { sellerDO: { sellerId: 1.5 } } }))
  expectSyncCode('VALIDATION', () => extractSellerIdFromDetail('{}' as unknown))
})

test('extractSellerIdFromDetail：兼容已剥 data 且大 id 不丢精度', () => {
  assert.equal(extractSellerIdFromDetail({ sellerDO: { sellerId: 2206569289277 } }), USER_ID)
  const big = '812345678901234'
  assert.equal(extractSellerIdFromDetail({ data: { sellerDO: { sellerId: big } } }), big)
})
