/**
 * 闲管家平台错误码 → XianyuError 的映射。
 *
 * 错误码表来自 open.goofish.pro 文档（MIT 参考仓库
 * research/repos/xian-guanjia/references/api-docs.md:101-121）。
 * 说明：core 的 risk.ts 面向 mtop 的 ret 字段，闲管家只回数字 code，
 * 因此这里用数字表映射，不复用关键词表。
 * @module @bigfish/channel-guanjia
 */

import { XianyuError } from '@bigfish/core'
import type { ErrorCode, XianyuErrorOptions } from '@bigfish/core'

interface PlatformFailureSpec {
  code: ErrorCode
  message: string
  retryable?: boolean
}

/**
 * 平台码 → 内部错误码。core 没有「业务冲突 / 余额不足」专用码，
 * 统一收敛到 VALIDATION，并用 details.platformCode 保留原文以便上层区分。
 */
export const PLATFORM_FAILURES: Readonly<Record<number, PlatformFailureSpec>> = {
  1: { code: 'VALIDATION', message: '请求错误（不在定义范围内的错误）' },
  401: { code: 'VALIDATION', message: '签名错误，检查凭据与签名算法' },
  403: { code: 'UNAUTHORIZED', message: '访问 IP 不在白名单内' },
  408: { code: 'VALIDATION', message: '时间戳已超过有效期，检查本机时钟' },
  500: { code: 'INTERNAL', message: '闲管家系统异常，可重试', retryable: true },
  1000: { code: 'UNAUTHORIZED', message: '商户不存在' },
  1001: { code: 'UNAUTHORIZED', message: '商户不可用' },
  1002: { code: 'VALIDATION', message: '商户余额不足' },
  1100: { code: 'VALIDATION', message: '商品不存在' },
  1101: { code: 'VALIDATION', message: '商品不可用' },
  1102: { code: 'VALIDATION', message: '商品库存不足' },
  1200: { code: 'VALIDATION', message: '订单不存在' },
  1201: { code: 'VALIDATION', message: '下单参数错误' },
  1202: { code: 'VALIDATION', message: '下单金额低于成本价' },
  1203: { code: 'VALIDATION', message: '管家订单号已存在（幂等键冲突，重试无意义）' },
  1209: { code: 'UNKNOWN', message: '下单超时，必须先查单确认结果，禁止重放' }
}

/** 把 code !== 0 的响应转成带 platformCode 的 XianyuError。 */
export function platformFailure(
  path: string,
  platformCode: number,
  platformMessage: string,
  raw: unknown
): XianyuError {
  const spec = PLATFORM_FAILURES[platformCode]
  const summary = spec === undefined ? '未知错误码' : spec.message
  const suffix = platformMessage.length > 0 ? `：${platformMessage}` : ''
  const options: XianyuErrorOptions = {
    code: spec === undefined ? 'UNKNOWN' : spec.code,
    message: `闲管家接口失败（${path}）[${platformCode}] ${summary}${suffix}`,
    cause: raw,
    retryable: spec?.retryable ?? false,
    details: { path, platformCode, platformMessage }
  }
  return new XianyuError(options)
}
