/**
 * 极简 MessagePack 解码：只覆盖闲鱼 IM 同步推送包里实际出现的类型子集。
 *
 * 事实来源（2026-10-26 核实）：实时聊天推送 \`body.syncPushPackage.data[*].data\` 是
 * **base64(MessagePack)**；同包里少量系统提示是 base64(JSON)（含 chatType 字段）。
 * 参考实现 XianYuApis 的 \`decrypt()\` 与 goofish-client 的 \`decodeImData()\` 都走
 * 「base64 → MessagePack」，本模块替代它们，保持运行时零第三方依赖。
 *
 * 只做解码、不做编码：编码方向目前只有 JSON 文本帧，用不到 MessagePack。
 * 任何不认识的类型（ext/float16/二进制里夹生的字节）都让整条数据失败，
 * 由调用方跳过——宁可漏一条消息，也不要把半个对象当成消息落库。
 * @module @bigfish/channel-im/msgpack
 */

/** 嵌套深度上限：IM 消息最深 5 层，32 足够且能挡住恶意构造的深递归。 */
const MAX_DEPTH = 32

interface Cursor {
  bytes: Uint8Array
  view: DataView
  offset: number
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false })

function need(cursor: Cursor, length: number): number {
  const end = cursor.offset + length
  if (length < 0 || end > cursor.bytes.length) {
    throw new Error('msgpack 数据在偏移 ' + String(cursor.offset) + ' 处截断')
  }
  return cursor.offset
}

function readUint8(cursor: Cursor): number {
  const start = need(cursor, 1)
  cursor.offset = start + 1
  return cursor.bytes[start] as number
}

function readUint16(cursor: Cursor): number {
  const start = need(cursor, 2)
  cursor.offset = start + 2
  return cursor.view.getUint16(start, false)
}

function readUint32(cursor: Cursor): number {
  const start = need(cursor, 4)
  cursor.offset = start + 4
  return cursor.view.getUint32(start, false)
}

function readInt8(cursor: Cursor): number {
  const start = need(cursor, 1)
  cursor.offset = start + 1
  return cursor.view.getInt8(start)
}

function readInt16(cursor: Cursor): number {
  const start = need(cursor, 2)
  cursor.offset = start + 2
  return cursor.view.getInt16(start, false)
}

function readInt32(cursor: Cursor): number {
  const start = need(cursor, 4)
  cursor.offset = start + 4
  return cursor.view.getInt32(start, false)
}

/** 64 位整数：安全范围内返回 number（毫秒时间戳都在这个范围），否则返回 BigInt。 */
function toNumberOrBig(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value
}

function readString(cursor: Cursor, length: number): string {
  const start = need(cursor, length)
  cursor.offset = start + length
  return TEXT_DECODER.decode(cursor.bytes.subarray(start, start + length))
}

function readBinary(cursor: Cursor, length: number): Uint8Array {
  const start = need(cursor, length)
  cursor.offset = start + length
  return cursor.bytes.subarray(start, start + length)
}

function readArray(cursor: Cursor, length: number, depth: number): unknown[] {
  const items: unknown[] = []
  for (let index = 0; index < length; index += 1) items.push(readValue(cursor, depth + 1))
  return items
}

function readMap(cursor: Cursor, length: number, depth: number): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (let index = 0; index < length; index += 1) {
    const key = readValue(cursor, depth + 1)
    const value = readValue(cursor, depth + 1)
    if (typeof key === 'string') record[key] = value
    else if (typeof key === 'number' || typeof key === 'bigint') record[String(key)] = value
    // 其它键型（数组/map 当键）不在 IM 协议里出现，忽略即可，不影响其它字段。
  }
  return record
}

/** 解一个值；类型不认识就抛错，由流式入口统一收口。 */
function readValue(cursor: Cursor, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('msgpack 嵌套超过 ' + String(MAX_DEPTH) + ' 层')
  const head = readUint8(cursor)
  if (head <= 0x7f) return head
  if (head >= 0xe0) return head - 0x100
  if (head >= 0x80 && head <= 0x8f) return readMap(cursor, head - 0x80, depth)
  if (head >= 0x90 && head <= 0x9f) return readArray(cursor, head - 0x90, depth)
  if (head >= 0xa0 && head <= 0xbf) return readString(cursor, head - 0xa0)
  switch (head) {
    case 0xc0:
      return undefined
    case 0xc2:
      return false
    case 0xc3:
      return true
    case 0xc4:
      return readBinary(cursor, readUint8(cursor))
    case 0xc5:
      return readBinary(cursor, readUint16(cursor))
    case 0xc6:
      return readBinary(cursor, readUint32(cursor))
    case 0xca: {
      const start = need(cursor, 4)
      cursor.offset = start + 4
      return cursor.view.getFloat32(start, false)
    }
    case 0xcb: {
      const start = need(cursor, 8)
      cursor.offset = start + 8
      return cursor.view.getFloat64(start, false)
    }
    case 0xcc:
      return readUint8(cursor)
    case 0xcd:
      return readUint16(cursor)
    case 0xce:
      return readUint32(cursor)
    case 0xcf: {
      const start = need(cursor, 8)
      cursor.offset = start + 8
      return toNumberOrBig(cursor.view.getBigUint64(start, false))
    }
    case 0xd0:
      return readInt8(cursor)
    case 0xd1:
      return readInt16(cursor)
    case 0xd2:
      return readInt32(cursor)
    case 0xd3: {
      const start = need(cursor, 8)
      cursor.offset = start + 8
      return toNumberOrBig(cursor.view.getBigInt64(start, false))
    }
    case 0xd9:
      return readString(cursor, readUint8(cursor))
    case 0xda:
      return readString(cursor, readUint16(cursor))
    case 0xdb:
      return readString(cursor, readUint32(cursor))
    case 0xdc:
      return readArray(cursor, readUint16(cursor), depth)
    case 0xdd:
      return readArray(cursor, readUint32(cursor), depth)
    case 0xde:
      return readMap(cursor, readUint16(cursor), depth)
    case 0xdf:
      return readMap(cursor, readUint32(cursor), depth)
    default:
      // ext 家族（0xc7-0xc9、0xd4-0xd8）与保留字：IM 推送未使用，整条判失败。
      throw new Error('msgpack 不支持的类型标记 0x' + head.toString(16))
  }
}

/** 解出全部对象（一个 data 里可能接连塞多条）；空/坏数据返回 []，不抛。 */
export function decodeMsgpackStream(bytes: unknown): unknown[] {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return []
  const cursor: Cursor = { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 }
  const values: unknown[] = []
  try {
    while (cursor.offset < cursor.bytes.length) values.push(readValue(cursor, 0))
  } catch (error) {
    void error
    // 已成功解出的部分保留：一条坏数据不该连累同包里前面的好数据。
    return values
  }
  return values
}

/** 只接受「恰好一个对象」的场景；多个/零个都返回 undefined。 */
export function decodeMsgpack(bytes: unknown): unknown | undefined {
  const values = decodeMsgpackStream(bytes)
  return values.length === 1 ? values[0] : undefined
}
