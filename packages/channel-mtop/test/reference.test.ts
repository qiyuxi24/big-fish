import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XianyuError } from '@bigfish/core'
import { extractTitleKeywords, parseItemReference, summarizeReferences } from '../src/index.ts'

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

/**
 * 脱敏 fixture：结构照 2026-10-21 真机抓包（mtop.taobao.idle.pc.detail，样本 .scratch/collect/detail.json），
 * 账号 id / 昵称 / 图片地址 / 城市全部替换成假值，字段名与嵌套层级保持原样。
 */
const DETAIL_RESPONSE = {
  ret: ['SUCCESS::调用成功'],
  data: {
    itemDO: {
      itemId: 812345678901,
      title: '九成新机械键盘 87 键 白色背光 送键帽',
      desc: '自用半年，无划痕。\n送一套 PBT 键帽，顺丰包邮。',
      soldPrice: '129',
      originalPrice: '0',
      categoryId: 50023914,
      itemCatDTO: { catId: 50023914, rootChannelCatId: 202284911 },
      imageInfos: [{ url: 'https://img.example.com/a.jpg' }, { url: 'https://img.example.com/b.jpg' }],
      cpvLabels: [
        { propertyName: '成色', valueName: '9成新' },
        { propertyName: '类型', valueName: '机械键盘' },
        { propertyName: '坏字段' },
      ],
      browseCnt: 41,
      wantCnt: 3,
      collectCnt: 5,
      soldCnt: 0,
      quantity: 1,
      gmtCreate: 1792591919000,
    },
    b2cItemDO: { wantBuyCount: 7 },
    sellerDO: {
      sellerId: 2206569289277,
      nick: '闲鱼小铺（脱敏）',
      city: '西安',
      itemCount: 7,
      userRegDay: 2012,
      hasSoldNumInteger: 2,
      xianyuSummary: '卖出过2件宝贝。',
      sellerItems: [
        { itemId: 1077216613189, title: '西工大纪念卡', text: '¥30' },
        { itemId: 1080208360416, title: '简历优化咨询', text: '¥50/次' },
        { itemId: 0, title: '' },
      ],
    },
  },
}

test('parseItemReference：富字段全部落到 ReferenceItem（价格分、类目、属性、计数、发布时间）', () => {
  const ref = parseItemReference(DETAIL_RESPONSE)
  assert.equal(ref.itemId, '812345678901')
  assert.equal(ref.title, '九成新机械键盘 87 键 白色背光 送键帽')
  assert.equal(ref.priceCents, 12_900)
  assert.equal(ref.categoryId, '50023914')
  assert.deepEqual(ref.properties, [
    { name: '成色', value: '9成新' },
    { name: '类型', value: '机械键盘' },
  ])
  assert.equal(ref.imageCount, 2)
  assert.equal(ref.browseCount, 41)
  assert.equal(ref.wantCount, 3)
  assert.equal(ref.collectCount, 5)
  assert.equal(ref.soldCount, 0)
  assert.equal(ref.publishedAt, 1792591919000)
  assert.equal(ref.seller.sellerId, '2206569289277')
  assert.equal(ref.seller.nick, '闲鱼小铺（脱敏）')
  assert.equal(ref.seller.city, '西安')
  assert.equal(ref.seller.itemCount, 7)
  assert.equal(ref.seller.registeredYear, 2012)
  assert.equal(ref.seller.soldCount, 2)
  assert.equal(ref.desc?.includes('顺丰包邮'), true)
  assert.deepEqual(ref.siblingItems, [
    { itemId: '1077216613189', title: '西工大纪念卡', priceCents: 3000 },
    { itemId: '1080208360416', title: '简历优化咨询', priceCents: 5000 },
  ])
  // 合规：只给图片数量，不返回图片地址
  assert.equal(JSON.stringify(ref).includes('img.example.com'), false)
})

test('parseItemReference：desc 为空时回退 richTextDesc 的 Text 节点，全空则不给字段', () => {
  const rich = parseItemReference({
    data: {
      itemDO: {
        itemId: '1',
        title: '标题',
        richTextDesc: {
          children: [{ children: [{ text: '第一段' }] }, { children: [{ text: '第二段' }] }],
        },
      },
      sellerDO: { sellerId: 1 },
    },
  })
  assert.equal(rich.desc, '第一段第二段')
  const none = parseItemReference({
    data: { itemDO: { itemId: '2', title: '只有标题' }, sellerDO: { sellerId: 1 } },
  })
  assert.equal('desc' in none, false)
  assert.deepEqual(none.properties, [])
  assert.equal(none.imageCount, 0)
  assert.deepEqual(none.siblingItems, [])
})

