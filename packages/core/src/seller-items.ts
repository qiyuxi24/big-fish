/**
 * 「采集到的商家商品」仓储（seller_items / sellers 两张表）。
 *
 * 为什么单独成表而不是复用 items：`items` 是**自己账号的商品摘要**（发布、擦亮、校验都读它），
 * 只存 6 列且以 item_id 为主键；采集参考要存商家量级、类目、浏览/想要/收藏/卖出数与发布时间，
 * 语义是「行情快照」而不是「我的货」，混在一起会污染发布链路。
 *
 * 红线（AGENTS §1.6）：只落**结构化元数据**——不存图片 URL、不存描述全文、不存任何可复用的素材，
 * 因此这里没有 desc / image_infos 字段。要发的是用户自己的货。
 * @module @bigfish/core/seller-items
 */
import type { StatementSync } from 'node:sqlite'

import { fail, toXianyuError } from './errors.ts'
import { assertCopyFeatures, assertImageFeatures, decodeFeatureColumn } from './seller-features.ts'
import type { SellerItemCopyFeatures, SellerItemImageFeatures } from './seller-features.ts'
import {
  assertCents,
  assertCount,
  assertFlag,
  assertId,
  assertLimit,
  assertTimestamp,
  assertTitle,
  optionalCents,
  optionalText,
} from './seller-item-validate.ts'
import {
  asSqlRow,
  readSqlNumber,
  readSqlOptionalNumber,
  readSqlOptionalText,
  readSqlText,
  withTransaction,
} from './store.ts'
import type { SqlRow, Store } from './store.ts'

/** 商家概览（来自 user.page.head + 详情里的 sellerDO）。缺失字段保持 undefined，绝不填 0。 */
export interface SellerProfileRecord {
  sellerId: string
  nick?: string
  city?: string
  itemCount?: number
  /** 平台给的注册年份（userRegDay），不是完整时间戳。 */
  registeredYear?: number
  soldCount?: number
  /** 是否就是当前登录账号自己的店（合规判定用：拉别人的店要用户显式确认）。 */
  isSelf?: boolean
  collectedAt: number
}

/** 写商家概览的入参；collectedAt 缺省用当前时间。 */
export interface SellerProfileInput {
  sellerId: string
  nick?: string
  city?: string
  itemCount?: number
  registeredYear?: number
  soldCount?: number
  isSelf?: boolean
  collectedAt?: number
}

/** 单件商家商品的行情快照。 */
export interface SellerItemRecord {
  itemId: string
  sellerId: string
  /** 用哪个账号的登录态采的（排查用；不代表商品归属）。 */
  accountId: string
  title: string
  priceCents: number
  originalPriceCents?: number
  categoryId?: string
  /** 主图数量（只计数，不存地址）。 */
  imageCount: number
  browseCount?: number
  wantCount?: number
  collectCount?: number
  soldCount?: number
  /** 发布时间（毫秒）。 */
  publishedAt?: number
  collectedAt: number
  /** 文案结构特征（不含原文）；采集时没算就缺省。 */
  copyFeatures?: SellerItemCopyFeatures
  /** 主图构成特征（不含地址）；采集时没算就缺省。 */
  imageFeatures?: SellerItemImageFeatures
}

/** 写商品快照的入参；collectedAt 缺省用当前时间。 */
export interface SellerItemInput {
  itemId: string
  sellerId: string
  accountId: string
  title: string
  priceCents: number
  originalPriceCents?: number
  categoryId?: string
  imageCount: number
  browseCount?: number
  wantCount?: number
  collectCount?: number
  soldCount?: number
  publishedAt?: number
  collectedAt?: number
  copyFeatures?: SellerItemCopyFeatures
  imageFeatures?: SellerItemImageFeatures
}

/** 采集结果仓储；daemon 只依赖这个接口，不直接拼 SQL。 */
export interface SellerRepository {
  saveProfile(input: SellerProfileInput): SellerProfileRecord
  saveItem(input: SellerItemInput): SellerItemRecord
  /** 某商家的商品快照，最近采集在前；limit 缺省 200、上限 500。 */
  listItems(sellerId: string, limit?: number): SellerItemRecord[]
  /** 某个类目的商品快照（跨商家），最近采集在前；limit 缺省 200、上限 500。 */
  listItemsByCategory(categoryId: string, limit?: number): SellerItemRecord[]
  /** 全库商品快照，可按类目筛，最近采集在前；limit 缺省 200、上限 500。 */
  listAllItems(filter?: SellerItemListFilter): SellerItemRecord[]
  /** 某商家的商品数（不给 sellerId 时为全库）。 */
  countItems(sellerId?: string): number
  /** 已采集过的商家，最近采集在前。 */
  listProfiles(limit?: number): SellerProfileRecord[]
}

