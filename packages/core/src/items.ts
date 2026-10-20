/**
 * 商品摘要仓储（items 表读写）。
 *
 * 为什么单独成模块：daemon 执行器与 HTTP 路由只依赖 ItemRepository 接口，
 * 不直接拼 SQL；建表与迁移仍归 store.ts 所有，这里只做校验 + 参数绑定。
 * @module @bigfish/core/items
 */
import type { DatabaseSync } from 'node:sqlite'
import { fail, toXianyuError } from './errors.ts'
import { asSqlRow, readSqlNumber, readSqlText, withTransaction } from './store.ts'
import type { SqlRow, Store } from './store.ts'
import type { AccountId, ItemFilter, ItemRepository, ItemState, ItemSummary, ItemUpsertInput } from './types.ts'

/** 仓储构造参数：store 必填（复用进程内唯一连接），now 只影响 updatedAt 缺省值。 */
export interface ItemRepositoryOptions {
  store: Store
  /** 注入时钟（整数毫秒）；测试用假时钟。 */
  now?: () => number
}

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 500
const MAX_ITEM_ID_CHARS = 64
const MAX_TITLE_CHARS = 200
const ITEM_STATES: readonly ItemState[] = ['online', 'offline', 'unknown']
/** 账号 id 与本地配置文件里的键同形，避免出现无法放进 URL/文件名里的字符。 */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

const ITEM_COLUMNS = 'item_id, account_id, title, price_cents, state, updated_at'
/** 列表按最近更新在前；同一毫秒内按 itemId 升序，保证分页边界稳定。 */
const SCAN_ORDER = 'ORDER BY updated_at DESC, item_id ASC'

const SQL_TEXT = {
  upsert: `INSERT INTO items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      account_id = excluded.account_id,
      title = excluded.title,
      price_cents = excluded.price_cents,
      state = excluded.state,
      updated_at = excluded.updated_at`,
  selectById: `SELECT ${ITEM_COLUMNS} FROM items WHERE item_id = ?`,
  listAll: `SELECT ${ITEM_COLUMNS} FROM items ${SCAN_ORDER} LIMIT ?`,
  listByAccount: `SELECT ${ITEM_COLUMNS} FROM items WHERE account_id = ? ${SCAN_ORDER} LIMIT ?`,
  listByState: `SELECT ${ITEM_COLUMNS} FROM items WHERE state = ? ${SCAN_ORDER} LIMIT ?`,
  listByAccountState: `SELECT ${ITEM_COLUMNS} FROM items WHERE account_id = ? AND state = ? ${SCAN_ORDER} LIMIT ?`,
  countAll: 'SELECT COUNT(*) AS total FROM items',
  countByAccount: 'SELECT COUNT(*) AS total FROM items WHERE account_id = ?',
} as const

type Statement = ReturnType<DatabaseSync['prepare']>

interface ItemStatements {
  upsert: Statement
  selectById: Statement
  listAll: Statement
  listByAccount: Statement
  listByState: Statement
  listByAccountState: Statement
  countAll: Statement
  countByAccount: Statement
}

/** 建仓储；store 已关闭时在这里就抛 STORAGE，而不是等到首次查询。 */
export function createItemRepository(options: ItemRepositoryOptions): ItemRepository {
  if (typeof options !== 'object' || options === null) fail('VALIDATION', 'createItemRepository 需要参数对象')
  const store: unknown = (options as { store?: unknown }).store
  if (store === undefined || store === null) fail('VALIDATION', 'createItemRepository 需要已打开的 store')
  const handle = store as Store
  const now = options.now ?? ((): number => Date.now())
  const sql = runSql(() => prepareStatements(handle.db))
  return {
    upsert: (input: ItemUpsertInput): ItemSummary => upsertItem(handle, sql, now, input),
    get: (itemId: string): ItemSummary | undefined => getItem(sql, itemId),
    list: (filter?: ItemFilter): ItemSummary[] => listItems(sql, filter),
    count: (accountId?: AccountId): number => countItems(sql, accountId),
  }
}

/** 商品状态白名单判定，与 items 表的取值约定一致。 */
export function isItemState(value: unknown): value is ItemState {
  return typeof value === 'string' && (ITEM_STATES as readonly string[]).includes(value)
}

function prepareStatements(db: DatabaseSync): ItemStatements {
  return {
    upsert: db.prepare(SQL_TEXT.upsert),
    selectById: db.prepare(SQL_TEXT.selectById),
    listAll: db.prepare(SQL_TEXT.listAll),
    listByAccount: db.prepare(SQL_TEXT.listByAccount),
    listByState: db.prepare(SQL_TEXT.listByState),
    listByAccountState: db.prepare(SQL_TEXT.listByAccountState),
    countAll: db.prepare(SQL_TEXT.countAll),
    countByAccount: db.prepare(SQL_TEXT.countByAccount),
  }
}

