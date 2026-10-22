/**
 * 异常唤醒：轮询 daemon 事件流，把 failed / needs_review 用 agent.followup 推回会话。
 *
 * 为什么需要它：发布是 daemon 里异步跑的，用户关掉面板或换会话后根本不知道刚才那批
 * 发了没有。面板能看（工作流树），但「人不在看」的那段时间需要一个主动通知。
 *
 * 边界：
 * - 只推终态异常（alerts.js 的口径），不推进度；一条消息合并同一次轮询里的多条。
 * - 只走宿主公开扩展点 ctx.on('agent/created') + agent.followup（AGENTS §4 白名单）。
 * - 不额外新开模型请求做判断：消息文本是纯函数拼的，不调 LLM。
 *
 * @module @bigfish/plugin-ops/alert-watch
 */
import { buildAlertMessage, collectAlertEvents, takeNewEvents } from './alerts.js'

/** 默认轮询间隔：比面板的 3 秒慢，告警不需要那么灵敏，省 daemon 查询。 */
export const DEFAULT_ALERT_INTERVAL_MS = 10_000

/** 每次拉取的事件数。 */
export const ALERT_PAGE_LIMIT = 200

/** 首次启动时往前翻页找最新游标的页数上限（防止旧库里几万条事件拖住启动）。 */
export const MAX_PRIME_PAGES = 20

/** 待推送事件上限：daemon 长时间离线、一次恢复时别把会话刷爆。 */
export const MAX_PENDING = 20

/** 去重集合上限。 */
const SEEN_LIMIT = 500

/**
 * 新建一份轮询状态（导出给测试与诊断用）。
 *
 * @returns {{cursor: number, primed: boolean, pending: Array<Record<string, unknown>>, seen: Set<unknown>}} 状态。
 */
export function createAlertState() {
  return { cursor: 0, primed: false, pending: [], seen: new Set() }
}

/**
 * 从「没有任何游标」找到最新事件 id：翻页直到不满一页，最多 MAX_PRIME_PAGES 页。
 * 目的不是读历史，而是把基线定在「插件启动这一刻」，避免把昨天失败的旧任务当成新通告。
 *
 * @param {{listEvents: Function}} client - daemon 客户端。
 * @param {ReturnType<typeof createAlertState>} state - 轮询状态（写 cursor/primed）。
 * @returns {Promise<void>} 完成即已就绪；失败时抛给调用方。
 */
export async function primeAlertCursor(client, state) {
  let since = 0
  for (let page = 0; page < MAX_PRIME_PAGES; page += 1) {
    const result = await client.listEvents({ since, limit: ALERT_PAGE_LIMIT })
    const items = Array.isArray(result?.items) ? result.items : []
    const next = Number.isInteger(result?.nextSince) ? result.nextSince : since
    if (items.length === 0 || next === since) break
    since = next
    if (items.length < ALERT_PAGE_LIMIT) break
  }
  state.cursor = since
  state.primed = true
}

/**
 * 把新事件放进待推送队列（超过上限丢最早的，并在返回值里报告丢弃数）。
 *
 * @param {ReturnType<typeof createAlertState>} state - 轮询状态。
 * @param {Array<Record<string, unknown>>} events - 新告警事件。
 * @returns {number} 被丢弃的条数。
 */
export function pushPending(state, events) {
  state.pending.push(...events)
  const dropped = Math.max(0, state.pending.length - MAX_PENDING)
  if (dropped > 0) state.pending.splice(0, dropped)
  return dropped
}

/**
 * 有 agent 时把待推送事件合并成一条消息推出去。
 *
 * @param {{state: ReturnType<typeof createAlertState>, resolveAgent: Function, notify: Function, plugin?: string}} options - 依赖。
 * @returns {Promise<{notified: number}>} 推出去的条数。
 */
export async function flushAlerts(options) {
  const { state } = options
  if (state.pending.length === 0) return { notified: 0 }
  const agent = options.resolveAgent()
  if (agent === undefined || agent === null) return { notified: 0 }
  const events = state.pending.slice()
  const message = buildAlertMessage(events, { plugin: options.plugin })
  // 推送成功后才清队列：followup 抛错时事件留着，下一轮重试而不是静默丢掉。
  await options.notify(agent, message)
  state.pending.splice(0, events.length)
  return { notified: events.length }
}

/**
 * 跑一轮：没有 agent 就什么都不做；首次先定基线；之后增量拉取并推送。
 *
 * @param {{client: {listEvents: Function}, state: ReturnType<typeof createAlertState>,
 *   resolveAgent: Function, notify?: Function, plugin?: string}} options - 依赖。
 * @returns {Promise<{skipped?: string, primed?: boolean, fetched?: number, notified?: number}>} 本轮结果（只用于诊断/测试）。
 */
