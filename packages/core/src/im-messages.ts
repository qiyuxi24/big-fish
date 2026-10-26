/**
 * IM 聊天消息落地：买家/卖家会话的只增记录。
 *
 * 为什么单独一张表而不是塞进 events：聊天是「按会话读」的业务数据（回复要按 cid 找对方 id、
 * 面板按时间线展示），不是任务流水；且必须有 (account_id, message_id) 唯一键——
 * 重连后平台会补推一段历史，去重只能靠服务端 messageId，客户端 uuid 帮不上忙。
 * 存 raw 是为了排障（卡片/交易状态变更解析不出来时能回放），写日志前必须脱敏。
 * @module @bigfish/core/im-messages
 */
import { fail, toXianyuError } from './errors.ts'
import {
  asSqlRow,
  decodePayload,
  encodePayload,
  readSqlNumber,
  readSqlOptionalText,
  readSqlText,
} from './store.ts'
import type { Store } from './store.ts'

/** 消息形态：text = 标准聊天正文；card = 卡片（商品/订单卡片，正文多为标题）。 */
export type ImMessageKind = 'text' | 'card'

/** 交易状态：来自卡片消息的 redReminder，不靠正则匹配文案。 */
export type ImTradeStatus = 'awaiting_payment' | 'awaiting_shipment' | 'closed'

const MESSAGE_KINDS = new Set<string>(['text', 'card'])
const TRADE_STATUSES = new Set<string>(['awaiting_payment', 'awaiting_shipment', 'closed'])

/** 落库入参；raw 只在调试期需要，默认不存（省空间也不留买家隐私）。 */
export interface ImMessageInput {
  accountId: string
  /** 会话 id（已去 @goofish 后缀）。 */
  cid: string
  /** 服务端消息 id；跨重连稳定，是唯一的去重键。 */
  messageId: string
  /** 发送者 id（已去 @goofish 后缀）；自己发出的消息会被推送回来，此时等于 accountId。 */
  senderId: string
  kind: ImMessageKind
  text: string
  chatTimeMs: number
  tradeStatus?: ImTradeStatus
  /** 原始推送对象（普通对象）；给了才落库。 */
  raw?: Record<string, unknown>
}

/** 读出的消息；id 是本地自增游标，可按它做增量拉取。 */
export interface ImMessageRecord {
  id: number
  accountId: string
  cid: string
  messageId: string
  senderId: string
  kind: ImMessageKind
  text: string
  chatTimeMs: number
  receivedAt: number
  /** true = 自己发出的（平台上会推送回来），回复时不能拿它当对方 id。 */
  fromSelf: boolean
  tradeStatus?: ImTradeStatus
  raw?: Record<string, unknown>
}

/** 读侧条件：since 是排他游标（返回 id > since）。 */
export interface ImMessageQuery {
  accountId: string
  cid?: string
  since?: number
  limit?: number
}

/** 面板一次拉取的默认量；上限防止一次读空整张表。 */
export const DEFAULT_IM_MESSAGE_LIMIT = 100
export const MAX_IM_MESSAGE_LIMIT = 500

export interface ImMessageSink {
  /**
   * 落一条消息；同 (accountId, messageId) 已存在时返回 false。
   * 这是幂等边界：重连补推、daemon 重启后重放都不会产生重复行。
   */
  append(input: ImMessageInput): boolean
  list(query: ImMessageQuery): ImMessageRecord[]
  /**
   * 会话里最近一条**对方**消息的 senderId；回复消息的 actualReceivers 要用它。
   * 没有对方消息（比如自己先发的）返回 undefined。
   */
  lastPeer(input: { accountId: string; cid: string }): string | undefined
  /** 已经落库的条数（自检 / 状态接口用）。 */
  count(accountId: string): number
}

export interface ImMessageStoreOptions {
  /** 可注入时钟（整数毫秒），只用于 received_at。 */
  now?: () => number
}

/** 建读写口；表由 openStore 的 v6 迁移保证存在。 */
export function createImMessageRepository(store: Store, options: ImMessageStoreOptions = {}): ImMessageSink {
  if (typeof store !== 'object' || store === null) fail('VALIDATION', 'createImMessageRepository 需要 store')
  const clock = options.now ?? ((): number => Date.now())
  return {
    append(input: ImMessageInput): boolean {
      return appendMessage(store, clock, input)
    },
    list(query: ImMessageQuery): ImMessageRecord[] {
      return listMessages(store, query)
    },
    lastPeer(input: { accountId: string; cid: string }): string | undefined {
      return readLastPeer(store, input)
    },
    count(accountId: string): number {
      return countMessages(store, accountId)
    },
  }
}

