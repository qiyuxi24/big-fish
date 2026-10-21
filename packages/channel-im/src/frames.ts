/**
 * 闲鱼 IM（钉钉 lwp 长连接）帧构造与安全解析。
 *
 * 协议事实见 docs/im-protocol.md：取 IM token → /reg 注册 → 1s 后 ackDiff 提交同步游标 →
 * 15s 心跳 + 每条下行先 ACK 再处理。本模块只做纯函数（不发网络、不落库），
 * 传输与时钟由 session.ts 注入。
 * @module @bigfish/channel-im/frames
 */
import { randomUUID } from 'node:crypto'
import { fail } from '@bigfish/core'

/** IM 长连接默认地址（测试/灰度可换，但默认值照抄协议事实）。 */
export const IM_WS_URL = 'wss://wss-goofish.dingtalk.com'
/** IM 应用 key；与 HTTP mtop 的 appKey（34839810）不是同一个，混用是最常见 401 来源。 */
export const IM_APP_KEY = '444e9908a51d1cb236a27862abc769c9'
/** 取 IM accessToken 的 mtop 接口与版本。 */
export const IM_TOKEN_API = 'mtop.taobao.idlemessage.pc.login.token'
export const IM_TOKEN_API_VERSION = '1.0'
/** 应用层心跳间隔；发送超时由 ws 适配器执行，会话只把 send 抛错当断线。 */
export const HEARTBEAT_INTERVAL_MS = 15_000
export const HEARTBEAT_TIMEOUT_MS = 30_000
/** 注册成功后等待 1s 再提交同步游标（照抄参考实现，不要"优化"掉）。 */
export const ACK_DIFF_DELAY_MS = 1_000
/** /reg 的固定头；改 UA 会改客户端指纹，照抄。 */
export const IM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/133.0.0.0 Safari/537.36 DingTalk(2.1.5) OS(Windows/10) Browser(Chrome/133.0.0.0) ' +
  'DingWeb/2.1.5 IMPaaS DingWeb/2.1.5'
export const IM_CACHE_HEADER = 'app-key token ua wv'
export const IM_DT = 'j'
export const IM_WV = 'im:3,au:3,sy:6'
export const IM_SYNC_INITIAL = '0,0;0;0;'
export const REG_LWP = '/reg'
export const HEARTBEAT_LWP = '/!'
export const ACK_DIFF_LWP = '/r/SyncStatus/ackDiff'
/** ackDiff 的同步片段固定值。 */
export const ACK_DIFF_PIPELINE = 'sync'
export const ACK_DIFF_TOO_LONG_TAG = 'PNM,1'

/** 帧的宽松形状：ACK 帧没有 lwp，所以 lwp 可选。 */
export interface ImFrame {
  lwp?: string
  code?: number
  headers?: Record<string, string>
  body?: unknown
}

/** 取 IM token 所需的 mtop 请求要素；签名与 HTTP 发送由 channel-mtop 负责。 */
export interface ImTokenRequest {
  api: string
  version: string
  /** mtop 表单 data：紧凑 JSON（参考实现用 separators=(",",":")，有空格会签名不过）。 */
  data: string
  /** 合并进 mtop extraParams 的附加参数（签名参数仍由 channel-mtop 统一生成）。 */
  extraParams: Record<string, string>
}

/** 判断普通对象（数组、null 都不算）。对外输入一律 unknown，先窄化再断言。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取非空字符串；空串视为缺失（协议里空 token 等于没发）。 */
export function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 取整数（毫秒时间戳/金额分都用它）；浮点与超安全整数一律视为缺失。 */
export function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/** 按路径读嵌套字段，中途缺失返回 undefined。 */
export function readPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

function requireText(value: unknown, field: string): string {
  const text = readText(value)
  if (text === undefined) fail('VALIDATION', field + ' 必须是非空字符串')
  return text
}

function requireInteger(value: unknown, field: string): number {
  const integer = readInteger(value)
  if (integer === undefined) fail('VALIDATION', field + ' 必须是整数（毫秒时间戳）')
  return integer
}

/** 生成消息 id：参考实现是 `floor(1000*random) + Date.now() + " 0"`，末尾空格原样保留。 */
export function generateMid(nowMs: unknown, random: () => number = Math.random): string {
  const now = requireInteger(nowMs, 'generateMid nowMs')
  const roll = random()
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    fail('VALIDATION', 'generateMid random() 必须返回 [0,1) 区间的数')
  }
  return String(Math.floor(roll * 1000)) + String(now) + ' 0'
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 设备 id：36 位 UUID + "-" + 账号 id（参考实现 generate_device_id 的形态）。
 * 同一账号必须稳定并持久化——它参与设备指纹，随机生成会触发风控。
 */
export function generateDeviceId(userId: unknown, uuid: unknown = randomUUID()): string {
  const accountId = requireText(userId, 'generateDeviceId userId')
  if (typeof uuid !== 'string' || !UUID_PATTERN.test(uuid)) {
    fail('VALIDATION', 'generateDeviceId uuid 必须是 36 位 UUID 字符串')
  }
  return uuid + '-' + accountId
}

/** 构造取 IM token 的请求要素（不签名、不发请求）。smToken 缺失时不带该参数。 */
export function buildImTokenRequest(input: unknown): ImTokenRequest {
  if (!isRecord(input)) fail('VALIDATION', 'buildImTokenRequest 参数必须是对象')
  const deviceId = requireText(input.deviceId, 'buildImTokenRequest.deviceId')
  const extraParams: Record<string, string> = {
    accountSite: 'xianyu',
    queryToken: 'sm',
    sm: 'sm',
    spm_cnt: 'a21ybx.im.0.0',
  }
  if (input.smToken !== undefined) {
    extraParams.smToken = requireText(input.smToken, 'buildImTokenRequest.smToken')
  }
  return {
    api: IM_TOKEN_API,
    version: IM_TOKEN_API_VERSION,
    data: JSON.stringify({ appKey: IM_APP_KEY, deviceId }),
    extraParams,
  }
}