export async function pollAlerts(options) {
  const { client, state } = options
  if (options.resolveAgent() === undefined) return { skipped: 'no-agent' }
  if (!state.primed) {
    await primeAlertCursor(client, state)
    return { primed: true, fetched: 0, notified: 0 }
  }
  const result = await client.listEvents({ since: state.cursor, limit: ALERT_PAGE_LIMIT })
  const items = Array.isArray(result?.items) ? result.items : []
  const next = Number.isInteger(result?.nextSince) ? result.nextSince : state.cursor
  if (next > state.cursor) state.cursor = next
  const fresh = takeNewEvents(collectAlertEvents(items), state.seen, SEEN_LIMIT)
  if (fresh.length > 0) pushPending(state, fresh)
  const flushed = await flushAlerts({
    state,
    resolveAgent: options.resolveAgent,
    notify: options.notify ?? defaultNotify,
    plugin: options.plugin,
  })
  return { fetched: items.length, notified: flushed.notified }
}

/**
 * 默认推送方式：宿主 Agent 的 followup（排队成一个新回合）。
 *
 * @param {object} agent - 活着的 DSH agent。
 * @param {object} message - buildAlertMessage 的结果。
 * @returns {void}
 */
function defaultNotify(agent, message) {
  agent.followup(message)
}

/**
 * 从 Cordis 服务里取最近一个顶层 agent：多会话时推给最新创建的那个
 * （用户通常就在那个会话里；面板是全局的，没有更强的归属信号）。
 *
 * @param {object | undefined} ctx - 插件上下文。
 * @returns {object | undefined} agent。
 */
export function resolveRootAgent(ctx) {
  if (ctx === undefined || ctx === null) return undefined
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (agents === undefined || typeof agents.roots !== 'function') return undefined
  try {
    const roots = agents.roots()
    return Array.isArray(roots) && roots.length > 0 ? roots[roots.length - 1] : undefined
  } catch {
    // 服务正在销毁/尚未就绪：这一轮当作没有 agent，下一轮再看。
    return undefined
  }
}

/**
 * 启动告警轮询。默认只在「已经有活着的 agent」时开跑，否则等 agent/created 再开。
 *
 * @param {{ctx?: object, client: {listEvents: Function}, intervalMs?: number, plugin?: string,
 *   log?: (line: string) => void, timers?: {setTimeout: Function, clearTimeout: Function},
 *   resolveAgent?: Function, notify?: Function}} options - 依赖（ctx/定时器/agent 解析可注入）。
 * @returns {{stop: () => void, pollNow: () => Promise<object>, state: object, active: () => boolean}} 控制器。
 */
export function startAlertWatcher(options) {
  if (options === null || typeof options !== 'object' || options.client === undefined) {
    throw new TypeError('startAlertWatcher 需要 client')
  }
  const client = options.client
  const intervalMs = typeof options.intervalMs === 'number' && options.intervalMs > 0 ? options.intervalMs : DEFAULT_ALERT_INTERVAL_MS
  const timers = options.timers ?? { setTimeout, clearTimeout }
  const log = typeof options.log === 'function' ? options.log : () => {}
  const resolveAgent = typeof options.resolveAgent === 'function' ? options.resolveAgent : () => resolveRootAgent(options.ctx)
  const notify = typeof options.notify === 'function' ? options.notify : defaultNotify
  const state = createAlertState()
  let stopped = false
  let timer
  let running = false
  let errorStreak = false

  async function tick() {
    if (stopped) return { skipped: 'stopped' }
    if (running) return { skipped: 'running' }
    running = true
    let result = { skipped: 'unknown' }
    try {
      result = await pollAlerts({ client, state, resolveAgent, notify, plugin: options.plugin })
      errorStreak = false
    } catch (error) {
      // 连续失败只记第一条：daemon 没起时每 10 秒一条日志会淹没真正的信息。
      if (!errorStreak) {
        errorStreak = true
        log(JSON.stringify({
          level: 'warn',
          plugin: options.plugin ?? 'bigfish-ops',
          msg: '异常告警轮询失败（daemon 可能离线），恢复后自动继续，期间告警不会重复',
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    } finally {
      running = false
      arm()
    }
    return result
  }

  function arm() {
    if (stopped) return
    timer = timers.setTimeout(() => { void tick() }, intervalMs)
    // 定时器不阻止进程退出：DSH 退出时不该被一个告警轮询拖着。
    if (typeof timer?.unref === 'function') timer.unref()
  }

  function startIfAgentReady() {
    if (stopped || timer !== undefined) return
    if (resolveAgent() === undefined) return
    arm()
  }

  let disposeEvent
  if (typeof options.ctx?.on === 'function') {
    try {
      disposeEvent = options.ctx.on('agent/created', () => { startIfAgentReady() })
    } catch {
      disposeEvent = undefined
    }
  }
  startIfAgentReady()

  return {
    state,
    active: () => timer !== undefined && !stopped,
    pollNow: tick,
    stop: () => {
      stopped = true
      if (timer !== undefined) timers.clearTimeout(timer)
      timer = undefined
      if (typeof disposeEvent === 'function') disposeEvent()
    },
  }
}