function upsertItem(store: Store, sql: ItemStatements, now: () => number, input: ItemUpsertInput): ItemSummary {
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'upsert 需要入参对象')
  const itemId = assertItemId(input.itemId)
  const accountId = assertAccountId(input.accountId)
  const title = assertTitle(input.title)
  const priceCents = assertPriceCents(input.priceCents)
  const state = assertItemState(input.state)
  const updatedAt = input.updatedAt === undefined ? now() : assertTimestamp(input.updatedAt, 'updatedAt')
  // upsert + 回读放同一事务：返回值必须是本次写入后的快照，而不是并发写的中间态。
  return withTransaction(store.db, () => {
    sql.upsert.run(itemId, accountId, title, priceCents, state, updatedAt)
    return toItemSummary(sql.selectById.get(itemId))
  })
}

function getItem(sql: ItemStatements, itemId: string): ItemSummary | undefined {
  const id = assertItemId(itemId)
  const raw = runSql(() => sql.selectById.get(id))
  return raw === undefined ? undefined : toItemSummary(raw)
}

function listItems(sql: ItemStatements, filter?: ItemFilter): ItemSummary[] {
  const accountId = filter?.accountId === undefined ? undefined : assertAccountId(filter.accountId)
  const state = filter?.state === undefined ? undefined : assertItemState(filter.state)
  const limit = filter?.limit === undefined ? DEFAULT_LIST_LIMIT : assertLimit(filter.limit)
  const statement = pickListStatement(sql, accountId !== undefined, state !== undefined)
  const params: (string | number)[] = []
  if (accountId !== undefined) params.push(accountId)
  if (state !== undefined) params.push(state)
  params.push(limit)
  return runSql(() => statement.all(...params)).map((row) => toItemSummary(row))
}

function countItems(sql: ItemStatements, accountId?: AccountId): number {
  const account = accountId === undefined ? undefined : assertAccountId(accountId)
  const raw = runSql(() => (account === undefined ? sql.countAll.get() : sql.countByAccount.get(account)))
  const row = asSqlRow(raw)
  return row === undefined ? 0 : readSqlNumber(row, 'total')
}

function pickListStatement(sql: ItemStatements, hasAccount: boolean, hasState: boolean): Statement {
  if (hasAccount && hasState) return sql.listByAccountState
  if (hasAccount) return sql.listByAccount
  if (hasState) return sql.listByState
  return sql.listAll
}

function toItemSummary(raw: unknown): ItemSummary {
  const row = asSqlRow(raw)
  if (row === undefined) fail('STORAGE', '商品记录不存在')
  return {
    itemId: readSqlText(row, 'item_id'),
    accountId: readSqlText(row, 'account_id'),
    title: readSqlText(row, 'title'),
    priceCents: readSqlNumber(row, 'price_cents'),
    state: requireItemState(readSqlText(row, 'state')),
    updatedAt: readSqlNumber(row, 'updated_at'),
  }
}

/** 把 node:sqlite 的运行时错误统一收敛成 STORAGE（例如连接已关闭）。 */
function runSql<T>(body: () => T): T {
  try {
    return body()
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

function requireItemState(value: string): ItemState {
  if (isItemState(value)) return value
  fail('STORAGE', `items.state 非法：${value}`)
}

function assertItemId(value: unknown): string {
  if (typeof value !== 'string') fail('VALIDATION', 'itemId 必须是字符串')
  if (value.trim().length === 0) fail('VALIDATION', 'itemId 不能为空')
  if (value.length > MAX_ITEM_ID_CHARS) fail('VALIDATION', `itemId 不能超过 ${MAX_ITEM_ID_CHARS} 个字符`)
  return value
}

function assertAccountId(value: unknown): AccountId {
  if (typeof value !== 'string') fail('VALIDATION', 'accountId 必须是字符串')
  if (!ACCOUNT_ID_PATTERN.test(value)) {
    fail('VALIDATION', 'accountId 只能由字母、数字、.、_、- 组成且长度 1..64')
  }
  return value
}

function assertTitle(value: unknown): string {
  if (typeof value !== 'string') fail('VALIDATION', 'title 必须是字符串')
  if (value.trim().length === 0) fail('VALIDATION', 'title 不能为空')
  if (value.length > MAX_TITLE_CHARS) fail('VALIDATION', `title 不能超过 ${MAX_TITLE_CHARS} 个字符`)
  return value
}

function assertPriceCents(value: unknown): number {
  // 金额用整数分；非安全整数会在 SQLite INTEGER 往返中丢精度，必须拒收。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('VALIDATION', 'priceCents 必须是非负安全整数（分）')
  }
  return value
}

function assertItemState(value: unknown): ItemState {
  if (isItemState(value)) return value
  fail('VALIDATION', `state 非法：${String(value)}`)
}

function assertLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    fail('VALIDATION', `limit 必须是 1..${MAX_LIST_LIMIT} 的整数`)
  }
  return value
}

function assertTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('VALIDATION', `${field} 必须是非负整数毫秒`)
  }
  return value
}
