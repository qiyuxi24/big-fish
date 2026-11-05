/**
 * 批量发布编排：收集草稿 → 逐条校验/算幂等键 → 批内去重 → dry-run 计划或逐条入队。
 *
 * 为什么不在这里另写一套 HTTP：入队语义（kind/payload 形状、title/quantity/accountId 校验）
 * 已经由 publish-flow 定义，批量复用 buildPublishEnqueueInput + client.enqueue，
 * 单条与批量才可能保持同口径。
 * 为什么逐条串行：单账号写串行是架构不变量（AGENTS.md §1.3）；并发入队只是把限流压力
 * 推给 daemon，20 条以内的串行等待可以接受。
 *
 * @module @bigfish/plugin-ops/batch
 */
import { DaemonError } from './client.js'
import { draftDedupeKey, loadPublishDraft, validatePublishDraft } from './draft.js'
import { buildPublishEnqueueInput } from './publish-flow.js'
import { formatBatchResult } from './batch-format.js'

/** 两种模式：dry-run 只出计划（默认），enqueue 才写 daemon 队列。 */
export const BATCH_MODES = ['dry-run', 'enqueue']
/** 单批默认条数，与 xy_publish_batch 的 maxItems 默认值一致。 */
export const DEFAULT_MAX_ITEMS = 20
/** 单批上限：一次工具调用最多 20 条，避免模型一口气塞几百条。 */
export const MAX_ITEMS_LIMIT = 20

/**
 * 账号级最小发布间隔默认值（毫秒）。
 *
 * 为什么是 180s：真机实测同账号 15s 内连发第二件就被风控（docs/module-architecture.md §5.1），
 * 而 daemon 写桶只有 1 次/60s——60s 仍会踩线。180s 让同账号两次发布互不相邻，
 * 20 条批量仍能在一小时内排完，不至于慢到不可用。可用 BF_PUBLISH_MIN_INTERVAL_MS 覆盖。
 */
export const DEFAULT_PUBLISH_MIN_INTERVAL_MS = 180_000
/** 配置下限：再小就退化成写桶的 60s，失去账号级 pacing 的意义。 */
export const PUBLISH_MIN_INTERVAL_MIN_MS = 30_000
/** 配置上限（1 小时）：再大批量发布实际上不可用，宁可让调用方改配置。 */
export const PUBLISH_MIN_INTERVAL_MAX_MS = 3_600_000

/**
 * 解析 BF_PUBLISH_MIN_INTERVAL_MS（数字或数字字符串）。
 *
 * 非法值回退默认值而不是抛错：这是「节奏」参数，配错了应退回安全默认，
 * 而不是让整批入队失败；超出上下限夹到边界值（与 core 的 resolvePublishMinIntervalMs 同口径）。
 *
 * @param {unknown} raw - 环境变量原值（未知类型）。
 * @returns {number} 夹取后的整数毫秒。
 */
export function resolvePublishMinIntervalMs(raw) {
  let value = DEFAULT_PUBLISH_MIN_INTERVAL_MS
  if (typeof raw === 'number') value = raw
  else if (typeof raw === 'string' && raw.trim() !== '') value = Number(raw)
  if (!Number.isFinite(value)) value = DEFAULT_PUBLISH_MIN_INTERVAL_MS
  return Math.min(PUBLISH_MIN_INTERVAL_MAX_MS, Math.max(PUBLISH_MIN_INTERVAL_MIN_MS, Math.trunc(value)))
}

/**
 * 账号级排队：给同一账号的第 N 条任务算出最早执行时间（now、now+interval、now+2*interval…）。
 *
 * 用 max(now, …) 是因为前一条的预约时间可能已经过期（比如批量生成计划后又等了一会儿），
 * 这时应从当前时刻重新起算，绝不能排到过去。
 *
 * @param {number | undefined} previousAt - 该账号上一条已排定的 availableAt。
 * @param {number} nowMs - 当前时间（整数毫秒）。
 * @param {number} intervalMs - 最小间隔（整数毫秒，>0）。
 * @returns {number} 本条任务的 availableAt。
 */
export function nextPublishAvailableAt(previousAt, nowMs, intervalMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw invalid('nowMs 必须是 >=0 的整数毫秒: ' + String(nowMs))
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw invalid('intervalMs 必须是正整数毫秒: ' + String(intervalMs))
  if (previousAt === undefined) return nowMs
  if (!Number.isSafeInteger(previousAt) || previousAt < 0) {
    throw invalid('previousAt 必须是 >=0 的整数毫秒: ' + String(previousAt))
  }
  return Math.max(nowMs, previousAt + intervalMs)
}