/** listAllItems 的筛选条件：都可不给（都不给 = 全库，按采集时间倒序）。 */
export interface SellerItemListFilter {
  categoryId?: string
  limit?: number
}

export interface SellerRepositoryOptions {
  store: Store
  /** 注入时钟（整数毫秒）；测试用假时钟。 */
  now?: () => number
}

const ITEM_COLUMNS = `item_id, seller_id, account_id, title, price_cents, original_price_cents,
  category_id, image_count, browse_count, want_count, collect_count, sold_count, published_at, collected_at,
  copy_features, image_features`

const PROFILE_COLUMNS = 'seller_id, nick, city, item_count, registered_year, sold_count, is_self, collected_at'

const SQL = {
  upsertItem: `INSERT INTO seller_items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      seller_id = excluded.seller_id,
      account_id = excluded.account_id,
      title = excluded.title,
      price_cents = excluded.price_cents,
      original_price_cents = excluded.original_price_cents,
      category_id = excluded.category_id,
      image_count = excluded.image_count,
      browse_count = excluded.browse_count,
      want_count = excluded.want_count,
      collect_count = excluded.collect_count,
      sold_count = excluded.sold_count,
      published_at = excluded.published_at,
      collected_at = excluded.collected_at,
      copy_features = excluded.copy_features,
      image_features = excluded.image_features`,
  selectItem: `SELECT ${ITEM_COLUMNS} FROM seller_items WHERE item_id = ?`,
  listBySeller: `SELECT ${ITEM_COLUMNS} FROM seller_items WHERE seller_id = ?
    ORDER BY collected_at DESC, item_id ASC LIMIT ?`,
  listByCategory: `SELECT ${ITEM_COLUMNS} FROM seller_items WHERE category_id = ?
    ORDER BY collected_at DESC, item_id ASC LIMIT ?`,
  listAll: `SELECT ${ITEM_COLUMNS} FROM seller_items
    ORDER BY collected_at DESC, item_id ASC LIMIT ?`,
  countAll: 'SELECT COUNT(*) AS total FROM seller_items',
  countBySeller: 'SELECT COUNT(*) AS total FROM seller_items WHERE seller_id = ?',
  upsertProfile: `INSERT INTO sellers (${PROFILE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(seller_id) DO UPDATE SET
      nick = excluded.nick,
      city = excluded.city,
      item_count = excluded.item_count,
      registered_year = excluded.registered_year,
      sold_count = excluded.sold_count,
      is_self = excluded.is_self,
      collected_at = excluded.collected_at`,
  selectProfile: `SELECT ${PROFILE_COLUMNS} FROM sellers WHERE seller_id = ?`,
  listProfiles: `SELECT ${PROFILE_COLUMNS} FROM sellers ORDER BY collected_at DESC, seller_id ASC LIMIT ?`,
}

/** 建仓储；store 已关闭时在这里就抛 STORAGE，而不是等到首次查询。 */
export function createSellerRepository(options: SellerRepositoryOptions): SellerRepository {
  if (typeof options !== 'object' || options === null) fail('VALIDATION', 'createSellerRepository 需要参数对象')
  const handle: unknown = (options as { store?: unknown }).store
  if (handle === undefined || handle === null) fail('VALIDATION', 'createSellerRepository 需要已打开的 store')
  const store = handle as Store
  const now = options.now ?? ((): number => Date.now())
  const sql = runSql(() => ({
    upsertItem: store.db.prepare(SQL.upsertItem),
    selectItem: store.db.prepare(SQL.selectItem),
    listBySeller: store.db.prepare(SQL.listBySeller),
    listByCategory: store.db.prepare(SQL.listByCategory),
    listAll: store.db.prepare(SQL.listAll),
    countAll: store.db.prepare(SQL.countAll),
    countBySeller: store.db.prepare(SQL.countBySeller),
    upsertProfile: store.db.prepare(SQL.upsertProfile),
    selectProfile: store.db.prepare(SQL.selectProfile),
    listProfiles: store.db.prepare(SQL.listProfiles),
  }))
  return {
    saveProfile: (input) => saveProfile(store, sql, now, input),
    saveItem: (input) => saveItem(store, sql, now, input),
    listItems: (sellerId, limit) => listItems(sql, sellerId, limit),
    listItemsByCategory: (categoryId, limit) => listItemsByCategory(sql, categoryId, limit),
    listAllItems: (filter) => listAllItems(sql, filter),
    countItems: (sellerId) => countItems(sql, sellerId),
    listProfiles: (limit) => listProfiles(sql, limit),
  }
}

