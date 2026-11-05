/**
 * 测试专用 MessagePack 编码器：只为造数据，覆盖解码器要验的类型子集。
 * 本文件不是 *.test.ts，不会被 scripts/test-all.mjs 直接加载。
 */

function pushUint16(out: number[], value: number): void {
  out.push((value >>> 8) & 0xff, value & 0xff)
}

function pushUint32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function pushUint64(out: number[], value: number): void {
  const high = Math.floor(value / 0x1_0000_0000)
  const low = value - high * 0x1_0000_0000
  pushUint32(out, high)
  pushUint32(out, low)
}

function encodeNumber(out: number[], value: number): void {
  if (!Number.isInteger(value)) {
    out.push(0xcb)
    const buffer = Buffer.alloc(8)
    buffer.writeDoubleBE(value, 0)
    out.push(...buffer)
    return
  }
  if (value >= 0) {
    if (value < 0x80) out.push(value)
    else if (value <= 0xff) out.push(0xcc, value)
    else if (value <= 0xffff) {
      out.push(0xcd)
      pushUint16(out, value)
    } else if (value <= 0xffff_ffff) {
      out.push(0xce)
      pushUint32(out, value)
    } else {
      out.push(0xcf)
      pushUint64(out, value)
    }
    return
  }
  if (value >= -32) out.push(0x100 + value)
  else if (value >= -0x80) out.push(0xd0, 0x100 + value)
  else if (value >= -0x8000) {
    out.push(0xd1)
    pushUint16(out, value & 0xffff)
  } else if (value >= -0x8000_0000) {
    out.push(0xd2)
    pushUint32(out, value >>> 0)
  } else {
    out.push(0xd3)
    pushUint64(out, value)
  }
}

function encodeString(out: number[], value: string): void {
  const bytes = [...Buffer.from(value, 'utf8')]
  const length = bytes.length
  if (length < 0x20) out.push(0xa0 | length)
  else if (length <= 0xff) out.push(0xd9, length)
  else if (length <= 0xffff) {
    out.push(0xda)
    pushUint16(out, length)
  } else {
    out.push(0xdb)
    pushUint32(out, length)
  }
  out.push(...bytes)
}

function encodeValue(out: number[], value: unknown): void {
  if (value === undefined || value === null) {
    out.push(0xc0)
    return
  }
  if (value === true) {
    out.push(0xc3)
    return
  }
  if (value === false) {
    out.push(0xc2)
    return
  }
  if (typeof value === 'number') {
    encodeNumber(out, value)
    return
  }
  if (typeof value === 'string') {
    encodeString(out, value)
    return
  }
  if (value instanceof Uint8Array) {
    if (value.length <= 0xff) out.push(0xc4, value.length)
    else {
      out.push(0xc5)
      pushUint16(out, value.length)
    }
    out.push(...value)
    return
  }
  if (Array.isArray(value)) {
    if (value.length < 0x10) out.push(0x90 | value.length)
    else {
      out.push(0xdc)
      pushUint16(out, value.length)
    }
    for (const item of value) encodeValue(out, item)
    return
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length < 0x10) out.push(0x80 | entries.length)
    else {
      out.push(0xde)
      pushUint16(out, entries.length)
    }
    for (const [key, item] of entries) {
      encodeString(out, key)
      encodeValue(out, item)
    }
    return
  }
  throw new Error('测试编码器不支持的类型：' + typeof value)
}

/** 任意 JSON 形态的值 → MessagePack 字节。 */
export function encodeMsgpack(value: unknown): Uint8Array {
  const out: number[] = []
  encodeValue(out, value)
  return Uint8Array.from(out)
}

/** 多段值拼接（验证流式解码）。 */
export function encodeMsgpackStream(values: unknown[]): Uint8Array {
  const parts = values.map((value) => encodeMsgpack(value))
  const out: number[] = []
  for (const part of parts) out.push(...part)
  return Uint8Array.from(out)
}
