/**
 * mtop ret 字段分类。
 *
 * 关键词表移植自 fancyboi999/goofish-cli（Apache-2.0）的 core/mtop.py：
 *   _RISK_KEYWORDS = RGV587_ERROR / FAIL_SYS_USER_VALIDATE / 哎哟喂 / /punish
 *   _AUTH_KEYWORDS = FAIL_SYS_SESSION_EXPIRED / FAIL_SYS_TOKEN_EXOIRED / FAIL_SYS_TOKEN_EMPTY / 令牌过期 / FAIL_SYS_ILLEGAL_ACCESS
 * 本文件只做「字符串 → 错误类别」的判定，不发请求、不依赖传输层，方便单测与复用。
 *
 * @module @bigfish/core/risk
 */
import type { ErrorCode } from './errors.ts'

/** 风控触发关键词：命中即视为被平台风控拦截，应立刻停写并进入冷却。 */
export const RISK_KEYWORDS: readonly string[] = [
  'RGV587_ERROR',
  'FAIL_SYS_USER_VALIDATE',
  '哎哟喂',
  '/punish',
]

/** 登录态失效关键词：EXOIRED 是平台原文拼写，别改。 */
export const AUTH_KEYWORDS: readonly string[] = [
  'FAIL_SYS_SESSION_EXPIRED',
  'FAIL_SYS_TOKEN_EXOIRED',
  'FAIL_SYS_TOKEN_EMPTY',
  '令牌过期',
]

/** 账号级封禁/非法访问：既不是普通风控也不是可刷新登录态（刷 cookie 救不了）。 */
export const ILLEGAL_ACCESS_KEYWORDS: readonly string[] = ['FAIL_SYS_ILLEGAL_ACCESS']

/** ret 分类结果；成功时带原始 ret 文本，失败时带稳定 code 与可读消息。 */
export type RetClassification =
  | { ok: true; retStr: string }
  | { ok: false; code: ErrorCode; message: string }

/**
 * 把 mtop 响应的 ret（数组或字符串）拼成一串并分类。
 *
 * 成功判定：ret 为空、或含 SUCCESS（平台会同时返回 SUCCESS::调用成功 与 SUCCESS::redirect）。
 *
 * @param api 接口名，只用于错误消息里定位。
 * @param raw 完整响应体（读取其中的 ret 字段）。
 */
export function classifyMtopRet(api: string, raw: unknown): RetClassification {
  const retStr = joinRet(raw)
  if (retStr.length === 0 || retStr.includes('SUCCESS')) return { ok: true, retStr }

  if (containsAny(retStr, RISK_KEYWORDS)) {
    return { ok: false, code: 'RISK_CONTROL', message: '[' + api + '] 触发风控：' + retStr }
  }
  if (containsAny(retStr, AUTH_KEYWORDS)) {
    return { ok: false, code: 'AUTH_EXPIRED', message: '[' + api + '] 登录态失效：' + retStr }
  }
  if (containsAny(retStr, ILLEGAL_ACCESS_KEYWORDS)) {
    return { ok: false, code: 'AUTH_EXPIRED', message: '[' + api + '] 账号级非法访问（不可自动恢复）：' + retStr }
  }
  if (retStr.includes('ILLEGAL_REQUEST') || /SIGN|签名/i.test(retStr)) {
    return { ok: false, code: 'VALIDATION', message: '[' + api + '] 请求/签名非法：' + retStr }
  }
  if (retStr.includes('NOT_FOUND') || retStr.includes('不存在')) {
    return { ok: false, code: 'VALIDATION', message: '[' + api + '] 未找到：' + retStr }
  }
  return { ok: false, code: 'UNKNOWN', message: '[' + api + '] 调用失败：' + retStr }
}

function joinRet(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return ''
  const ret = (raw as { ret?: unknown }).ret
  if (Array.isArray(ret)) return ret.filter((item): item is string => typeof item === 'string').join(' | ')
  if (typeof ret === 'string') return ret
  return ''
}

function containsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword))
}