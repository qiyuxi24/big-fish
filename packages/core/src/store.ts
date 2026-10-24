/**
 * SQLite 连接与迁移（node:sqlite 的 DatabaseSync）。
 *
 * 为什么不用 ORM：P0 只有三张表、且仓库硬约束是零第三方依赖；prepared statement
 * 已足够表达队列查询，迁移则必须是显式、可审计的版本数组（一版一事务）。
 * @module @bigfish/core/store
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { XianyuError, fail, toXianyuError } from './errors.ts'

/** 打开参数。 */
export interface StoreOptions {
  /** 数据库文件路径；':memory:' 表示内存库。父目录不存在时递归创建。 */
  path: string
  /** 注入时钟（整数毫秒），只用于迁移的 applied_at；缺省 Date.now。 */
  now?: () => number
}

/** 打开后的存储句柄。 */
export interface Store {
  /** 底层连接；只有 data 层与迁移断言应该直接用它。 */
  db: DatabaseSync
  /** 幂等关闭。 */
  close(): void
}

/** SQLite 锁等待上限（毫秒）：并发写先排队，而不是立刻抛 SQLITE_BUSY。 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000

/** v1：任务队列 + 商品摘要 + 事件流。CHECK 约束把状态机钉在库层面。 */
const V1_SQL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_until INTEGER,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state IN ('queued', 'leased', 'done', 'failed', 'needs_review')),
  CHECK (kind IN ('publish', 'deliver', 'polish', 'reply', 'probe'))
);
CREATE INDEX idx_tasks_claim ON tasks(state, available_at);
CREATE INDEX idx_tasks_lease ON tasks(lease_until);

CREATE TABLE items (
  item_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_items_account ON items(account_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
`

/** v2：任务批次归属。旧行 batch_id 为 NULL——历史任务不属于任何批次，不能事后补。 */
const V2_SQL = `
ALTER TABLE tasks ADD COLUMN batch_id TEXT;
CREATE INDEX idx_tasks_batch ON tasks(batch_id, created_at);
`

interface Migration {
  version: number
  apply(db: DatabaseSync): void
}

/**
 * v3：任务事件流（面板工作流树 / 异常唤醒的数据源）。append-only，只由 worker 与执行器写。
 * 独立成表而不是复用 v1 的 events：events 是「店铺级流水」（未定语义），任务事件需要
 * task_id/batch_id 索引才能按面板的轮询增量拉取。
 */
const V3_SQL = `
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  batch_id TEXT,
  kind TEXT NOT NULL,
  step TEXT,
  state TEXT,
  code TEXT,
  message TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_task_events_batch ON task_events(batch_id, id);
`

/**
 * v4：采集参考的商家商品快照（seller_items + sellers）。
 * 独立于 items：items 是「自己账号的商品摘要」（发布/擦亮读它），这里是**行情快照**，
 * 且刻意不存描述与图片地址（AGENTS §1.6 不搬运他人素材）。
 */
const V4_SQL = `
CREATE TABLE IF NOT EXISTS seller_items (
  item_id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  original_price_cents INTEGER,
  category_id TEXT,
  image_count INTEGER NOT NULL DEFAULT 0,
  browse_count INTEGER,
  want_count INTEGER,
  collect_count INTEGER,
  sold_count INTEGER,
  published_at INTEGER,
  collected_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seller_items_seller ON seller_items(seller_id, collected_at);

CREATE TABLE IF NOT EXISTS sellers (
  seller_id TEXT PRIMARY KEY,
  nick TEXT,
  city TEXT,
  item_count INTEGER,
  registered_year INTEGER,
  sold_count INTEGER,
  is_self INTEGER,
  collected_at INTEGER NOT NULL
);
`

/**
 * v5：采集入库的「可学习特征」两列（文案结构 / 主图构成）。
 * 只存数字与开关，不存原文与图片地址；ALTER 用探测包一层，手工补过列的库不会卡住启动。
 */
const V5_SQL = `
ALTER TABLE seller_items ADD COLUMN copy_features TEXT;
ALTER TABLE seller_items ADD COLUMN image_features TEXT;
`

const MIGRATIONS: readonly Migration[] = [
  { version: 1, apply: (db: DatabaseSync): void => db.exec(V1_SQL) },
  { version: 2, apply: applyBatchMigration },
  // v3 全用 IF NOT EXISTS：手工建过表的库再迁移不会失败（与 v2 的探测同样的理由）。
  { version: 3, apply: (db: DatabaseSync): void => db.exec(V3_SQL) },
  { version: 4, apply: (db: DatabaseSync): void => db.exec(V4_SQL) },
  { version: 5, apply: applySellerFeaturesMigration },
]

const CREATE_MIGRATIONS_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`

/** 打开（必要时创建）数据库，并补齐尚未应用的迁移。 */
export function openStore(options: StoreOptions): Store {
  if (typeof options !== 'object' || options === null) fail('VALIDATION', 'openStore 需要参数对象')
  const path = readStorePath(options.path)
  const clock = options.now ?? ((): number => Date.now())
  ensureParentDirectory(path)
  const db = connectDatabase(path)
  try {
    configure(db)
    migrate(db, clock)
  } catch (error) {
    closeOnFailure(db)
    throw toXianyuError(error, 'STORAGE')
  }
  return createHandle(db)
}

/** 单事务执行；不支持嵌套（同一连接同一时刻只允许一个事务）。 */
export function withTransaction<T>(db: DatabaseSync, body: () => T): T {
  beginImmediate(db)
  try {
    const result = body()
    commit(db)
    return result
  } catch (error) {
    rollback(db)
    throw toXianyuError(error, 'STORAGE')
  }
}

/** payload 统一以 JSON 文本落库；入参必须是普通对象（数组/基本类型一律拒绝）。 */
export function encodePayload(payload: unknown): string {
  if (!isPlainRecord(payload)) fail('VALIDATION', 'payload 必须是普通对象')
  let text: string | undefined
  try {
    text = JSON.stringify(payload)
  } catch (error) {
    throw new XianyuError({ code: 'VALIDATION', message: 'payload 无法 JSON 序列化', cause: error })
  }
  if (typeof text !== 'string') fail('VALIDATION', 'payload 无法 JSON 序列化')
  return text
}

/** payload 读回：必须是 JSON 对象，否则说明库被外部改坏（STORAGE）。 */
export function decodePayload(raw: unknown, taskId?: string): Record<string, unknown> {
  const label = taskId === undefined ? '任务' : `任务 ${taskId}`
  if (typeof raw !== 'string') {
    throw new XianyuError({ code: 'STORAGE', message: `${label} 的 payload 列不是文本` })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new XianyuError({ code: 'STORAGE', message: `${label} 的 payload 不是合法 JSON`, cause: error })
  }
  if (!isPlainRecord(parsed)) {
    throw new XianyuError({ code: 'STORAGE', message: `${label} 的 payload 不是对象` })
  }
  return parsed
}

/** SQLite 行：node:sqlite 返回无原型对象，键为列名。 */
export type SqlRow = Record<string, string | number | bigint | null | Uint8Array>

/** 收窄一行查询结果；undefined 表示没查到。 */
export function asSqlRow(raw: unknown): SqlRow | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') fail('STORAGE', 'SQLite 查询结果不是行对象')
  return raw as SqlRow
}

export function readSqlNumber(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number') fail('STORAGE', `列 ${key} 不是数字`)
  return value
}

export function readSqlText(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') fail('STORAGE', `列 ${key} 不是文本`)
  return value
}

export function readSqlOptionalText(row: SqlRow, key: string): string | undefined {
  const value = row[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail('STORAGE', `列 ${key} 不是文本`)
  return value
}

export function readSqlOptionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number') fail('STORAGE', `列 ${key} 不是数字`)
  return value
}

function createHandle(db: DatabaseSync): Store {
  let closed = false
  return {
    db,
    close(): void {
      if (closed) return
      closed = true
      try {
        db.close()
      } catch (error) {
        throw new XianyuError({ code: 'STORAGE', message: '关闭数据库失败', cause: error })
      }
    },
  }
}

function readStorePath(value: unknown): string {
  if (typeof value !== 'string') fail('VALIDATION', 'openStore({ path }) 的 path 必须是字符串')
  const path = value.trim()
  if (path.length === 0) fail('VALIDATION', 'openStore({ path }) 的 path 不能为空')
  return path
}

function ensureParentDirectory(path: string): void {
  if (path.startsWith(':')) return // ':memory:' 等 URI 形式没有父目录
  const dir = dirname(resolve(path))
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw new XianyuError({ code: 'STORAGE', message: `无法创建数据库目录：${dir}`, cause: error, details: { dir } })
  }
}

function connectDatabase(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path)
  } catch (error) {
    throw new XianyuError({ code: 'STORAGE', message: `无法打开数据库：${path}`, cause: error, details: { path } })
  }
}

