/**
 * mtop 调用编排：构造 → 发送 → 解析；令牌过期时合并 Set-Cookie 新令牌后重签重试一次。
 *
 * 为什么允许这一次重试：_m_h5_tk 约两小时过期，平台对过期令牌返回 FAIL_SYS_TOKEN_EXOIRED，
 * 同时在 Set-Cookie 里下发新的 _m_h5_tk / _m_h5_tk_enc；合并后重新签名即成功（2026-10-21 实测）。
 * 这不破坏 fail-fast：只对「令牌过期」重试、最多一次，且这类请求是在签名校验阶段被拒的，
 * 没有产生业务副作用；风控 / 限流 / 网络 / 签名错误一律原样上抛，绝不重放。
 * 新 cookie 必须经 onSessionUpdate 交给调用方落盘；没给回调就不刷新——
 * 否则刷新结果被内部吞掉，下一次调用还拿旧令牌，问题只是被掩盖。
 * IO 一定带超时（DEFAULT_TIMEOUT_MS），调用方 signal 与之合并；两次尝试共用同一份超时预算。
 * @module @bigfish/channel-mtop/call
 */
import { XianyuError, fail, toXianyuError } from '@bigfish/core'
import { DEFAULT_TIMEOUT_MS } from './constants.ts'
import { buildMtopRequest } from './request.ts'
import { isTokenExpiredRet, mergeCookies, parseMtopResponse, parseSetCookie, readSetCookie } from './response.ts'
import { H5_TOKEN_COOKIE } from './sign.ts'
import type { MtopCallOptions, MtopHttpResponse, MtopTransport } from './types.ts'

/** 单次发送 + JSON 解析的结果；body 交给 parseMtopResponse 或令牌过期判定。 */
interface MtopExchange {
  response: MtopHttpResponse
  body: unknown
}

/** 超时信号与调用方 signal 合并；没有 signal 时只留超时。 */
function mergeSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name + ': ' + error.message
  return String(error)
}

/** HTTP 状态码 → 稳定错误码；只有 5xx/408 视为可重试网络错误。 */
function statusError(api: string, status: number): XianyuError {
  if (status === 401 || status === 403) {
    return new XianyuError({
      code: 'AUTH_EXPIRED',
      message: '[' + api + '] mtop HTTP ' + String(status) + '：登录态失效或被拒绝',
      details: { api, status },
    })
  }
  if (status === 429) {
    return new XianyuError({
      code: 'RATE_LIMITED',
      message: '[' + api + '] mtop HTTP 429：请求过于频繁',
      details: { api, status },
    })
  }
  return new XianyuError({
    code: 'NETWORK',
    message: '[' + api + '] mtop HTTP ' + String(status),
    details: { api, status },
    retryable: status >= 500 || status === 408,
  })
}

function parseJson(api: string, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    return fail('NETWORK', '[' + api + '] mtop 响应不是合法 JSON：' + text.slice(0, 120), { cause: error })
  }
}

/** 发送一次并校验响应形状：transport 异常、脏响应、非 2xx 统一收敛为 XianyuError。 */
async function sendOnce(transport: MtopTransport, api: string, request: ReturnType<typeof buildMtopRequest>): Promise<MtopHttpResponse> {
  let response: MtopHttpResponse
  try {
    response = await transport.request(request)
  } catch (error) {
    if (error instanceof XianyuError) throw error
    fail('NETWORK', '[' + api + '] mtop 请求失败：' + describeError(error), { cause: error })
  }
  if (response === null || typeof response !== 'object') {
    fail('NETWORK', '[' + api + '] mtop transport 返回了非对象响应')
  }
  const status = (response as { status?: unknown }).status
  if (typeof status !== 'number' || !Number.isInteger(status)) {
    fail('NETWORK', '[' + api + '] mtop transport 返回的 status 非法')
  }
  if (status < 200 || status >= 300) throw statusError(api, status)
  const text = (response as { text?: unknown }).text
  if (typeof text !== 'string') {
    fail('NETWORK', '[' + api + '] mtop transport 返回的 text 非法')
  }
  return response
}

/** 发一次 + 解析 JSON；解析失败按 NETWORK（可重试），与单次调用的语义一致。 */
async function exchange(transport: MtopTransport, api: string, request: ReturnType<typeof buildMtopRequest>): Promise<MtopExchange> {
  const response = await sendOnce(transport, api, request)
  return { response, body: parseJson(api, response.text) }
}

/**
 * 令牌过期响应 → 合并后的新 cookie 表；拿不到新 _m_h5_tk 或值没变时返回 undefined（不重试）。
 * 只有 _m_h5_tk 参与签名，所以它是判断「刷新能否救回来」的唯一依据；其余 Set-Cookie 字段一并合并。
 */
function refreshedCookies(
  response: MtopHttpResponse,
  cookies: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  const updates = parseSetCookie(readSetCookie(response))
  if (!Object.hasOwn(updates, H5_TOKEN_COOKIE)) return undefined
  const merged = mergeCookies(cookies, updates)
  if (Object.keys(merged.changed).length === 0) return undefined
  return merged.cookies
}

/** 刷新结果必须显式交给调用方：回调失败就是持久化失败，不能当成调用成功。 */
async function notifySessionUpdate(
  update: NonNullable<MtopCallOptions['onSessionUpdate']>,
  cookies: Record<string, string>,
): Promise<void> {
  try {
    await update(cookies)
  } catch (error) {
    throw toXianyuError(error, 'STORAGE')
  }
}

/** 构造 + 发送 + 解析；网络/HTTP 异常统一收敛为 XianyuError，绝不把裸 Error 抛给调用方。 */
export async function callMtop(transport: MtopTransport, opts: MtopCallOptions): Promise<unknown> {
  const receiver = transport as { request?: unknown } | null
  if (receiver === null || typeof receiver !== 'object' || typeof receiver.request !== 'function') {
    fail('VALIDATION', 'callMtop 需要实现 request() 的 MtopTransport')
  }
  const signal = mergeSignal(opts.signal)
  const first = await exchange(transport, opts.api, buildMtopRequest({ ...opts, signal }))
  if (!isTokenExpiredRet(first.body)) return parseMtopResponse(opts.api, first.body)
  // fail-fast：已取消 / 没回写钩子 / 平台没给新令牌时，都按登录态失效上报，不做无谓重试。
  const refreshed = signal.aborted ? undefined : refreshedCookies(first.response, opts.session.cookies)
  if (refreshed === undefined || opts.onSessionUpdate === undefined) {
    return parseMtopResponse(opts.api, first.body)
  }
  await notifySessionUpdate(opts.onSessionUpdate, refreshed)
  const retry = await exchange(
    transport,
    opts.api,
    buildMtopRequest({ ...opts, session: { ...opts.session, cookies: refreshed }, signal }),
  )
  // 刷新后仍然过期：新令牌也救不回来（账号被踢 / 令牌被作废），需要人工重新登录。
  if (isTokenExpiredRet(retry.body)) {
    fail('AUTH_EXPIRED', '[' + opts.api + '] 刷新令牌后仍提示过期：请重新登录闲鱼并重新导入凭据')
  }
  return parseMtopResponse(opts.api, retry.body)
}