/** 预算好的语句集合；只在建仓储时准备一次。 */
interface Sql {
  upsertItem: StatementSync
  selectItem: StatementSync
  listBySeller: StatementSync
  listByCategory: StatementSync
  listAll: StatementSync
  countAll: StatementSync
  countBySeller: StatementSync
  upsertProfile: StatementSync
  selectProfile: StatementSync
  listProfiles: StatementSync
}

function saveItem(store: Store, sql: Sql, now: () => number, input: SellerItemInput): SellerItemRecord {
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'saveItem 需要入参对象')
  const itemId = assertId(input.itemId, 'itemId')
  const sellerId = assertId(input.sellerId, 'sellerId')
  const accountId = assertId(input.accountId, 'accountId')
  const title = assertTitle(input.title)
  const priceCents = assertCents(input.priceCents, 'priceCents')
  const originalPriceCents = optionalCents(input.originalPriceCents, 'originalPriceCents')
  const categoryId = input.categoryId === undefined ? undefined : assertId(input.categoryId, 'categoryId')
  const imageCount = assertCount(input.imageCount, 'imageCount') ?? 0
  const browseCount = assertCount(input.browseCount, 'browseCount')
  const wantCount = assertCount(input.wantCount, 'wantCount')
  const collectCount = assertCount(input.collectCount, 'collectCount')
  const soldCount = assertCount(input.soldCount, 'soldCount')
  const publishedAt = input.publishedAt === undefined ? undefined : assertTimestamp(input.publishedAt, 'publishedAt')
  const collectedAt = input.collectedAt === undefined ? now() : assertTimestamp(input.collectedAt, 'collectedAt')
  const copyFeatures = input.copyFeatures === undefined ? undefined : assertCopyFeatures(input.copyFeatures)
  const imageFeatures = input.imageFeatures === undefined ? undefined : assertImageFeatures(input.imageFeatures)
  return withTransaction(store.db, () => {
    sql.upsertItem.run(
      itemId, sellerId, accountId, title, priceCents, originalPriceCents ?? null,
      categoryId ?? null, imageCount, browseCount ?? null, wantCount ?? null,
      collectCount ?? null, soldCount ?? null, publishedAt ?? null, collectedAt,
      copyFeatures === undefined ? null : JSON.stringify(copyFeatures),
      imageFeatures === undefined ? null : JSON.stringify(imageFeatures),
    )
    return readItem(sql.selectItem.get(itemId))
  })
}

function saveProfile(store: Store, sql: Sql, now: () => number, input: SellerProfileInput): SellerProfileRecord {
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'saveProfile 需要入参对象')
  const sellerId = assertId(input.sellerId, 'sellerId')
  const nick = optionalText(input.nick)
  const city = optionalText(input.city)
  const itemCount = assertCount(input.itemCount, 'itemCount')
  const registeredYear = assertCount(input.registeredYear, 'registeredYear')
  const soldCount = assertCount(input.soldCount, 'soldCount')
  const isSelf = input.isSelf === undefined ? undefined : assertFlag(input.isSelf)
  const collectedAt = input.collectedAt === undefined ? now() : assertTimestamp(input.collectedAt, 'collectedAt')
  return withTransaction(store.db, () => {
    sql.upsertProfile.run(
      sellerId, nick ?? null, city ?? null, itemCount ?? null,
      registeredYear ?? null, soldCount ?? null, isSelf === undefined ? null : isSelf ? 1 : 0, collectedAt,
    )
    return readProfile(sql.selectProfile.get(sellerId))
  })
}

function listItems(sql: Sql, sellerId: string, limit?: number): SellerItemRecord[] {
  const seller = assertId(sellerId, 'sellerId')
  const size = assertLimit(limit)
  return runSql(() => sql.listBySeller.all(seller, size)).map((row) => readItem(row))
}

