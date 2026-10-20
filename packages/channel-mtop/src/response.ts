/**
 * mtop 响应解析：Set-Cookie 归一 + ret 分类。
 *
 * ret 分类复用 @bigfish/core 的 classifyMtopRet（关键词表在 core/risk.ts）。
 * 这里只补一个参考实现里明确、但 core 正则未覆盖的边角：
 * 'FAIL_SYS_API_SIGN_ERROR' 的前缀是下划线，命中不了 /\bsign\b/，补成 VALIDATION。
 * @module @bigfish/channel-mtop/response
 */
import { XianyuError, classifyMtopRet, fail } from '@bigfish/core'
import type { ErrorCode } from '@bigfish/core'

/**
 * Set-Cookie 数组 → cookie 表。
 * 只取第一个分号前的 name=value；Domain/Path/Expires/HttpOnly 等属性全丢。
 * 跨域同名时后者覆盖前者（xianyu_spider 的域重写坑：passport 域 cookie 要当 .goofish.com 用）。
 */
export function parseSetCookie(headers: readonly string[]): Record<string, string> {
  if (!Array.isArray(headers)) {
    return fail('VALIDATION', 'parseSetCookie 需要 Set-Cookie 字符串数组')
  }
  const cookies: Record<string, string> = {}
  for (const header of headers) {
    if (typeof header !== 'string' || header.length === 0) continue
    const first = header.split(';')[0] ?? ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    if (name.length === 0) continue
    cookies[name] = first.slice(eq + 1).trim()
  }
  return cookies
}

/** 把 ret 数组/字符串拼成一串；只用于错误消息与补充分类。 */
function retText(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return ''
  const ret = (raw as { ret?: unknown }).ret
  if (Array.isArray(ret)) {
    return ret.filter((item): item is string => typeof item === 'string').join(' | ')
  }
  return typeof ret === 'string' ? ret : ''
}

/** 错误消息里只带 120 字符预览，避免把整段响应（可能含 cookie）写进日志。 */
function preview(raw: unknown): string {
  if (typeof raw === 'string') return raw.slice(0, 120)
  return String(raw).slice(0, 120)
}

/** 响应是字符串时按 JSON 文本解析；解析失败属于传输层异常，可重试。 */
function parseJsonText(api: string, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    return fail('NETWORK', '[' + api + '] mtop 响应不是合法 JSON：' + preview(text), { cause: error })
  }
}

/**
 * ret 分类：成功返回 data（没有 data 字段则返回整个响应体），失败抛 XianyuError。
 * 未知 ret 保持 core 的 UNKNOWN，并把平台原文放进 message 便于排查。
 */
export function parseMtopResponse(api: string, raw: unknown): unknown {
  if (typeof api !== 'string' || api.length === 0) {
    fail('VALIDATION', 'parseMtopResponse 需要非空 api')
  }
  const body = typeof raw === 'string' ? parseJsonText(api, raw) : raw
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    fail('UNKNOWN', '[' + api + '] mtop 响应不是 JSON 对象：' + preview(body))
  }
  const result = classifyMtopRet(api, body)
  if (!result.ok) {
    const retStr = retText(body)
    const code: ErrorCode = result.code === 'UNKNOWN' && /SIGN|签名/i.test(retStr) ? 'VALIDATION' : result.code
    const message = code === result.code ? result.message : '[' + api + '] 请求/签名非法：' + retStr
    throw new XianyuError({ code, message, details: { api } })
  }
  const record = body as Record<string, unknown>
  return Object.hasOwn(record, 'data') ? record.data : body
}
