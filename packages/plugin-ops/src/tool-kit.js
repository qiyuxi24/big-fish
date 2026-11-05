/**
 * 工具规格的公共件：输出 schema、参数枚举、审批判定与规格包装。
 *
 * 为什么单独成文件：tools.js 只该声明「有哪些工具、参数是什么、调用哪个 handler」；
 * 门禁判定与 ToolDefinition 包装是所有工具共用的机制，放这里后按域拆工具文件时
 * 不必各自复制一份（复制出来就会漂移）。
 * @module @bigfish/plugin-ops/tool-kit
 */
import { DaemonError } from './client.js'
import { CONFIRM_TASK_KINDS } from './rpc-schema.js'
import { nextStepFor } from './tool-format.js'

/** 所有工具共用的输出 schema：一个文本块。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
}

/** 任务种类，与 @bigfish/core 的 TaskKind 一致。 */
export const TASK_KINDS = ['publish', 'deliver', 'polish', 'reply', 'probe']
/** 任务状态，与 @bigfish/core 的 TaskState 一致。 */
export const TASK_STATES = ['queued', 'leased', 'done', 'failed', 'needs_review']

/**
 * 非空字符串必填参数：缺参 / 非字符串 / 空串（含纯空白）一律 VALIDATION。
 *
 * 为什么要统一收口：JSON Schema 的 required 只挡「缺字段」，挡不住 `undefined`
 * 被拼进 URL、再被 daemon 回一个空对象——那会渲染成「已重新排队： |  | 」这种
 * 看似成功的静默空结果（2026-11-05 审计 §1.3）。参数名写错也要在这里挡住，
 * 绝不能让 `encodeURIComponent(undefined)` 走到 daemon。
 *
 * @param {Record<string, unknown>} args - 工具参数。
 * @param {string[]} keys - 同义参数名（如任务 id 的 ['id', 'taskId']），任一命中即可。
 * @param {string} label - 报错里给模型看的字段名。
 * @returns {string} 命中的值。
 */
export function requireString(args, keys, label) {
  for (const key of keys) {
    const value = args[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim() === '') {
      throw new DaemonError('VALIDATION', label + ' 必须是非空字符串（收到 ' + String(value) + '）')
    }
    return value
  }
  throw new DaemonError('VALIDATION', '缺少必填参数 ' + label + '（可接受：' + keys.join(' / ') + '）')
}

/**
 * 必填枚举参数：值必须落在给定的候选集合里，否则 VALIDATION。
 * @param {Record<string, unknown>} args - 工具参数。
 * @param {string} key - 参数名。
 * @param {readonly string[]} values - 合法值。
 * @returns {string} 命中的值。
 */
export function requireEnum(args, key, values) {
  const value = args[key]
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new DaemonError('VALIDATION', key + ' 必填且只能是：' + values.join(' / '))
  }
  return value
}

/**
 * 列表工具的 limit：给默认值、校验上下限。
 * 默认调小是阶段二的省 token 手段（原 tasks 20 / items 50），上限仍保留供显式翻页。
 * @param {Record<string, unknown>} args - 工具参数。
 * @param {number} fallback - 未给时的默认值。
 * @param {number} max - 允许的最大上限。
 * @returns {number} 合法的 limit。
 */
export function readLimit(args, fallback, max) {
  const value = args.limit
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new DaemonError('VALIDATION', 'limit 必须是 1..' + String(max) + ' 的整数')
  }
  return value
}

/**
 * 「二选一至少给一个」的必填组：任一字段给了非空值即可。
 * @param {Record<string, unknown>} args - 工具参数。
 * @param {string[]} keys - 候选参数名。
 * @returns {void}
 */
export function requireAnyOf(args, keys) {
  for (const key of keys) {
    const value = args[key]
    if (value === undefined) continue
    if (Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim() !== '') return
  }
  throw new DaemonError('VALIDATION', '必须给 ' + keys.join(' 或 ') + '（至少一个非空）')
}

/** 空参数 schema（无参数工具用）。 */
export const NO_PARAMS = { type: 'object', properties: {}, additionalProperties: false }

