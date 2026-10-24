/**
 * 商家商品仓储的入参校验（id / 标题 / 整数分 / 计数 / limit）。
 *
 * 为什么单独成文件：seller-items.ts 已经贴着 AGENTS §3 的 400 行上限，
 * 补「按类目 / 全库」两类查询时最先膨胀的就是校验段；拆出来让仓储文件只留表与查询。
 * 这些函数是仓储实现细节，**不从 index.ts 导出**（包外只该看到仓储接口）。
 * @module @bigfish/core/seller-item-validate
 */
import { fail } from './errors.ts'

/** 列表类查询缺省条数：与采集上限对齐（一次采集最多 500 件，默认取 200 够版面用）。 */
export const DEFAULT_LIST_LIMIT = 200
export const MAX_LIST_LIMIT = 500

const MAX_ID_CHARS = 64
const MAX_TITLE_CHARS = 200
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

export function assertId(value: unknown, field: string): string {
  if (typeof value !== 'string') fail('VALIDATION', field + ' 必须是字符串')
  const text = value.trim()
  if (text.length === 0) fail('VALIDATION', field + ' 不能为空')
  if (text.length > MAX_ID_CHARS || !ID_PATTERN.test(text)) {
    fail('VALIDATION', field + ' 只能由字母、数字、.、_、:、- 组成且长度 1..' + MAX_ID_CHARS)
  }
  return text
}

export function assertTitle(value: unknown): string {
  if (typeof value !== 'string') fail('VALIDATION', 'title 必须是字符串')
  const text = value.trim()
  if (text.length === 0) fail('VALIDATION', 'title 不能为空')
  if (text.length > MAX_TITLE_CHARS) fail('VALIDATION', 'title 不能超过 ' + MAX_TITLE_CHARS + ' 个字符')
  return text
}

export function assertCents(value: unknown, field: string): number {
  const cents = assertCount(value, field)
  if (cents === undefined) fail('VALIDATION', field + ' 必须是整数分')
  return cents
}

export function optionalCents(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : assertCents(value, field)
}

/** 计数类字段：非负安全整数；undefined 表示平台没给，不写成 0。 */
export function assertCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('VALIDATION', field + ' 必须是非负安全整数：' + String(value).slice(0, 40))
  }
  return value
}

export function assertTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('VALIDATION', field + ' 必须是整数毫秒：' + String(value).slice(0, 40))
  }
  return value
}

export function assertFlag(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('VALIDATION', 'isSelf 必须是布尔')
  return value
}

export function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail('VALIDATION', '文本字段必须是字符串')
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length > MAX_TITLE_CHARS) fail('VALIDATION', '文本字段不能超过 ' + MAX_TITLE_CHARS + ' 个字符')
  return text
}

export function assertLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    fail('VALIDATION', 'limit 必须在 1..' + MAX_LIST_LIMIT + ' 之间：' + String(limit))
  }
  return limit
}