test('parseItemReference：wantCnt 缺失时回退 b2cItemDO.wantBuyCount；扁平 data 形态也接受', () => {
  const flat = parseItemReference({
    data: {
      itemId: '812345678902',
      title: '扁平形态商品',
      soldPrice: '9.9',
      categoryId: '123',
      b2cItemDO: { wantBuyCount: 7 },
      sellerDO: { sellerId: '42' },
    },
  })
  assert.equal(flat.itemId, '812345678902')
  assert.equal(flat.priceCents, 990)
  assert.equal(flat.wantCount, 7)
  assert.equal(flat.seller.sellerId, '42')
})

test('parseItemReference：缺 itemId / title / sellerDO.sellerId 一律 VALIDATION，不猜', () => {
  expectSyncCode('VALIDATION', () => parseItemReference({ data: { itemDO: { title: 'x' }, sellerDO: { sellerId: 1 } } }))
  expectSyncCode('VALIDATION', () => parseItemReference({ data: { itemDO: { itemId: '1' }, sellerDO: { sellerId: 1 } } }))
  expectSyncCode('VALIDATION', () => parseItemReference({ data: { itemDO: { itemId: '1', title: 'x' } } }))
  expectSyncCode('VALIDATION', () => parseItemReference(null))
  expectSyncCode('VALIDATION', () => parseItemReference({ data: { itemDO: { itemId: '1', title: 'x', browseCnt: -1 }, sellerDO: { sellerId: 1 } } }))
})

test('extractTitleKeywords：只留出现≥2次的词，纯虚词片段被过滤，英文/数字单独计', () => {
  const words = extractTitleKeywords([
    '九成新机械键盘 白色背光',
    '九成新机械键盘 有线',
    '机械键盘 RGB 背光',
    '全新的',
  ])
  const map = new Map(words.map((entry) => [entry.word, entry.count]))
  // 「机械键盘」整段只在第 3 个标题里出现，靠 2-gram「机械」累计到 3
  assert.equal(map.get('机械'), 3)
  assert.equal(map.get('九成'), 2)
  assert.equal(map.get('背光'), 2)
  // 只出现 1 次的（有线 / RGB / 全新的）不进榜
  assert.equal(map.get('有线'), undefined)
  assert.equal(map.get('RGB'), undefined)
  assert.equal(map.get('全新'), undefined)
  assert.equal(map.get('新的'), undefined)
  // 4 字以内的中文片段会整段计一次
  const whole = new Map(extractTitleKeywords(['全新未拆', '全新未拆 包邮']).map((entry) => [entry.word, entry.count]))
  assert.equal(whole.get('全新未拆'), 2)
  // 频次降序
  assert.ok(words[0] !== undefined && words[0].count >= (words[words.length - 1]?.count ?? 0))
  expectSyncCode('VALIDATION', () => extractTitleKeywords(['a'], 0))
})

test('summarizeReferences：价格带/标题长度/类目分布/主图数/描述覆盖率', () => {
  const items = [
    parseItemReference({
      data: {
        itemDO: { itemId: '1', title: '九成新机械键盘', soldPrice: '100', categoryId: '11', desc: '有描述', imageInfos: [{}, {}, {}] },
        sellerDO: { sellerId: 1 },
      },
    }),
    parseItemReference({
      data: { itemDO: { itemId: '2', title: '九成新机械键盘 白色', soldPrice: '200', categoryId: '11', imageInfos: [{}] }, sellerDO: { sellerId: 1 } },
    }),
    parseItemReference({
      data: { itemDO: { itemId: '3', title: '显示器支架', soldPrice: '50', categoryId: '22' }, sellerDO: { sellerId: 1 } },
    }),
  ]
  const summary = summarizeReferences(items)
  assert.equal(summary.count, 3)
  assert.deepEqual(summary.priceCents, { min: 5000, median: 10_000, max: 20_000, avg: 11_667 })
  assert.deepEqual(summary.titleLength, { min: 5, max: 10, avg: 7 })
  assert.equal(summary.imageCountAvg, 1)
  assert.equal(summary.descRatio, 0.33)
  assert.deepEqual(summary.categories, [
    { categoryId: '11', count: 2 },
    { categoryId: '22', count: 1 },
  ])
  assert.ok(summary.keywords.some((entry) => entry.word === '机械'))
})

test('summarizeReferences：空数组给零值，不抛错', () => {
  const summary = summarizeReferences([])
  assert.equal(summary.count, 0)
  assert.deepEqual(summary.priceCents, { min: 0, median: 0, max: 0, avg: 0 })
  assert.deepEqual(summary.titleLength, { min: 0, max: 0, avg: 0 })
  assert.equal(summary.descRatio, 0)
  assert.deepEqual(summary.categories, [])
  assert.deepEqual(summary.keywords, [])
})
