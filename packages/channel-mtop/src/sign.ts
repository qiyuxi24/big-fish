/**
 * mtop 签名：h5 token 提取 + md5 摘要。
 *
 * 签名算法移植自 fancyboi999/goofish-cli（Apache-2.0）的 JS sign 实现：
 *   sign = md5(token + '&' + t + '&' + APP_KEY + '&' + data)
 * 原实现走 execjs 桥接，这里用 node:crypto 直接算，避免引入 JS 运行时。
 * @module @bigfish/channel-mtop/sign
 */
import { createHash } from 'node:crypto'
import { fail } from '@bigfish/core'
import { APP_KEY } from './constants.ts'

/** _m_h5_tk cookie 名；值为 '<token>_<ts>'。 */
export const H5_TOKEN_COOKIE = '_m_h5_tk'

/**
 * 由 cookie 表取 _m_h5_tk 的 '_' 前段。
 * 缺失或前段为空说明登录态不可用，抛 AUTH_EXPIRED（重试无意义，先重新登录）。
 */
export function h5Token(cookies: Record<string, string>): string {
  const raw = cookies[H5_TOKEN_COOKIE] ?? ''
  if (raw.length === 0) {
    fail('AUTH_EXPIRED', '_m_h5_tk 缺失，无法签名：请重新登录闲鱼并更新凭据')
  }
  const token = raw.split('_')[0] ?? ''
  if (token.length === 0) {
    fail('AUTH_EXPIRED', '_m_h5_tk 格式非法（缺少 token 段）：请重新登录闲鱼并更新凭据')
  }
  return token
}

/**
 * md5(token + '&' + t + '&' + APP_KEY + '&' + data)，小写 hex。
 * t 必须是毫秒时间戳：秒级 t 会被平台判签名错误（参考实现的注释里专门强调过）。
 */
export function signMtop(token: string, t: number, data: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    fail('VALIDATION', 'signMtop: token 必须是非空字符串')
  }
  if (!Number.isSafeInteger(t) || t <= 0) {
    fail('VALIDATION', 'signMtop: t 必须是正整数毫秒时间戳，收到：' + String(t))
  }
  if (typeof data !== 'string') {
    fail('VALIDATION', 'signMtop: data 必须是字符串（对象由调用方先做紧凑序列化）')
  }
  return createHash('md5')
    .update(token + '&' + String(t) + '&' + APP_KEY + '&' + data, 'utf8')
    .digest('hex')
}