function invalid(message) {
  return new DaemonError('VALIDATION', message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** draftPaths 的元素必须是路径字符串；类型错属于整批参数错，直接报 VALIDATION。 */
function readDraftPaths(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid('draftPaths 必须是字符串数组（草稿 JSON 的路径）')
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw invalid('draftPaths[' + String(index) + '] 必须是非空字符串路径')
    }
    return item
  })
}

function readMaxItems(value) {
  if (value === undefined) return DEFAULT_MAX_ITEMS
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_ITEMS_LIMIT) {
    throw invalid('maxItems 必须是 1..' + String(MAX_ITEMS_LIMIT) + ' 的整数')
  }
  return value
}

/** 批次 id：只做归属标记，不参与幂等；格式与 core 的 assertBatchId 保持一致。 */
const BATCH_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function readBatchId(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !BATCH_ID_PATTERN.test(value)) {
    throw invalid('batchId 必须是 1-64 位字母、数字或 . _ -')
  }
  return value
}

/** 未显式给 batchId 时生成一个：时间戳保证可排序，随机尾巴避免同一毫秒内两批撞号。 */
export function generateBatchId(nowMs) {
  const stamp = Math.trunc(nowMs).toString(36)
  const tail = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return 'b-' + stamp + '-' + tail
}

function readMode(value) {
  if (value === undefined) return 'dry-run'
  if (typeof value !== 'string' || !BATCH_MODES.includes(value)) {
    throw invalid("mode 只能是 'dry-run' 或 'enqueue'")
  }
  return value
}

function readAccountId(value, mode) {
  if (value === undefined) {
    if (mode === 'enqueue') {
      throw invalid('enqueue 模式必须给 accountId：daemon 按账号载入登录态，这也是防发错号的依据')
    }
    return undefined
  }
  if (typeof value !== 'string' || value.trim() === '') throw invalid('accountId 必须是非空字符串')
  return value
}

/**
 * 校验整批参数。参数级错误（缺来源、类型错、maxItems 越界）直接抛 VALIDATION，
 * 因为这类错误重试整批与单条无关；单条草稿的错误留到 prepareBatch 里逐条标记。
 *
 * @param {Record<string, unknown>} args - 工具参数。
 * @returns {{mode: string, accountId: string | undefined, batchId: string | undefined, drafts: unknown[], draftPaths: string[], maxItems: number}}
 */
export function normalizeBatchArgs(args) {
  if (!isRecord(args)) throw invalid('xy_publish_batch 的参数必须是对象')
  const mode = readMode(args.mode)
  const batchId = readBatchId(args.batchId)
  const accountId = readAccountId(args.accountId, mode)
  if (args.drafts !== undefined && !Array.isArray(args.drafts)) {
    throw invalid('drafts 必须是数组（每个元素是一份草稿对象）')
  }
  const drafts = args.drafts ?? []
  const draftPaths = readDraftPaths(args.draftPaths)
  if (drafts.length === 0 && draftPaths.length === 0) {
    throw invalid('drafts 与 draftPaths 至少要给一个非空数组：批量发布需要至少一条草稿')
  }
  return { mode, accountId, batchId, drafts, draftPaths, maxItems: readMaxItems(args.maxItems) }
}

/** 内联草稿在前、文件路径在后，保持调用方给的顺序；label 用于逐条回显来源。 */
function buildSources(drafts, draftPaths) {
  const sources = []
  drafts.forEach((value, index) => sources.push({ kind: 'inline', value, label: 'drafts[' + String(index) + ']' }))
  draftPaths.forEach((value, index) => sources.push({ kind: 'path', value, label: 'draftPaths[' + String(index) + ']' }))
  return sources
}

/** 文件读取走 draft.js 的同一条路径：读失败 / JSON 坏 / 字段非法都收敛成 VALIDATION。 */
async function loadItemDraft(source, readDraftFile) {
  if (source.kind === 'path') return loadPublishDraft(source.value, readDraftFile)
  return validatePublishDraft(source.value)
}

/** 入队模式下提前跑一遍单条校验（title/quantity），把必然 failed 的任务挡在本地。 */
function attachEnqueueInput(item, draft, accountId) {
  try {
    item.input = buildPublishEnqueueInput({ accountId }, draft)
  } catch (error) {
    if (!(error instanceof DaemonError)) throw error
    item.status = 'invalid'
    item.reason = '[' + error.code + '] ' + error.message
  }
}

/**
 * 逐条加载/校验/去重，产出计划（此时完全不碰 daemon）。
 *
 * @param {Record<string, unknown>} args - 工具参数。
 * @param {{readDraftFile?: Function}} [deps] - readDraftFile 仅测试注入。
 * @returns {Promise<{mode: string, accountId: string | undefined, batchId: string | undefined, items: object[], truncated: number}>}
 */
