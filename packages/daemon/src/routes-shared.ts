/**
 * 路由层共享的解析与错误构造。
 *
 * 为什么单独成文件：任务 / 事件 / 商品 / 采集四处都要解析 limit 与状态枚举，
 * 之前 routes.ts 与 seller-routes.ts 各写了一份 parseLimit（语义还不一致：一个无上限、
 * 一个带 max）。这里收成一处，域文件只关心自己的 handler。
 * @module @bigfish/daemon/routes-shared
 */
import { XianyuError, fail } from '@bigfish/core'
import type { ItemState, TaskKind, TaskState } from '@bigfish/core'

const TASK_STATES = new Set<string>(['queued', 'leased', 'done', 'failed', 'needs_review'])
const TASK_KINDS = new Set<string>(['publish', 'deliver', 'polish', 'reply', 'probe'])
const ITEM_STATES = new Set<string>(['online', 'offline', 'unknown'])

/** 状态机取值校验（P0 手写集合；任务层用 zod 时再统一）。 */
export function isTaskState(value: string): value is TaskState {
  return TASK_STATES.has(value)
}

export function isItemState(value: string): value is ItemState {
  return ITEM_STATES.has(value)
}

export function isTaskKind(value: string): value is TaskKind {
  return TASK_KINDS.has(value)
}

/** 装饰 URL 参数解码失败时按 VALIDATION 处理。 */
export function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return fail('VALIDATION', '路径参数不是合法的 URL 编码')
  }
}

/** limit 查询参数：必须是正整数（无上限；需要上限的用 parseLimit）。 */
export function parsePositiveInt(raw: string, field = 'limit'): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) fail('VALIDATION', field + ' 必须是正整数：' + raw)
  return Number(raw)
}

/** 带默认值与上限的 limit：列表类接口用（缺省时用 fallback，超界按 VALIDATION）。 */
export function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback
  const value = parsePositiveInt(raw)
  if (value > max) fail('VALIDATION', 'limit 必须在 1..' + max + ' 之间：' + raw.slice(0, 20))
  return value
}

/** since 是事件主键游标：只接受非负整数，别让「上次失败的游标」把面板卡死。 */
export function parseSince(raw: string): number {
  if (!/^\d+$/.test(raw)) fail('VALIDATION', 'since 必须是非负整数：' + raw)
  return Number(raw)
}

/**
 * 构造 404 错误。
 *
 * code 必须与 HTTP 状态一致（NOT_FOUND ↔ 404）：core 早就有 NOT_FOUND 码，
 * 早先这里用 VALIDATION 是「core 没有 404 码」年代的遗留注释，后果是
 * 调用方拿到 404 + VALIDATION，会把它当成「参数写错」去改参数，
 * 而正确动作是「先列出来拿到真实 id」。details 里带上 id 便于直接比对。
 */
export function taskNotFound(id: string): XianyuError {
  return new XianyuError({ code: 'NOT_FOUND', message: '任务不存在：' + id, details: { id, resource: 'task' } })
}

export function batchNotFound(batchId: string): XianyuError {
  return new XianyuError({ code: 'NOT_FOUND', message: '批次不存在：' + batchId, details: { id: batchId, resource: 'batch' } })
}
