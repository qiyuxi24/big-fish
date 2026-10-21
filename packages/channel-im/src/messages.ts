/**
 * 下行推送包解析：syncPushPackage → 归一化消息信封（docs/im-protocol.md §3.3/§3.4）。
 *
 * 解码顺序：base64(JSON) 优先；失败本阶段直接跳过（base64(MessagePack) 分支待补）。
 * 解出对象含 chatType 视为系统提示，直接丢弃。
 * @module @bigfish/channel-im/messages
 */
import { decodeBase64Json, isRecord, readInteger, readPath, readText } from './frames.ts'

/** 消息形态：P2-A 只落标准聊天与卡片；卡片更新（msg["1"] 是字符串）留待 reply 阶段核实。 */
export type ImMessageKind = 'text' | 'card'

/** 交易状态，来自 message["3"]["redReminder"]；不要正则匹配文案。 */
export type ImTradeStatus = 'awaiting_payment' | 'awaiting_shipment' | 'closed'

/** 归一化后的聊天消息；raw 用于落库/排障，写日志前必须脱敏。 */
export interface ImChatMessage {
  kind: ImMessageKind
  /** 会话 id（已去掉 @goofish 后缀）。 */
  cid: string
  messageId: string
  /** 发送者 id（已去掉 @goofish 后缀）；自己发出的消息也会被推送回来。 */
  senderId: string
  text: string
  /** 服务端毫秒时间戳（epoch ms）。 */
  chatTimeMs: number
  tradeStatus?: ImTradeStatus
  raw: unknown
}

/** redReminder 枚举 → 内部状态；未登记文案保持 undefined（不要猜）。 */
const TRADE_STATUS: Record<string, ImTradeStatus> = {
  等待买家付款: 'awaiting_payment',
  交易成功: 'awaiting_shipment',
  交易关闭: 'closed',
}

const GOOFISH_SUFFIX = '@goofish'

function stripGoofish(value: string): string {
  return value.endsWith(GOOFISH_SUFFIX) ? value.slice(0, -GOOFISH_SUFFIX.length) : value
}

/**
 * 推送包 → 解码后的消息对象数组。
 * data 是 base64(JSON)；解出对象含 chatType 视为系统提示丢弃；非法数据跳过不抛。
 */
export function decodePushItems(frame: unknown): unknown[] {
  const items = readPath(frame, ['body', 'syncPushPackage', 'data'])
  if (!Array.isArray(items)) return []
  const decoded: unknown[] = []
  for (const item of items) {
    const value = decodeBase64Json(readPath(item, ['data']))
    if (value === undefined) continue
    if (isRecord(value) && Object.hasOwn(value, 'chatType')) continue
    decoded.push(value)
  }
  return decoded
}

interface Envelope {
  cid: string
  messageId: string
  chatTimeMs: number
}

/** 公共信封：["2"]=cid（去 @）、["3"]=messageId、["5"]=毫秒时间戳；缺一不可，缺了就当未知帧。 */
function readEnvelope(main: Record<string, unknown>): Envelope | undefined {
  const cid = readText(readPath(main, ['2']))
  const messageId = readText(readPath(main, ['3']))
  const chatTimeMs = readInteger(readPath(main, ['5']))
  if (cid === undefined || messageId === undefined || chatTimeMs === undefined) return undefined
  return { cid: stripGoofish(cid), messageId, chatTimeMs }
}

/**
 * 标准聊天正文：明文 JSON 串（形如 {"text":{"text":"..."}}）；
 * 旧格式是 base64(JSON)；两者都不成立时按纯文本使用。
 */
function extractText(raw: unknown): string {
  const value = readText(raw)
  if (value === undefined) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    // 不是 JSON 明文，再试旧格式 base64(JSON)。
    void error
    parsed = decodeBase64Json(value)
  }
  if (isRecord(parsed)) {
    const nested =
      readText(readPath(parsed, ['text', 'text'])) ??
      readText(readPath(parsed, ['text'])) ??
      readText(readPath(parsed, ['content', 'text']))
    if (nested !== undefined) return nested
  }
  return value
}

function readTradeStatus(channel: unknown): ImTradeStatus | undefined {
  const reminder = readText(readPath(channel, ['redReminder']))
  if (reminder === undefined || !Object.hasOwn(TRADE_STATUS, reminder)) return undefined
  return TRADE_STATUS[reminder]
}

function buildMessage(
  kind: ImMessageKind,
  envelope: Envelope,
  senderId: string,
  text: string,
  tradeStatus: ImTradeStatus | undefined,
  raw: unknown,
): ImChatMessage {
  const message: ImChatMessage = {
    kind,
    cid: envelope.cid,
    messageId: envelope.messageId,
    senderId,
    text,
    chatTimeMs: envelope.chatTimeMs,
    raw,
  }
  if (tradeStatus !== undefined) message.tradeStatus = tradeStatus
  return message
}

/**
 * 解析单条消息；无法识别（缺信封、未知形态）返回 undefined，不抛。
 * 判定顺序照抄参考实现：先标准聊天（reminderContent 非空），再卡片消息。
 */
export function parseImMessage(raw: unknown): ImChatMessage | undefined {
  if (!isRecord(raw)) return undefined
  const main = readPath(raw, ['1'])
  if (!isRecord(main)) return undefined
  const envelope = readEnvelope(main)
  if (envelope === undefined) return undefined
  const tradeStatus = readTradeStatus(readPath(raw, ['3']))
  // 标准聊天：msg["1"]["10"]["senderUserId"]；卡片消息：msg["1"]["1"]["1"]
  // （都相对 main = msg["1"] 计算，见 docs/im-protocol.md §3.3 路径表）。
  const sender =
    readText(readPath(main, ['10', 'senderUserId'])) ??
    readText(readPath(main, ['1', '1'])) ??
    ''
  const standard = readPath(main, ['10'])
  if (isRecord(standard) && readText(standard.reminderContent) !== undefined) {
    const text = extractText(readPath(main, ['6', '3', '5']))
    return buildMessage('text', envelope, stripGoofish(sender), text, tradeStatus, raw)
  }
  const card = readPath(main, ['6', '3'])
  if (isRecord(card)) {
    const text = readText(card['2']) ?? ''
    return buildMessage('card', envelope, stripGoofish(sender), text, tradeStatus, raw)
  }
  return undefined
}

/** 推送包 → 归一化消息列表；非业务帧/无消息返回空数组。 */
export function parsePushMessages(frame: unknown): ImChatMessage[] {
  const messages: ImChatMessage[] = []
  for (const item of decodePushItems(frame)) {
    const message = parseImMessage(item)
    if (message !== undefined) messages.push(message)
  }
  return messages
}
