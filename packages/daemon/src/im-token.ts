/**
 * IM 取 token：mtop.taobao.idlemessage.pc.login.token。
 *
 * 复用 callMtop 的签名/令牌过期刷新/错误映射，但产物是 IM accessToken——它只用于 ws /reg 一次，
 * 换 token 必须重连重注册（docs/im-protocol.md §0、§1.2）。
 * 成功只看 data.accessToken；data.url 是风控惩罚页（§5.2），必须按 RISK_CONTROL 上抛等人工：
 * 把它当网络错误重试只会让冷却期更长，也无法绕过（我们不做自动过滑块）。
 * @module @bigfish/daemon/im-token
 */

import { createHash } from 'node:crypto'

import { buildImTokenRequest, generateDeviceId } from '@bigfish/channel-im'
import { callMtop } from '@bigfish/channel-mtop'
import type { MtopTransport } from '@bigfish/channel-mtop'
import { XianyuError, fail } from '@bigfish/core'

/** 取 token 需要的登录态；字段与执行器 Session 同形，便于直接传。 */
export interface ImTokenSession {
  accountId: string
  cookies: Record<string, string>
  /** 凭据里的设备 id；缺省时按账号派生（见 stableImDeviceId）。 */
  deviceId?: string
  /** 令牌过期刷新后的 cookie 回写钩子；不给就不刷新（与 mtop 通道语义一致）。 */
  onSessionUpdate?: (cookies: Record<string, string>) => void | Promise<void>
}

export interface ImTokenOptions {
  transport: MtopTransport
  /** 参与签名的时间戳；默认 Date.now()。 */
  now?: () => number
  signal?: AbortSignal
}

export interface ImTokenResult {
  accessToken: string
  /** 本次真正使用的设备 id；调用方应把它持久化进凭据 meta，下次就不用再派生。 */
  deviceId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 32 位 hex → 36 位 UUID 形态（只求形态一致；固定假版本位，便于肉眼区分派生值与真随机值）。 */
function formatUuid(hex: string): string {
  const chars = hex.slice(0, 32)
  return (
    chars.slice(0, 8) +
    '-' +
    chars.slice(8, 12) +
    '-4' +
    chars.slice(13, 16) +
    '-8' +
    chars.slice(17, 20) +
    '-' +
    chars.slice(20, 32)
  )
}

/**
 * 设备 id：凭据里存过就原样用（它同时参与其他通道的设备指纹，不能被 IM 覆盖）；
 * 否则从账号 id 派生一个稳定值——同一账号跨进程/重启得到同一个 id，这是风控的硬要求。
 */
export function stableImDeviceId(accountId: string, stored?: string): string {
  if (typeof accountId !== 'string' || accountId.trim() === '') fail('VALIDATION', 'IM 设备 id 需要非空 accountId')
  if (stored !== undefined && stored.trim() !== '') return stored
  const hex = createHash('sha256').update('bigfish-im:' + accountId).digest('hex')
  return generateDeviceId(accountId, formatUuid(hex))
}

/**
 * 解析取 token 的响应体（callMtop 已剥掉外层 data）。
 * 三种结局：accessToken 成功、punish url 风控、两者都没有 → 登录态失效。
 */
export function parseImToken(raw: unknown): string {
  if (!isRecord(raw)) fail('NETWORK', '[im] 取 token 响应不是对象，无法判定登录态')
  const url = raw['url']
  if (typeof url === 'string' && url.trim() !== '') {
    throw new XianyuError({
      code: 'RISK_CONTROL',
      message: '[im] 取 IM token 被风控拦截：需要人工完成验证后重新导入登录态（不做自动过验证码）',
      details: { punishUrl: url },
      retryable: false,
    })
  }
  const token = raw['accessToken']
  if (typeof token !== 'string' || token.trim() === '') {
    fail('AUTH_EXPIRED', '[im] 取 token 成功但响应里没有 accessToken：登录态可能已失效，请重新扫码/导入')
  }
  return token
}

/**
 * 从 cookie 的 _m_h5_tk 里取 smToken。
 * 形态是 `<token>_<expireMs>`，签名只用前半段；取不到就不带该参数（页面自己也是这个行为）。
 */
function readSmToken(cookies: Record<string, string>): string | undefined {
  const raw = cookies['_m_h5_tk']
  if (typeof raw !== 'string') return undefined
  const token = raw.split('_')[0]?.trim() ?? ''
  return token === '' ? undefined : token
}

/** 取 IM accessToken；网络/签名/风控错误原样上抛，不在这一层重试（重连由 im-client 管）。 */
export async function fetchImAccessToken(
  session: ImTokenSession,
  options: ImTokenOptions,
): Promise<ImTokenResult> {
  const deviceId = stableImDeviceId(session.accountId, session.deviceId)
  // smToken 与 sessionOption 一起决定这个接口是不是被当正常页面请求：少了就是 RGV587 风控。
  const smToken = readSmToken(session.cookies)
  const request = buildImTokenRequest({ deviceId, ...(smToken === undefined ? {} : { smToken }) })
  const raw = await callMtop(options.transport, {
    api: request.api,
    version: request.version,
    data: request.data,
    extraParams: request.extraParams,
    session: {
      cookies: session.cookies,
      ...(session.deviceId === undefined ? {} : { deviceId: session.deviceId }),
    },
    ...(session.onSessionUpdate === undefined ? {} : { onSessionUpdate: session.onSessionUpdate }),
    ...(options.now === undefined ? {} : { t: options.now() }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return { accessToken: parseImToken(raw), deviceId }
}