/** 入队时需要人工确认的种类：发布/发货/擦亮/回复会对外产生动作；probe 只读。 */
// 唯一事实源在 rpc-schema.js：面板 rpc 与工具门禁必须对「哪些 kind 算写」有同一个答案，
// 各写一份的结果是两边漂移（曾经 probe 在面板要两次确认、在工具里不要）。

/** 非 null 的普通对象（门禁参数判定用；数组不算对象）。 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * xy_task_enqueue 的门禁判定：只有 publish/deliver/polish 需要人工确认。
 * 参数形态无法判断时按保守方向返回 true——先问人，再让工具自己报 VALIDATION。
 *
 * @param {unknown} args - 模型给的参数。
 * @returns {boolean} true 表示需要人工确认。
 */
export function taskEnqueueIsWrite(args) {
  if (!isRecord(args)) return true
  return CONFIRM_TASK_KINDS.has(args.kind)
}

/**
 * 发布类工具（draft/batch）的门禁判定：默认 dry-run 只读放行，显式非 dry-run 才确认。
 * 参数缺失时返回 true（保守方向）。
 *
 * @param {unknown} args - 模型给的参数。
 * @returns {boolean} true 表示需要人工确认。
 */
export function nonDryRunIsWrite(args) {
  if (!isRecord(args)) return true
  return args.mode !== undefined && args.mode !== 'dry-run'
}

/**
 * 把错误的 details 压成一行给模型看。
 *
 * 为什么必须渲染：daemon 会把「哪个字段错了、还差多少、谁占着这条任务」放进
 * details（核心见 core 的 toApiError），只渲染 message 等于把结构化信息扔掉，
 * 模型只能猜。这里是唯一出口，所以长度要设上限，避免一次错误刷满上下文。
 *
 * @param {unknown} details - 错误细节（daemon 侧已过 redact）。
 * @returns {string} 空串表示没有可渲染的细节。
 */
function renderDetails(details) {
  if (!isRecord(details)) return ''
  const keys = Object.keys(details)
  if (keys.length === 0) return ''
  let text
  try {
    text = JSON.stringify(details)
  } catch {
    // 循环引用/不可序列化：细节不是关键路径，宁可少说不报错。
    return ''
  }
  const MAX_CHARS = 500
  const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '…（已截断）' : text
  return `\n细节：${clipped}`
}

/**
 * 把一个"返回字符串"的处理函数包成一条工具规格。
 *
 * 规格里的 access/reason/writeWhen 是门禁的唯一事实源，由 tool-middleware 统一消费；
 * 这里只负责把 handler 包成原始 ToolDefinition（不 import 宿主的 defineTool，保持零依赖）。
 *
 * @param {object} spec - name/description/parameters/handler/access/reason/writeWhen/timeoutMs。
 * @returns {{definition: object, access: 'read'|'confirm', reason?: string, writeWhen?: Function}} 工具规格。
 */
export function textTool(spec) {
  const { name, description, parameters, handler } = spec
  const definition = {
    name,
    description,
    parameters,
    // 默认 25s 覆盖单条 daemon 调用（15s 超时 + 余量）；批量工具在 spec 里显式放宽。
    timeoutMs: spec.timeoutMs ?? 25_000,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      try {
        return { text: await handler(args ?? {}) }
      } catch (error) {
        if (error instanceof DaemonError) {
          // 只有一句话的错误等于让人自己猜；附上 details + 「下一步」才是可执行的失败。
          const hint = nextStepFor(error.code)
          const retryable = error.retryable ? '（可稍后重试）' : ''
          return { text: `❌ [${error.code}] ${error.message}${retryable}${renderDetails(error.details)}\n→ ${hint}` }
        }
        throw error
      }
    },
  }
  const toolSpec = { definition, access: spec.access ?? 'read' }
  if (spec.reason !== undefined) toolSpec.reason = spec.reason
  if (spec.writeWhen !== undefined) toolSpec.writeWhen = spec.writeWhen
  return toolSpec
}
