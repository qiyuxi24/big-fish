/**
 * seller-items.ts 的行为测试：商家概览与商品快照的 upsert / 列表 / 计数 / 校验。
 * 红线断言：落库结果里不含描述与图片地址（只留 imageCount）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { XianyuError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import { createSellerRepository } from '../src/seller-items.ts'
import type { SellerItemInput, SellerRepository } from '../src/seller-items.ts'
import { openStore } from '../src/store.ts'
import type { Store } from '../src/store.ts'

const NOW = 1_700_000_000_000
const SELLER_ID = '2206569289277'
const ACCOUNT_ID = '2206569289277'

interface Fixture {
  store: Store
  repo: SellerRepository
}

function setup(t: TestContext): Fixture {
  const store = openStore({ path: ':memory:', now: () => NOW })
  t.after(() => store.close())
  return { store, repo: createSellerRepository({ store, now: () => NOW }) }
}

function expectCode(code: ErrorCode, body: () => unknown): void {
  try {
    body()
  } catch (error) {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, code)
    return
  }
  assert.fail('预期抛出 ' + code)
}

function itemInput(overrides: Partial<SellerItemInput> = {}): SellerItemInput {
  return {
    itemId: '1091933071728',
    sellerId: SELLER_ID,
    accountId: ACCOUNT_ID,
    title: '机械键盘 有线 背光',
    priceCents: 12900,
    imageCount: 3,
    collectedAt: NOW,
    ...overrides,
  }
}

test('saveItem：首次写入后可列出，collectedAt 缺省用注入时钟', (t) => {
  const { repo } = setup(t)
  // 不传 collectedAt（而不是传 undefined）：exactOptionalPropertyTypes 下两者不同。
  const saved = repo.saveItem({
    itemId: '1091933071728', sellerId: SELLER_ID, accountId: ACCOUNT_ID,
    title: '机械键盘 有线 背光', priceCents: 12900, imageCount: 3,
  })
  assert.equal(saved.itemId, '1091933071728')
  assert.equal(saved.collectedAt, NOW)
  assert.equal(saved.priceCents, 12900)
  assert.equal(saved.imageCount, 3)

  const rows = repo.listItems(SELLER_ID)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.title, '机械键盘 有线 背光')
  assert.equal(repo.countItems(SELLER_ID), 1)
  assert.equal(repo.countItems(), 1)
})

test('saveItem：同 itemId 覆盖写，不产生重复行；可选字段 undefined 不写键', (t) => {
  const { repo } = setup(t)
  repo.saveItem(itemInput())
  const updated = repo.saveItem(itemInput({ title: '机械键盘（已改价）', priceCents: 9900, browseCount: 12, wantCount: 3, categoryId: '50023914', publishedAt: 1792591919000 }))
  assert.equal(repo.countItems(SELLER_ID), 1)
  assert.equal(updated.title, '机械键盘（已改价）')
  assert.equal(updated.priceCents, 9900)
  assert.equal(updated.browseCount, 12)
  assert.equal(updated.categoryId, '50023914')
  // 缺字段 ≠ 0：没给的字段不出现。
  assert.equal('collectCount' in updated, false)
  assert.equal('originalPriceCents' in updated, false)
})

test('saveItem：红线——不落描述与图片地址，只留 imageCount', (t) => {
  const { repo, store } = setup(t)
  repo.saveItem(itemInput())
  const row = store.db.prepare('SELECT * FROM seller_items').get()
  assert.ok(row !== undefined)
  const columns = Object.keys(row)
  assert.equal(columns.includes('desc'), false)
  assert.equal(columns.includes('image_urls'), false)
  assert.equal(columns.includes('images'), false)
  assert.equal(row.image_count, 3)
})

test('saveProfile：同 sellerId 覆盖写，isSelf 落成 0/1，缺字段不出现', (t) => {
  const { repo } = setup(t)
  repo.saveProfile({ sellerId: SELLER_ID, nick: '某商家', city: '西安', itemCount: 7, registeredYear: 2012, soldCount: 2, isSelf: true })
  const updated = repo.saveProfile({ sellerId: SELLER_ID, nick: '某商家（改名）', isSelf: false })
  assert.equal(updated.nick, '某商家（改名）')
  assert.equal(updated.isSelf, false)

  const profiles = repo.listProfiles()
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0]?.sellerId, SELLER_ID)
  // 第二次只给了 nick/isSelf，其余字段被 null 覆盖 → 读回是 undefined，不虚构旧值。
  assert.equal('itemCount' in (profiles[0] ?? {}), false)
})

test('listItems：按 collectedAt 倒序，limit 上限 500', (t) => {
  const { repo } = setup(t)
  repo.saveItem(itemInput({ itemId: '1', collectedAt: NOW - 2000 }))
  repo.saveItem(itemInput({ itemId: '2', collectedAt: NOW }))
  repo.saveItem(itemInput({ itemId: '3', collectedAt: NOW - 1000 }))
  assert.deepEqual(repo.listItems(SELLER_ID).map((row) => row.itemId), ['2', '3', '1'])
  assert.deepEqual(repo.listItems(SELLER_ID, 2).map((row) => row.itemId), ['2', '3'])
  expectCode('VALIDATION', () => repo.listItems(SELLER_ID, 501))
  expectCode('VALIDATION', () => repo.listItems(SELLER_ID, 0))
})

test('校验：id 非法、title 超长、负价格、计数非整数一律 VALIDATION', (t) => {
  const { repo } = setup(t)
  expectCode('VALIDATION', () => repo.saveItem(itemInput({ itemId: '' })))
  expectCode('VALIDATION', () => repo.saveItem(itemInput({ sellerId: 'has space' })))
  expectCode('VALIDATION', () => repo.saveItem(itemInput({ title: 'x'.repeat(201) })))
  expectCode('VALIDATION', () => repo.saveItem(itemInput({ priceCents: -1 })))
  expectCode('VALIDATION', () => repo.saveItem(itemInput({ priceCents: 1.5 })))
  expectCode('VALIDATION', () => repo.saveItem(itemInput({ imageCount: -1 })))
  expectCode('VALIDATION', () => repo.saveItem(itemInput({ browseCount: Number.NaN })))
  expectCode('VALIDATION', () => repo.saveProfile({ sellerId: SELLER_ID, isSelf: 'yes' as unknown as boolean }))
})

test('存库隔离：不同商家的商品互不串（items 表也不受影响）', (t) => {
  const { repo, store } = setup(t)
  repo.saveItem(itemInput({ itemId: 'a', sellerId: '111' }))
  repo.saveItem(itemInput({ itemId: 'b', sellerId: '222' }))
  assert.deepEqual(repo.listItems('111').map((row) => row.itemId), ['a'])
  assert.deepEqual(repo.listItems('222').map((row) => row.itemId), ['b'])
  assert.equal(repo.countItems(), 2)
  const legacy = store.db.prepare('SELECT COUNT(*) AS total FROM items').get()
  assert.equal(legacy?.total, 0)
})