function listItemsByCategory(sql: Sql, categoryId: string, limit?: number): SellerItemRecord[] {
  const category = assertId(categoryId, 'categoryId')
  const size = assertLimit(limit)
  return runSql(() => sql.listByCategory.all(category, size)).map((row) => readItem(row))
}

function listAllItems(sql: Sql, filter?: SellerItemListFilter): SellerItemRecord[] {
  if (filter !== undefined && (typeof filter !== 'object' || filter === null)) {
    fail('VALIDATION', 'listAllItems 的筛选参数必须是对象')
  }
  const category = filter?.categoryId === undefined ? undefined : assertId(filter.categoryId, 'categoryId')
  const size = assertLimit(filter?.limit)
  // 两个分支各自参数化：不给类目时走 listAll，给类目时复用 listByCategory。
  // 不拼 SQL 字符串——拼接既会被类目 id 注入，也享受不到语句缓存。
  const rows = category === undefined
    ? runSql(() => sql.listAll.all(size))
    : runSql(() => sql.listByCategory.all(category, size))
  return rows.map((row) => readItem(row))
}

function countItems(sql: Sql, sellerId?: string): number {
  const seller = sellerId === undefined ? undefined : assertId(sellerId, 'sellerId')
  const raw = runSql(() => (seller === undefined ? sql.countAll.get() : sql.countBySeller.get(seller)))
  const row = asSqlRow(raw)
  return row === undefined ? 0 : readSqlNumber(row, 'total')
}

function listProfiles(sql: Sql, limit?: number): SellerProfileRecord[] {
  const size = assertLimit(limit)
  return runSql(() => sql.listProfiles.all(size)).map((row) => readProfile(row))
}

function readItem(raw: unknown): SellerItemRecord {
  const row = asSqlRow(raw)
  if (row === undefined) fail('STORAGE', '商家商品记录不存在')
  return withOptional({
    itemId: readSqlText(row, 'item_id'),
    sellerId: readSqlText(row, 'seller_id'),
    accountId: readSqlText(row, 'account_id'),
    title: readSqlText(row, 'title'),
    priceCents: readSqlNumber(row, 'price_cents'),
    imageCount: readSqlNumber(row, 'image_count'),
    collectedAt: readSqlNumber(row, 'collected_at'),
  }, {
    originalPriceCents: readSqlOptionalNumber(row, 'original_price_cents'),
    categoryId: readSqlOptionalText(row, 'category_id'),
    browseCount: readSqlOptionalNumber(row, 'browse_count'),
    wantCount: readSqlOptionalNumber(row, 'want_count'),
    collectCount: readSqlOptionalNumber(row, 'collect_count'),
    soldCount: readSqlOptionalNumber(row, 'sold_count'),
    publishedAt: readSqlOptionalNumber(row, 'published_at'),
    copyFeatures: decodeFeatureColumn(readSqlOptionalText(row, 'copy_features'), 'copy_features', assertCopyFeatures),
    imageFeatures: decodeFeatureColumn(readSqlOptionalText(row, 'image_features'), 'image_features', assertImageFeatures),
  })
}

function readProfile(raw: unknown): SellerProfileRecord {
  const row = asSqlRow(raw)
  if (row === undefined) fail('STORAGE', '商家记录不存在')
  const isSelf = readSqlOptionalNumber(row, 'is_self')
  return withOptional({
    sellerId: readSqlText(row, 'seller_id'),
    collectedAt: readSqlNumber(row, 'collected_at'),
  }, {
    nick: readSqlOptionalText(row, 'nick'),
    city: readSqlOptionalText(row, 'city'),
    itemCount: readSqlOptionalNumber(row, 'item_count'),
    registeredYear: readSqlOptionalNumber(row, 'registered_year'),
    soldCount: readSqlOptionalNumber(row, 'sold_count'),
    isSelf: isSelf === undefined ? undefined : isSelf !== 0,
  })
}

/** 只把「有值」的可选字段挂上去；undefined 不写键，保持「缺字段 ≠ 0」。 */
function withOptional<T extends object>(base: T, optional: Record<string, unknown>): T {
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

/** 把 node:sqlite 的运行时错误统一收敛成 STORAGE（例如连接已关闭）。 */
function runSql<T>(body: () => T): T {
  try {
    return body()
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}