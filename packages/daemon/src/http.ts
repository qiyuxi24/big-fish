/**
 * HTTP 公共件：ApiResult 信封、请求体读取、Bearer 解析、出站脱敏。
 * @module @bigfish/daemon/http
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { XianyuError, fail, toXianyuError } from '@bigfish/core'
import type { ApiResult } from '@bigfish/core'

/** 单请求体上限 1 MiB。 */
export const MAX_BODY_BYTES = 1024 * 1024
/** 硬上限：超过后直接断开连接，避免超大 body 长时间占用进程。 */
const HARD_BODY_CAP = 8 * MAX_BODY_BYTES
/** 所有出站响应统一的 Content-Type。 */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/** 脱敏函数签名，与 core 的 redact 同形（同步或异步均可）。 */
export type RedactFn = (value: unknown) => unknown | Promise<unknown>

/** 成功信封。 */
export function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data }
}

/** 失败信封。 */
export function errorResult(error: XianyuError): ApiResult<never> {
  return { ok: false, error: error.toApiError() }
}

/**
 * 载入 core 的脱敏函数。
 *
 * 现状：@bigfish/core 的 redact.ts 尚未落地（task-6），此时退化为恒等函数；
 * 落地后不需要改这里——动态 import 会自动拿到 redact。
 * 为什么动态：避免对尚未提交的模块产生静态依赖，让本包先能独立跑通。
 */
export async function loadRedact(): Promise<RedactFn> {
  try {
    const core: Record<string, unknown> = await import('@bigfish/core')
    const candidate = core['redact']
    if (typeof candidate === 'function') return candidate as RedactFn
  } catch {
    // 这里故意退化为恒等：core 暂时缺少 redact 不是运行错误，下次启动会自动重试。
  }
  return (value: unknown): unknown => value
}

/**
 * 写 JSON 响应；出站前必须过 redact。
 * 脱敏抛错时失败关闭：绝不发送可能未脱敏的数据，改发一个固定错误体（常量不含外部数据）。
 */
export async function sendJson(res: ServerResponse, status: number, payload: unknown, redact: RedactFn): Promise<void> {
  if (res.writableEnded) return
  let body: string
  try {
    const safe = await redact(payload)
    body = JSON.stringify(safe ?? null)
  } catch {
    // 同样失败关闭：不把异常信息写回客户端，也不绕过脱敏发送原始 payload。
    res.writeHead(500, { 'Content-Type': JSON_CONTENT_TYPE })
    res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: '响应脱敏失败', retryable: false } }))
    return
  }
  res.writeHead(status, { 'Content-Type': JSON_CONTENT_TYPE })
  res.end(body)
}

/** 发一个指定 HTTP 状态的错误信封。 */
export async function sendError(res: ServerResponse, status: number, error: XianyuError, redact: RedactFn): Promise<void> {
  await sendJson(res, status, errorResult(error), redact)
}

/**
 * 把任意异常按 code 映射为 HTTP 状态：VALIDATION → validationStatus，其余 → 500。
 * 请求体超限这类需要 413 的错误用 details.httpStatus 覆盖。
 */
export async function sendMappedError(
  res: ServerResponse,
  error: unknown,
  validationStatus: number,
  redact: RedactFn,
): Promise<void> {
  const xe = toXianyuError(error)
  const status = xe.code !== 'VALIDATION' ? 500 : httpStatusOf(xe) ?? validationStatus
  await sendError(res, status, xe, redact)
}

/** 从错误 details 里取显式 HTTP 状态（只有超限等少数场景使用）。 */
function httpStatusOf(error: XianyuError): number | undefined {
  const value = error.details['httpStatus']
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/** 取出 Authorization: Bearer <token> 的 token 部分；格式不合法返回 undefined。 */
export function extractBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const matched = /^Bearer[ \t]+(\S+)$/i.exec(header.trim())
  return matched?.[1]
}

/** 常数时间比较 token；长度不同直接判不匹配（长度本身不是秘密）。 */
export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined || given.length === 0) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(given, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 读取并解析 JSON 请求体。
 * 超过 limit 抛 VALIDATION + details.httpStatus=413；超过硬上限直接断开连接。
 * allowEmpty=true 时空请求体返回 {}（扫码登录这类「全部参数可选」的端点允许不传 body）。
 */
export async function readJsonBody(
  req: IncomingMessage,
  limit: number = MAX_BODY_BYTES,
  allowEmpty: boolean = false,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  let exceeded = false
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > HARD_BODY_CAP) {
      req.destroy()
      throw new XianyuError({
        code: 'VALIDATION',
        message: '请求体超过硬上限 ' + HARD_BODY_CAP + ' 字节',
        details: { httpStatus: 413 },
      })
    }
    if (total > limit) {
      // 继续 drain 而不是立刻断开：让客户端把 body 写完，才收得到 413 而不是 EPIPE。
      exceeded = true
      continue
    }
    chunks.push(buffer)
  }
  if (exceeded) {
    throw new XianyuError({
      code: 'VALIDATION',
      message: '请求体超过上限 ' + limit + ' 字节',
      details: { httpStatus: 413 },
    })
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) {
    if (allowEmpty) return {}
    fail('VALIDATION', '请求体不能为空')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return fail('VALIDATION', '请求体不是合法 JSON')
  }
}

/** 断言值是普通 JSON 对象（不是数组/null），否则抛 VALIDATION。 */
export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('VALIDATION', what + ' 必须是 JSON 对象')
  return value as Record<string, unknown>
}

/** 取必填非空字符串字段。 */
export function requiredString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) fail('VALIDATION', what + ' 缺少非空字符串字段 ' + key)
  return value
}

/** 取可选字符串字段；出现了就必须是字符串。 */
export function optionalString(source: Record<string, unknown>, key: string, what: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail('VALIDATION', what + ' 的 ' + key + ' 必须是字符串')
  return value
}

/** 取可选布尔字段；出现了就必须是布尔值。 */
export function optionalBoolean(source: Record<string, unknown>, key: string, what: string): boolean | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail('VALIDATION', what + ' 的 ' + key + ' 必须是布尔值')
  return value
}

/** 取可选正整数（超时毫秒、条数这类）；出现了就必须是 ≥1 的安全整数。 */
export function optionalPositiveInt(source: Record<string, unknown>, key: string, what: string): number | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('VALIDATION', what + ' 的 ' + key + ' 必须是正整数')
  }
  return value
}

/** 取可选端口字段；出现了就必须是 1..65535 的整数（0 只允许在内部配置里表示随机端口）。 */
export function optionalPort(source: Record<string, unknown>, key: string, what: string): number | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    fail('VALIDATION', what + ' 的 ' + key + ' 必须是 1..65535 的整数')
  }
  return value
}
