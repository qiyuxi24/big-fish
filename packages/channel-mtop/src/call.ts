/**
 * mtop 调用编排：构造 → 发送一次 → 解析。
 *
 * 不在通道层重试：重试/退避/熔断属于 daemon 的队列与风控层，这里只保证单次调用语义。
 * IO 一定带超时（DEFAULT_TIMEOUT_MS），调用方 signal 与之合并，任一触发即中断。
 * @module @bigfish/channel-mtop/call
 */
import { XianyuError, fail } from '@bigfish/core'
import { DEFAULT_TIMEOUT_MS } from './constants.ts'
import { buildMtopRequest } from './request.ts'
import { parseMtopResponse } from './response.ts'
import type { MtopCallOptions, MtopHttpResponse, MtopTransport } from './types.ts'

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

/** 构造 + 发送 + 解析；网络/HTTP 异常统一收敛为 XianyuError，绝不把裸 Error 抛给调用方。 */
export async function callMtop(transport: MtopTransport, opts: MtopCallOptions): Promise<unknown> {
  const receiver = transport as { request?: unknown } | null
  if (receiver === null || typeof receiver !== 'object' || typeof receiver.request !== 'function') {
    fail('VALIDATION', 'callMtop 需要实现 request() 的 MtopTransport')
  }
  const request = buildMtopRequest({ ...opts, signal: mergeSignal(opts.signal) })
  let response: MtopHttpResponse
  try {
    response = await transport.request(request)
  } catch (error) {
    if (error instanceof XianyuError) throw error
    fail('NETWORK', '[' + opts.api + '] mtop 请求失败：' + describeError(error), { cause: error })
  }
  if (response === null || typeof response !== 'object') {
    fail('NETWORK', '[' + opts.api + '] mtop transport 返回了非对象响应')
  }
  const status = (response as { status?: unknown }).status
  if (typeof status !== 'number' || !Number.isInteger(status)) {
    fail('NETWORK', '[' + opts.api + '] mtop transport 返回的 status 非法')
  }
  if (status < 200 || status >= 300) throw statusError(opts.api, status)
  const text = (response as { text?: unknown }).text
  if (typeof text !== 'string') {
    fail('NETWORK', '[' + opts.api + '] mtop transport 返回的 text 非法')
  }
  return parseMtopResponse(opts.api, parseJson(opts.api, text))
}