function configure(db: DatabaseSync): void {
  // WAL：让 daemon 的状态查询（读）不阻塞队列写入（写）。
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`)
}

function migrate(db: DatabaseSync, now: () => number): void {
  db.exec(CREATE_MIGRATIONS_SQL)
  const applied = new Set<number>(readAppliedVersions(db))
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    withTransaction(db, () => {
      migration.apply(db)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, now())
    })
  }
}

/**
 * 迁移 2 单独写成函数，是为了能重入：ALTER TABLE ADD COLUMN 不是幂等的（列已存在会报
 * duplicate column name），而版本表只保证「正常路径」不重跑。手工补过列却没记版本的库
 * 一旦被迁移卡住，daemon 就再也起不来，所以这里先探测再 ALTER。
 */
function applyBatchMigration(db: DatabaseSync): void {
  if (hasColumn(db, 'tasks', 'batch_id')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id, created_at)')
    return
  }
  db.exec(V2_SQL)
}

/** v5 与 v2 同样的理由：ALTER TABLE ADD COLUMN 不幂等，先探测列再补。 */
function applySellerFeaturesMigration(db: DatabaseSync): void {
  if (hasColumn(db, 'seller_items', 'copy_features')) return
  db.exec(V5_SQL)
}

/** 表名/列名只来自本文件内的常量，不接收外部输入。 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows: unknown = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!Array.isArray(rows)) return false
  for (const row of rows) {
    if (asSqlRow(row)?.name === column) return true
  }
  return false
}

function readAppliedVersions(db: DatabaseSync): number[] {
  const rows: unknown = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
  if (!Array.isArray(rows)) return []
  const versions: number[] = []
  for (const row of rows) {
    const version = asSqlRow(row)?.version
    if (typeof version === 'number') versions.push(version)
  }
  return versions
}

function beginImmediate(db: DatabaseSync): void {
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

function commit(db: DatabaseSync): void {
  try {
    db.exec('COMMIT')
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    // 事务可能已被 SQLite 自动回滚（例如语句级致命错误）；不能覆盖调用方的原始错误。
  }
}

function closeOnFailure(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // 打开/迁移失败后的清理路径：连接可能已不可用，保留原始错误优先。
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
