/**
 * 异常告警：把 daemon 的 task 事件流翻译成「一条给人看的消息」。
 *
 * 纯函数层（不读时钟、不碰网络、不发消息），便于单测；副作用（轮询、followup）
 * 在 src/alert-watch.js。
 *
 * 口径：只有 task.state 落到 failed / needs_review 才算告警；task.step 只用于面板树，
 * 不推送——步骤事件太密，推给会话等于刷屏。
 *
 * @module @bigfish/plugin-ops/alerts
 */
import { randomUUID } from 'node:crypto'

/** 需要打扰人的终态；queued/leased/done 不告警。 */
export const ALERT_STATES = Object.freeze(['failed', 'needs_review'])

/** 状态中文名（与 client.js 的 TASK_STATE_LABELS 同口径）。 */
const STATE_LABELS = Object.freeze({ failed: '失败', needs_review: '待复核' })

/** 风控与登录态是两种「别再自动重试」的异常，提示语不同。 */
const RISK_CODE = 'RISK_CONTROL'
const AUTH_CODE = 'AUTH_EXPIRED'

/** 消息 summary 的上限，与宿主 boundContextSummary 一致（120 字符）。 */
export const ALERT_SUMMARY_MAX_CHARS = 120

/** 一条推送最多列几条明细；其余折叠成「另有 N 条」。 */
export const MAX_ALERT_LINES = 5

/**
 * @param {unknown} value - 任意值。
 * @returns {value is Record<string, unknown>} 是否普通对象。
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 单条事件是否值得打扰人。
 *
 * @param {unknown} event - /events 返回的事件。
 * @returns {boolean} 是否告警事件。
 */
export function isAlertEvent(event) {
  if (!isRecord(event)) return false
  if (event.kind !== 'task.state') return false
  return typeof event.state === 'string' && ALERT_STATES.includes(event.state)
}

/**
 * 从一页事件里挑出告警事件（保持原有顺序）。
 *
 * @param {unknown} items - /events 返回的 items。
 * @returns {Array<Record<string, unknown>>} 告警事件。
 */
export function collectAlertEvents(items) {
  if (!Array.isArray(items)) return []
  return items.filter((event) => isAlertEvent(event))
}

/**
 * 按事件 id 去重：同一事件只推一次；返回本次新出现的那些。
 * 已在集合里的 id 忽略；集合超过上限时丢最早的（面板与告警各自有游标，这里只是兜底）。
 *
 * @param {Array<Record<string, unknown>>} events - 候选事件。
 * @param {Set<unknown>} seen - 已推送过的 id 集合，会被原地修改。
 * @param {number} [limit] - 集合上限。
 * @returns {Array<Record<string, unknown>>} 新事件。
 */
export function takeNewEvents(events, seen, limit = 500) {
  if (!Array.isArray(events) || !(seen instanceof Set)) return []
  const fresh = []
  for (const event of events) {
    const id = event?.id
    if (id === undefined || id === null) continue
    if (seen.has(id)) continue
    seen.add(id)
    fresh.push(event)
  }
  while (seen.size > limit) {
    const oldest = seen.values().next()
    if (oldest.done) break
    seen.delete(oldest.value)
  }
  return fresh
}

/**
 * 任务 id 只露前 12 位，避免一条推送被 UUID 撑长。
 *
 * @param {unknown} taskId - 任务 id。
 * @returns {string} 短 id。
 */
export function shortTaskId(taskId) {
  const text = typeof taskId === 'string' ? taskId : String(taskId ?? '')
  return text.length <= 12 ? text : text.slice(0, 12)
}

/**
 * 一条事件渲染成一行中文。
 *
 * @param {Record<string, unknown>} event - 告警事件。
 * @returns {string} 明细行。
 */
export function formatAlertLine(event) {
  const state = STATE_LABELS[/** @type {keyof typeof STATE_LABELS} */ (event.state)] ?? String(event.state)
  const parts = ['- 任务 ' + shortTaskId(event.taskId)]
  if (typeof event.batchId === 'string' && event.batchId.length > 0) parts.push('批次 ' + event.batchId)
  parts.push('状态 ' + state)
  if (typeof event.code === 'string' && event.code.length > 0) parts.push(event.code)
  if (typeof event.message === 'string' && event.message.length > 0) parts.push(event.message)
  return parts.join(' · ')
}

/**
 * 按异常类型给下一步动作：风控先停手、登录态先重导，其余去面板重试。
 *
 * @param {Array<Record<string, unknown>>} events - 本次告警事件。
 * @returns {string} 一条中文建议。
 */
export function hintForEvents(events) {
  if (events.some((event) => event.code === RISK_CODE)) {
    return '下一步：风控信号，先暂停自动发布并人工确认账号状态，不要连续重试（面板「自动发布」页可停 daemon）。'
  }
  if (events.some((event) => event.code === AUTH_CODE)) {
    return '下一步：登录态可能过期，跑 `pnpm daemon:import-account` 重新导入（或在面板「账号」tab 重试）。'
  }
  if (events.some((event) => event.state === 'needs_review')) {
    return '下一步：任务需要人工复核，处理后在面板「自动发布」页点「重试」。'
  }
  return '下一步：在面板「自动发布」页查看任务详情并重试；失败详情见工作流树。'
}

/**
 * 多条告警渲染成一段可读文本。
 *
 * @param {Array<Record<string, unknown>>} events - 告警事件（非空）。
 * @returns {string} 多行文本。
 */
export function formatAlertText(events) {
  const list = Array.isArray(events) ? events : []
  const shown = list.slice(0, MAX_ALERT_LINES)
  const lines = ['⚠️ 闲鱼自动发布出现 ' + list.length + ' 条异常：', ...shown.map(formatAlertLine)]
  if (list.length > shown.length) lines.push('- 另有 ' + (list.length - shown.length) + ' 条，见面板工作流树')
  lines.push('', hintForEvents(list))
  return lines.join('\n')
}

/**
 * 折叠成一行 summary（宿主把 notice 显示成一行，超过 120 字符会截断）。
 *
 * @param {Array<Record<string, unknown>>} events - 告警事件。
 * @returns {string} ≤120 字符。
 */
export function alertSummary(events) {
  const list = Array.isArray(events) ? events : []
  const first = list[0]
  const code = typeof first?.code === 'string' && first.code.length > 0 ? '（' + first.code + '）' : ''
  const text = '闲鱼自动发布 ' + list.length + ' 条异常' + code + '：任务 ' + shortTaskId(first?.taskId)
  return text.length <= ALERT_SUMMARY_MAX_CHARS ? text : text.slice(0, ALERT_SUMMARY_MAX_CHARS - 1) + '…'
}

/**
 * 组装一条发给 agent 的 user message（宿主 followup 的入参形状）：
 * 插件来源 + notice 形式，模型侧能看出这是系统推送而不是用户发言。
 *
 * @param {Array<Record<string, unknown>>} events - 告警事件（非空）。
 * @param {{plugin?: string, idFactory?: () => string}} [options] - 插件名与 id 生成器（测试注入）。
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: object}} 消息。
 */
export function buildAlertMessage(events, options = {}) {
  const plugin = typeof options.plugin === 'string' && options.plugin.length > 0 ? options.plugin : 'bigfish-ops'
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomUUID
  return {
    id: idFactory(),
    role: 'user',
    content: [{ type: 'text', text: formatAlertText(events) }],
    source: { kind: 'plugin', plugin, form: 'notice', summary: alertSummary(events) },
  }
}