export async function prepareBatch(args, deps = {}) {
  const normalized = normalizeBatchArgs(args)
  const sources = buildSources(normalized.drafts, normalized.draftPaths)
  const truncated = Math.max(0, sources.length - normalized.maxItems)
  const items = []
  // dedupeKey → 首次出现的序号：批内相同内容只留一条任务，跨批由 daemon 的 dedupeKey 兜底。
  const seen = new Map()
  for (const source of sources.slice(0, normalized.maxItems)) {
    const item = { index: items.length + 1, source: source.label, status: 'ok' }
    try {
      const draft = await loadItemDraft(source, deps.readDraftFile)
      item.draft = draft
      // 幂等键带上账号：daemon 的 dedupe_key 是全局唯一，不带账号会让「B 号发同款」被当成重复丢单。
      item.dedupeKey = draftDedupeKey(draft, normalized.accountId)
      // 先跑入队校验再登记键：非法条目不应占用幂等键，否则同内容的后续条目会被误判重复。
      if (normalized.mode === 'enqueue') attachEnqueueInput(item, draft, normalized.accountId)
      if (item.status === 'ok') {
        const duplicateOf = seen.get(item.dedupeKey)
        if (duplicateOf === undefined) seen.set(item.dedupeKey, item.index)
        else Object.assign(item, {
          status: 'skipped-duplicate',
          duplicateOf,
          reason: '与第 ' + String(duplicateOf) + ' 条幂等键相同（同一份草稿），不会重复入队',
        })
      }
    } catch (error) {
      if (!(error instanceof DaemonError)) throw error
      item.status = 'invalid'
      item.reason = '[' + error.code + '] ' + error.message
    }
    items.push(item)
  }
  return { mode: normalized.mode, accountId: normalized.accountId, batchId: normalized.batchId, items, truncated }
}

/** daemon 若返回 created 字段就以它为准；老版本 daemon 没有该字段，按「确实新建了」处理。 */
function readCreated(task) {
  if (task === null || typeof task !== 'object') return true
  return /** @type {{created?: unknown}} */ (task).created !== false
}

