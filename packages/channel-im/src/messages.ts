/**
 * 下行推送包解析：syncPushPackage → 归一化消息信封（docs/im-protocol.md §3.3/§3.4）。
 *
 * 解码顺序（2026-10-26 真机核实）：先按 base64(JSON) 试；失败或首字节不是 '{'/'['
 * 时按 base64(MessagePack) 解（实时聊天推送就是这个形态，见 ./msgpack.ts）。
 * 解出对象含 chatType 视为系统提示，直接丢弃。
 * @module @bigfish/channel-im/messages
 */
import { decodeBase64Json, isRecord, readInteger, readPath, readText } from './frames.ts'
import { decodeMsgpackStream } from './msgpack.ts'

/** 消息形态：P2-A 只落标准聊天与卡片；卡片更新（msg["1"] 是字符串）留待 reply 阶段核实。 */
export type ImMessageKind = 'text' | 'card'

/** 交易状态，来自 main["10"]["redReminder"]（旧形态在 message["3"]["redReminder"]）；不要正则匹配文案。 */
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

/** custom 内层类型：1 = 纯文本；其它（26 = dxCard 卡片等）当卡片。 */
const CUSTOM_TEXT_TYPE = 1

function stripGoofish(value: string): string {
  return value.endsWith(GOOFISH_SUFFIX) ? value.slice(0, -GOOFISH_SUFFIX.length) : value
}

/**
 * 单个 data → 解码后的对象数组（一个包里可能接连塞多条 MessagePack 对象）。
 * 先试 base64(JSON)（系统提示与旧格式走这条）；解不出再按 MessagePack 流解。
 */
function decodePushPayload(raw: unknown): unknown[] {
  const encoded = readText(raw)
  if (encoded === undefined) return []
  let bytes: Buffer
  try {
    bytes = Buffer.from(encoded, 'base64')
  } catch (error) {
    // Buffer 对非法 base64 通常静默忽略，走到这里说明输入形态异常。
    void error
    return []
  }
  if (bytes.length === 0) return []
  const head = bytes[0]
  if (head === 0x7b || head === 0x5b) {
    // 明文 JSON：整包就是一个文档，交给既有的 JSON 解码，失败也不回退（明文不是 msgpack）。
    const parsed = decodeBase64Json(encoded)
    return parsed === undefined ? [] : [parsed]
  }
  return decodeMsgpackStream(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/**
 * 推送包 → 解码后的消息对象数组。
 * data 是 base64(JSON) 或 base64(MessagePack)；含 chatType 的系统提示丢弃；非法数据跳过不抛。
 */
export function decodePushItems(frame: unknown): unknown[] {
  const items = readPath(frame, ['body', 'syncPushPackage', 'data'])
  if (!Array.isArray(items)) return []
  const decoded: unknown[] = []
  for (const item of items) {
    for (const value of decodePushPayload(readPath(item, ['data']))) {
      if (isRecord(value) && Object.hasOwn(value, 'chatType')) continue
      decoded.push(value)
    }
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
 * 正文段的文本：明文 JSON 串（形如 {"text":{"text":"..."}}）→ 取嵌套文本；
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

/**
 * 正文段类型：内层 ["4"] == 1 是文本，其它正数是卡片（26=dxCard）；
 * 老格式没有内层标记时，有 ["5"] 正文按文本、只有 ["2"] 摘要按卡片。
 */
function readContentKind(card: Record<string, unknown>): ImMessageKind {
  const innerType = readInteger(card['4'])
  if (innerType === CUSTOM_TEXT_TYPE) return 'text'
  if (innerType !== undefined) return 'card'
  return readText(card['5']) === undefined ? 'card' : 'text'
}

function readTradeStatus(main: Record<string, unknown>, raw: Record<string, unknown>): ImTradeStatus | undefined {
  const reminder =
    readText(readPath(main, ['10', 'redReminder'])) ?? readText(readPath(raw, ['3', 'redReminder']))
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
 * 形态判定以正文段内层类型为准（真机卡片消息的 reminderContent 也在，不能拿它区分文本/卡片）：
 *   文本 → 正文取 ["6"]["3"]["5"]，退回 ["6"]["3"]["2"]、main["10"].reminderContent；
 *   卡片 → 正文取 ["6"]["3"]["2"] 摘要，退回 reminderContent、再退 ["6"]["3"]["5"]。
 */
export function parseImMessage(raw: unknown): ImChatMessage | undefined {
  if (!isRecord(raw)) return undefined
  const main = readPath(raw, ['1'])
  if (!isRecord(main)) return undefined
  const envelope = readEnvelope(main)
  if (envelope === undefined) return undefined
  const tradeStatus = readTradeStatus(main, raw)
  // 标准聊天：main["10"]["senderUserId"]；卡片消息：main["1"]["1"]（都相对 main 计算）。
  const sender =
    readText(readPath(main, ['10', 'senderUserId'])) ?? readText(readPath(main, ['1', '1'])) ?? ''
  const reminder = readText(readPath(main, ['10', 'reminderContent']))
  const card = readPath(main, ['6', '3'])
  if (isRecord(card)) {
    const kind = readContentKind(card)
    const summary = readText(card['2'])
    const body = extractText(card['5'])
    const text =
      kind === 'text'
        ? body || summary || reminder || ''
        : summary ?? (reminder ?? (body === '' ? '' : body))
    return buildMessage(kind, envelope, stripGoofish(sender), text, tradeStatus, raw)
  }
  // 没有正文段：交易/系统卡片常见形态，正文退到 reminderContent。
  if (reminder === undefined) return undefined
  return buildMessage('card', envelope, stripGoofish(sender), reminder, tradeStatus, raw)
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