/** /reg 注册帧：token 只在这里用一次，换 token 必须重连重注册。 */
export function buildRegFrame(input: unknown): ImFrame {
  if (!isRecord(input)) fail('VALIDATION', 'buildRegFrame 参数必须是对象')
  const accessToken = requireText(input.accessToken, 'buildRegFrame.accessToken')
  const deviceId = requireText(input.deviceId, 'buildRegFrame.deviceId')
  const nowMs = input.nowMs === undefined ? Date.now() : requireInteger(input.nowMs, 'buildRegFrame.nowMs')
  const mid = input.mid === undefined ? generateMid(nowMs) : requireText(input.mid, 'buildRegFrame.mid')
  return {
    lwp: REG_LWP,
    headers: {
      'cache-header': IM_CACHE_HEADER,
      'app-key': IM_APP_KEY,
      token: accessToken,
      ua: IM_UA,
      dt: IM_DT,
      wv: IM_WV,
      sync: IM_SYNC_INITIAL,
      did: deviceId,
      mid,
    },
  }
}

/** 注册后第一帧：提交同步游标。pts 量纲照抄毫秒×1000，不要改成秒。 */
export function buildAckDiffFrame(input: unknown): ImFrame {
  if (!isRecord(input)) fail('VALIDATION', 'buildAckDiffFrame 参数必须是对象')
  const nowMs = requireInteger(input.nowMs, 'buildAckDiffFrame.nowMs')
  if (nowMs <= 0) fail('VALIDATION', 'buildAckDiffFrame.nowMs 必须是正的毫秒时间戳')
  if (!Number.isSafeInteger(nowMs * 1000)) fail('VALIDATION', 'buildAckDiffFrame.nowMs 过大，pts 超出安全整数')
  const mid = input.mid === undefined ? generateMid(nowMs) : requireText(input.mid, 'buildAckDiffFrame.mid')
  return {
    lwp: ACK_DIFF_LWP,
    headers: { mid },
    body: [
      {
        pipeline: ACK_DIFF_PIPELINE,
        channel: ACK_DIFF_PIPELINE,
        topic: ACK_DIFF_PIPELINE,
        tooLong2Tag: ACK_DIFF_TOO_LONG_TAG,
        highPts: 0,
        pts: nowMs * 1000,
        seq: 0,
        timestamp: Math.floor(nowMs / 1000),
      },
    ],
  }
}

/** 应用层心跳帧；间隔与发送超时见常量。 */
export function buildHeartbeatFrame(mid: unknown): ImFrame {
  return { lwp: HEARTBEAT_LWP, headers: { mid: requireText(mid, 'buildHeartbeatFrame.mid') } }
}

/**
 * 下行 ACK 帧。协议要求 ACK 与业务解耦（先 ACK 再处理），所以只依赖下行 headers。
 * 下行没有 headers.mid 时返回 undefined：该帧无需（也无法）回显 ACK。
 */
export function buildAckFrame(incoming: unknown): ImFrame | undefined {
  const headers = readPath(incoming, ['headers'])
  if (!isRecord(headers)) return undefined
  const mid = readText(headers.mid)
  if (mid === undefined) return undefined
  const ackHeaders: Record<string, string> = { mid }
  for (const name of ['sid', 'app-key', 'ua', 'dt'] as const) {
    const value = readText(headers[name])
    if (value !== undefined) ackHeaders[name] = value
  }
  return { code: 200, headers: ackHeaders }
}

/** 帧 → ws 文本帧。三仓都只发文本帧，服务端是否接受二进制帧未验证。 */
export function encodeFrame(frame: ImFrame): string {
  return JSON.stringify(frame)
}

/**
 * 宽松解析下行文本帧；非法 JSON / 非对象返回 undefined。
 * 契约是"未知帧不能让连接崩"，所以这里不抛错，由调用方决定上报方式。
 */
export function parseFrameText(text: unknown): ImFrame | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // 非 JSON 帧不是 lwp 协议的一部分，丢弃并继续等后续帧。
    void error
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  return narrowFrame(parsed)
}

function narrowFrame(record: Record<string, unknown>): ImFrame | undefined {
  const frame: ImFrame = {}
  if (record.lwp !== undefined) {
    if (typeof record.lwp !== 'string') return undefined
    frame.lwp = record.lwp
  }
  if (record.code !== undefined) {
    if (typeof record.code !== 'number') return undefined
    frame.code = record.code
  }
  if (record.headers !== undefined) {
    if (!isRecord(record.headers)) return undefined
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(record.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
    frame.headers = headers
  }
  if (Object.hasOwn(record, 'body')) frame.body = record.body
  return frame
}

/**
 * base64 → utf8 → JSON.parse。推送包 data 的明文分支（实时推送多数是明文）；
 * 任何一步失败返回 undefined，不抛。base64(MessagePack) 分支见任务遗留。
 */
export function decodeBase64Json(raw: unknown): unknown | undefined {
  const encoded = readText(raw)
  if (encoded === undefined) return undefined
  let decoded: string
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8')
  } catch (error) {
    // Buffer 对非法 base64 字符通常静默忽略，走到这里说明输入形态异常，按无法解码处理。
    void error
    return undefined
  }
  try {
    return JSON.parse(decoded)
  } catch (error) {
    // 非 JSON 明文：可能是 MessagePack 推送包，本阶段不支持，交给调用方跳过。
    void error
    return undefined
  }
}
