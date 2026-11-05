/**
 * 任务值域与入参断言。
 *
 * 为什么单独成文件：这些断言是每个队列入口的边界（对外输入 → 稳定 VALIDATION），
 * 而 queue.ts 的状态机与 SQL 已接近 400 行上限；拆开后两边都只剩单一职责。
 * @module @bigfish/core/queue-guards
 */
import { fail } from './errors.ts'
import type { TaskKind, TaskState } from './types.ts'

/** 任务种类白名单，与 tasks 表的 CHECK 约束一致。 */
export const TASK_KINDS: readonly TaskKind[] = ['publish', 'deliver', 'polish', 'reply', 'probe']

/** 任务状态白名单，与 tasks 表的 CHECK 约束一致。 */
export const TASK_STATES: readonly TaskState[] = ['queued', 'leased', 'done', 'failed', 'needs_review']

/** batchId 会进 SQL 条件、HTTP 路径与日志，限制字符集避免注入与歧义；64 与任务 id 的用法对齐。 */
export const BATCH_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (TASK_KINDS as readonly string[]).includes(value)
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value)
}

/** 读库时把 kind 收窄回联合类型；非法值说明库被外部改坏（STORAGE 而非 VALIDATION）。 */
export function requireKind(value: string): TaskKind {
  if (isTaskKind(value)) return value
  fail('STORAGE', `tasks.kind 非法：${value}`)
}

export function requireState(value: string): TaskState {
  if (isTaskState(value)) return value
  fail('STORAGE', `tasks.state 非法：${value}`)
}

/**
 * 值域断言。
 *
 * 文案规则：缺字段时说「缺少 X」，写错值时回显值本身——绝不把 `undefined` 这个
 * JavaScript 内部值拼进面向用户的文案里（2026-11-03 审计实测 `POST /tasks {}`
 * 返回「kind 非法：undefined」，读起来像 daemon 内部漏了变量）。
 */
export function assertKind(value: unknown): TaskKind {
  if (value === undefined) fail('VALIDATION', '缺少 kind 字段：可选 publish / deliver / polish / reply / probe')
  if (isTaskKind(value)) return value
  fail('VALIDATION', `kind 非法：${String(value)}`)
}

export function assertState(value: unknown): TaskState {
  if (value === undefined) fail('VALIDATION', '缺少 state 字段：可选 queued / leased / done / failed / needs_review')
  if (isTaskState(value)) return value
  fail('VALIDATION', `state 非法：${String(value)}`)
}

export function assertText(value: unknown, field: string): string {
  if (value === undefined) fail('VALIDATION', `${field} 是必填字段，但请求里没有`)
  if (typeof value !== 'string') fail('VALIDATION', `${field} 必须是字符串`)
  if (value.trim().length === 0) fail('VALIDATION', `${field} 不能为空`)
  return value
}

export function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('VALIDATION', `${field} 必须是正整数`)
  }
  return value
}

export function assertTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('VALIDATION', `${field} 必须是非负整数毫秒`)
  }
  return value
}

/** 批次 id 校验：undefined 由调用方处理，这里只收窄字符串。 */
export function assertBatchId(value: unknown): string {
  if (typeof value !== 'string' || !BATCH_ID_PATTERN.test(value)) {
    fail('VALIDATION', 'batchId 必须是 1-64 位字母、数字或 . _ -')
  }
  return value
}

/** 满状态计数（每个已知状态都显式出现，避免前端收到缺键的 Record）。 */
export function emptyStateCounts(): Record<TaskState, number> {
  return { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 }
}

/** AGENTS 硬规则：退避 = min(60 * 2^(attempts-1), 1800) 秒；attempts 从 1 起算。 */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(60 * 2 ** exponent, 1800) * 1000
}

export function errorMessage(error: string | Error): string {
  if (typeof error === 'string') return error.length === 0 ? '未知错误' : error
  if (error instanceof Error) return error.message.length === 0 ? error.name : error.message
  fail('VALIDATION', 'fail() 的 error 必须是字符串或 Error')
}