function readAvailableAt(task) {
  if (task === null || typeof task !== 'object') return undefined
  const value = /** @type {{availableAt?: unknown}} */ (task).availableAt
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/** 只取 task id 前 8 位做展示；结构不对不抛错，显示 ?。 */
function readTaskId(task) {
  if (task === null || typeof task !== 'object') return '?'
  const id = /** @type {{id?: unknown}} */ (task).id
  return typeof id === 'string' && id.length > 0 ? id.slice(0, 8) + '…' : '?'
}

/**
 * daemon /tasks 的入队体已经由 buildPublishEnqueueInput 拼好，这里负责账号级 pacing、
 * 调用与错误归类。
 *
 * 为什么在入队侧排队、而不是 daemon 执行侧：daemon 的 /tasks 已支持 availableAt，
 * 且队列租约会跳过未到点的任务（不需要新增状态或定时器）；在批量这一层算时间还能让
 * 整批的预约顺序对模型可见。代价是：直接 POST /tasks（不带 availableAt）的单个任务
 * 不受这里约束，仍靠 daemon 写桶 1 次/60s 兜底——批量是并发发布的主要入口，先覆盖批量。
 *
 * @param {object[]} items - prepareBatch 产出的条目（原地改写 status/taskId/availableAt）。
 * @param {object} client - daemon 客户端。
 * @param {{now: () => number, minIntervalMs: number, batchId?: string}} options - 注入时钟、最小间隔与批次 id。
 */
async function enqueueItems(items, client, options) {
  let abortedReason
  /** @type {Map<string, number>} 账号 → 该账号上一条已排定的 availableAt。 */
  const lastByAccount = new Map()
  for (const item of items) {
    if (item.status !== 'ok') continue
    if (abortedReason !== undefined) {
      Object.assign(item, { status: 'failed', reason: abortedReason })
      continue
    }
    try {
      const accountId = item.input?.payload?.accountId
      if (typeof accountId !== 'string' || accountId === '') {
        throw new DaemonError('VALIDATION', '入队体缺少 accountId，无法做账号级发布 pacing')
      }
      const availableAt = nextPublishAvailableAt(lastByAccount.get(accountId), options.now(), options.minIntervalMs)
      const body = options.batchId === undefined ? { ...item.input, availableAt } : { ...item.input, batchId: options.batchId, availableAt }
      const task = await client.enqueue(body)
      // 只有入队成功才占用该账号的预约位：被 daemon 拒绝的条目没有真正排队，不该推迟下一条。
      lastByAccount.set(accountId, availableAt)
      if (readCreated(task)) {
        Object.assign(item, { status: 'queued', taskId: readTaskId(task), created: true, availableAt })
      } else {
        // dedupeKey 命中已有任务：daemon 什么都没新建。状态单列 'existing'，
        // 否则「本批入队 4 条」会把跨批重复也算成新任务，用户会以为发了两遍。
        Object.assign(item, {
          status: 'existing',
          taskId: readTaskId(task),
          created: false,
          availableAt: readAvailableAt(task) ?? availableAt,
          reason: '幂等键命中已有任务（该任务已在队列，本次没有新建）',
        })
      }
    } catch (error) {
      if (!(error instanceof DaemonError)) throw error
      Object.assign(item, { status: 'failed', reason: '[' + error.code + '] ' + error.message })
      // 连不上/鉴权失败时继续逐条试只会把 15s 超时乘以 N：直接中止剩余条目，省时间也省 daemon 压力。
      if (error.code === 'NETWORK' || error.code === 'UNAUTHORIZED') {
        abortedReason = '上一条失败（' + error.code + '），本批已中止，未尝试'
      }
    }
  }
}

// 渲染实现拆在 batch-format.js（守 AGENTS §3 文件 ≤400 行）；这里再导出，测试/工具层的引用点不变。
export { formatBatchResult }
/**
 * 读 daemon 设置里的发布间隔，读不到就返回 undefined。
 *
 * 为什么要有这一层：面板「设置 → 发布间隔」写的是 daemon 的 settings.publishMinIntervalMs，
 * 而本文件原先只读环境变量 BF_PUBLISH_MIN_INTERVAL_MS，导致用户在面板把 180s 改成 1 小时
 * 后节奏一点没变——设置项等于撒谎。现在把它接成第三优先级来源。
 *
 * 失败不抛：设置读不到时退回环境变量/默认值，不该让一次批量入队因为读设置失败就整批不动。
 *
 * @param {object} client - daemon 客户端（可能没有 getSettings）。
 * @returns {Promise<unknown>} 原值，交给 resolvePublishMinIntervalMs 夹取。
 */
async function readSettingsPublishMinIntervalMs(client) {
  if (typeof client.getSettings !== 'function') return undefined
  try {
    const settings = await client.getSettings()
    return settings === null || typeof settings !== 'object' ? undefined : settings.publishMinIntervalMs
  } catch {
    // 读设置是「让配置生效」的增强，不是入队的前置条件；失败静默回退。
    return undefined
  }
}

/**
 * 工具入口：先做纯本地计划，enqueue 模式再逐条入队，最后统一渲染。
 *
 * 发布间隔的优先级：显式 deps.minIntervalMs（测试/调用方指定）> 环境变量
 * BF_PUBLISH_MIN_INTERVAL_MS（运维级覆盖）> daemon 设置 publishMinIntervalMs（面板可改）
 * > 内置默认 180s。
 *
 * @param {Record<string, unknown>} args - 工具参数。
 * @param {{client: object, readDraftFile?: Function, now?: () => number, minIntervalMs?: unknown}} deps
 *   daemon 客户端、可注入的文件读取 / 时钟 / 最小间隔（后两者用于测试与显式覆盖）。
 * @returns {Promise<string>} 模型可读文本。
 */
export async function runBatch(args, deps) {
  const plan = await prepareBatch(args, deps)
  if (plan.mode === 'enqueue') {
    const fromEnv = deps.minIntervalMs === undefined ? process.env.BF_PUBLISH_MIN_INTERVAL_MS : deps.minIntervalMs
    const rawInterval = fromEnv === undefined ? await readSettingsPublishMinIntervalMs(deps.client) : fromEnv
    const minIntervalMs = resolvePublishMinIntervalMs(rawInterval)
    const now = typeof deps.now === 'function' ? deps.now : Date.now
    // batchId 在本批真正入队时才生成：dry-run 计划不该无端造一个 id 写进输出。
    const batchId = plan.batchId ?? generateBatchId(now())
    plan.batchId = batchId
    await enqueueItems(plan.items, deps.client, { now, minIntervalMs, batchId })
    // 回读服务端视图：本批可能全部命中已有任务（新入队 0），逐条结果看不出的「服务端到底有没有这批」只能问 daemon。
    // 读失败不影响入队结果本身，把错误降级成一句说明。
    if (typeof deps.client.getBatch === 'function') {
      try {
        plan.batchStats = await deps.client.getBatch(batchId)
      } catch (error) {
        plan.batchViewError = error instanceof DaemonError ? '[' + error.code + '] ' + error.message : String(error)
      }
    }
  }
  return formatBatchResult(plan)
}
