/**
 * 工具规格的公共件：输出 schema、参数枚举、审批判定与规格包装。
 *
 * 为什么单独成文件：tools.js 只该声明「有哪些工具、参数是什么、调用哪个 handler」；
 * 门禁判定与 ToolDefinition 包装是所有工具共用的机制，放这里后按域拆工具文件时
 * 不必各自复制一份（复制出来就会漂移）。
 * @module @bigfish/plugin-ops/tool-kit
 */
import { DaemonError } from './client.js'

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

/** 空参数 schema（无参数工具用）。 */
export const NO_PARAMS = { type: 'object', properties: {}, additionalProperties: false }

/** 入队时需要人工确认的种类：发布/发货/擦亮会写闲鱼；probe/reply 不写商品数据。 */
const CONFIRM_TASK_KINDS = new Set(['publish', 'deliver', 'polish'])

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
          return {
            text: `❌ [${error.code}] ${error.message}${error.retryable ? '（可稍后重试）' : ''}`,
          }
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