function appendMessage(store: Store, now: () => number, input: ImMessageInput): boolean {
  const message = normalizeInput(input)
  try {
    const result: unknown = store.db
      .prepare(
        `INSERT OR IGNORE INTO im_messages
           (account_id, cid, message_id, sender_id, kind, text, chat_time_ms, trade_status, raw, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.accountId,
        message.cid,
        message.messageId,
        message.senderId,
        message.kind,
        message.text,
        message.chatTimeMs,
        message.tradeStatus ?? null,
        message.raw === undefined ? null : encodePayload(message.raw),
        now(),
      )
    const row = asSqlRow(result)
    const changes = row?.['changes']
    return typeof changes === 'number' ? changes > 0 : false
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

function listMessages(store: Store, query: ImMessageQuery): ImMessageRecord[] {
  if (typeof query !== 'object' || query === null) fail('VALIDATION', 'im message list 需要查询对象')
  const accountId = requireNonEmptyString(query.accountId, 'accountId')
  const cid = optionalNonEmptyString(query.cid, 'cid')
  const since = query.since === undefined ? 0 : requireNonNegativeInt(query.since, 'since')
  const limit = query.limit === undefined ? DEFAULT_IM_MESSAGE_LIMIT : requireLimit(query.limit)
  const where: string[] = ['account_id = ?', 'id > ?']
  const params: Array<string | number> = [accountId, since]
  if (cid !== undefined) {
    where.push('cid = ?')
    params.push(cid)
  }
  params.push(limit)
  try {
    const rows: unknown = store.db
      .prepare(
        `SELECT id, account_id, cid, message_id, sender_id, kind, text, chat_time_ms, trade_status, raw, received_at
         FROM im_messages WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`,
      )
      .all(...params)
    if (!Array.isArray(rows)) return []
    const records: ImMessageRecord[] = []
    for (const raw of rows) {
      const record = readMessageRow(raw)
      if (record !== undefined) records.push(record)
    }
    return records
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

/** 最近一条对方消息的 sender_id；按聊天时间倒序，时间相同用本地 id 兜底。 */
function readLastPeer(store: Store, input: { accountId: string; cid: string }): string | undefined {
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'lastPeer 需要参数对象')
  const accountId = requireNonEmptyString(input.accountId, 'accountId')
  const cid = requireNonEmptyString(input.cid, 'cid')
  try {
    const row: unknown = store.db
      .prepare(
        `SELECT sender_id FROM im_messages
         WHERE account_id = ? AND cid = ? AND sender_id <> ?
         ORDER BY chat_time_ms DESC, id DESC LIMIT 1`,
      )
      .get(accountId, cid, accountId)
    const record = asSqlRow(row)
    if (record === undefined) return undefined
    const senderId = readSqlOptionalText(record, 'sender_id')
    return senderId === undefined ? undefined : senderId
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

function countMessages(store: Store, accountId: string): number {
  const id = requireNonEmptyString(accountId, 'accountId')
  try {
    const row: unknown = store.db.prepare('SELECT COUNT(*) AS n FROM im_messages WHERE account_id = ?').get(id)
    const record = asSqlRow(row)
    return record === undefined ? 0 : readSqlNumber(record, 'n')
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

function readMessageRow(raw: unknown): ImMessageRecord | undefined {
  const row = asSqlRow(raw)
  if (row === undefined) return undefined
  const kind = readSqlText(row, 'kind')
  if (!MESSAGE_KINDS.has(kind)) return undefined
  const accountId = readSqlText(row, 'account_id')
  const senderId = readSqlText(row, 'sender_id')
  const tradeStatus = readSqlOptionalText(row, 'trade_status')
  const rawText = readSqlOptionalText(row, 'raw')
  let rawPayload: Record<string, unknown> | undefined
  if (rawText !== undefined) {
    try {
      rawPayload = decodePayload(rawText)
    } catch {
      // raw 是排障用的附加信息：坏了不该让整条消息读不出来。
      rawPayload = undefined
    }
  }
  return {
    id: readSqlNumber(row, 'id'),
    accountId,
    cid: readSqlText(row, 'cid'),
    messageId: readSqlText(row, 'message_id'),
    senderId,
    kind: kind as ImMessageKind,
    text: readSqlText(row, 'text'),
    chatTimeMs: readSqlNumber(row, 'chat_time_ms'),
    receivedAt: readSqlNumber(row, 'received_at'),
    fromSelf: senderId === accountId,
    ...(tradeStatus === undefined ? {} : { tradeStatus: tradeStatus as ImTradeStatus }),
    ...(rawPayload === undefined ? {} : { raw: rawPayload }),
  }
}

function normalizeInput(input: ImMessageInput): ImMessageInput {
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'im message 需要参数对象')
  const accountId = requireNonEmptyString(input.accountId, 'accountId')
  const cid = requireNonEmptyString(input.cid, 'cid')
  const messageId = requireNonEmptyString(input.messageId, 'messageId')
  const senderId = requireNonEmptyString(input.senderId, 'senderId')
  const kind = input.kind
  if (typeof kind !== 'string' || !MESSAGE_KINDS.has(kind)) {
    fail('VALIDATION', 'im message kind 非法：' + String(kind))
  }
  const text = input.text
  if (typeof text !== 'string') fail('VALIDATION', 'im message text 必须是字符串（可以是空串）')
  const tradeStatus = input.tradeStatus
  if (tradeStatus !== undefined && (typeof tradeStatus !== 'string' || !TRADE_STATUSES.has(tradeStatus))) {
    fail('VALIDATION', 'im message tradeStatus 非法：' + String(tradeStatus))
  }
  const chatTimeMs = input.chatTimeMs
  if (!Number.isSafeInteger(chatTimeMs) || chatTimeMs <= 0) {
    fail('VALIDATION', 'im message chatTimeMs 必须是正整数毫秒时间戳')
  }
  const raw = input.raw
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    fail('VALIDATION', 'im message raw 必须是普通对象')
  }
  return {
    accountId,
    cid,
    messageId,
    senderId,
    kind: kind as ImMessageKind,
    text,
    chatTimeMs,
    ...(tradeStatus === undefined ? {} : { tradeStatus: tradeStatus as ImTradeStatus }),
    ...(raw === undefined ? {} : { raw }),
  }
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_IM_MESSAGE_LIMIT) {
    fail('VALIDATION', 'im message limit 必须在 1..' + String(MAX_IM_MESSAGE_LIMIT) + ' 之间，实际为 ' + String(value))
  }
  return value
}

function requireNonNegativeInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('VALIDATION', 'im message ' + name + ' 必须是非负整数，实际为 ' + String(value))
  }
  return value
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('VALIDATION', 'im message ' + name + ' 必须是非空字符串')
  }
  return value
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requireNonEmptyString(value, name)
}
