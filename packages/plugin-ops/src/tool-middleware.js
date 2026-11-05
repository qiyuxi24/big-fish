/**
 * 工具注册中间件：把「工具定义 + 访问级别 + 审批理由」收敛成单一事实源。
 *
 * 背景：以前注册（index.js 的 for 循环）、门禁（gate.js 的 WRITE_TOOLS/WRITE_REASONS）
 * 和工具定义（tools.js 的 textTool）三处各维护一份写工具名单，加工具时容易漏挂审批。
 * 现在 tools.js 产出 specs，本模块统一做三件事：
 *   1. 校验定义（名字 / 描述 / 参数 / execute / output.schema / timeoutMs / 重名）；
 *   2. 逐个 ctx.tools.register，并收好它返回的反注册器（设置页关掉「是否启用」时要真的
 *      把 16 个工具从宿主撤销，否则模型每轮仍要付一遍工具 schema 的固定 token）；
 *   3. 由同一份 specs 注册唯一一个 tools/pre-execute 监听，按 access/reason/writeWhen 判定审批。
 *
 * 只用 DSH 公开扩展点：ctx.tools.register、ctx.on('tools/pre-execute')。
 * 零依赖纯 ESM，宿主版本无关。
 *
 * @module @bigfish/plugin-ops/tool-middleware
 */

/** 工具名规则：统一 xy_ 前缀 + 小写字母/数字/下划线。 */
const TOOL_NAME_PATTERN = /^xy_[a-z0-9_]+$/

/** 工具默认超时：覆盖单条 daemon 调用（15s 超时 + 余量）。 */
export const DEFAULT_TIMEOUT_MS = 25_000

/** 写工具没给 reason 时的默认审批理由（保持旧 gate.js 的兜底文案）。 */
function defaultReason(name) {
  return `${name} 会写真实闲鱼数据，需要人工确认。`
}

/** 参数校验用：非 null 的普通对象（数组不算，避免把 JSON schema 的数组当对象）。 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 校验并规范化一条工具规格。校验失败直接抛 TypeError（带工具名，便于定位）。
 *
 * 规格形状：{ definition, access: 'read' | 'confirm', reason?: string, writeWhen?: (args: unknown) => boolean }
 * writeWhen 只在 access==='confirm' 时有意义：返回 false 表示这次调用按只读放行。
 * 参数无法判断时要返回 true（保守方向：宁可多问一次，也不静默放行写操作）。
 *
 * @param {unknown} spec - 待校验的规格。
 * @returns {{definition: object, access: 'read'|'confirm', reason?: string, writeWhen?: Function}} 规范化后的规格（definition 是新对象，timeoutMs 已补默认值）。
 */
export function normalizeSpec(spec) {
  if (!isRecord(spec)) throw new TypeError('bigfish-ops: 工具规格必须是对象')
  const definition = spec.definition
  if (!isRecord(definition)) throw new TypeError('bigfish-ops: 工具规格缺少 definition 对象')
  const { name } = definition
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new TypeError(`bigfish-ops: 工具名不合法：${String(name)}（必须匹配 /^xy_[a-z0-9_]+$/）`)
  }
  if (typeof definition.description !== 'string' || definition.description.trim() === '') {
    throw new TypeError(`bigfish-ops: 工具 ${name} 的 description 必须是非空字符串`)
  }
  if (!isRecord(definition.parameters)) {
    throw new TypeError(`bigfish-ops: 工具 ${name} 的 parameters 必须是对象（JSON Schema）`)
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError(`bigfish-ops: 工具 ${name} 缺少 execute 函数`)
  }
  if (!isRecord(definition.output) || definition.output.schema === undefined || definition.output.schema === null) {
    throw new TypeError(`bigfish-ops: 工具 ${name} 缺少 output.schema`)
  }
  const access = spec.access
  if (access !== 'read' && access !== 'confirm') {
    throw new TypeError(`bigfish-ops: 工具 ${name} 的 access 必须是 'read' 或 'confirm'（收到 ${String(access)}）`)
  }
  if (spec.reason !== undefined && (typeof spec.reason !== 'string' || spec.reason.trim() === '')) {
    throw new TypeError(`bigfish-ops: 工具 ${name} 的 reason 必须是非空字符串`)
  }
  if (spec.writeWhen !== undefined && typeof spec.writeWhen !== 'function') {
    throw new TypeError(`bigfish-ops: 工具 ${name} 的 writeWhen 必须是函数`)
  }
  const normalized = {
    definition: { ...definition, timeoutMs: definition.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    access,
  }
  if (spec.reason !== undefined) normalized.reason = spec.reason
  if (spec.writeWhen !== undefined) normalized.writeWhen = spec.writeWhen
  return normalized
}

/**
 * 校验并规范化整组规格，同时检查重名（重名一律抛 TypeError，不做后者覆盖前者的隐式行为）。
 *
 * @param {unknown} specs - 规格数组。
 * @returns {Array<{definition: object, access: 'read'|'confirm', reason?: string, writeWhen?: Function}>} 规范化后的规格。
 */
export function normalizeSpecs(specs) {
  if (!Array.isArray(specs)) throw new TypeError('bigfish-ops: specs 必须是工具规格数组')
  const seen = new Set()
  return specs.map((spec) => {
    const normalized = normalizeSpec(spec)
    const name = normalized.definition.name
    if (seen.has(name)) throw new TypeError(`bigfish-ops: 工具名重复：${name}`)
    seen.add(name)
    return normalized
  })
}

/**
 * 由同一份 specs 生成「这次调用算不算写操作」的判定函数。
 *
 * 门禁监听与测试共用它，避免判定规则再散落一份：
 * - access==='read' 或不在 specs 里的工具 → 不需要确认；
 * - access==='confirm' 且没有 writeWhen → 永远需要确认；
 * - 有 writeWhen → 由它按参数判定；参数缺失/形态异常时由 writeWhen 返回 true（保守）。
 *
 * @param {Array<{definition: object, access: string, writeWhen?: Function}>} specs - 已规范化或 buildTools 产出的规格。
 * @returns {(name: string, args: unknown) => boolean} 判定函数，true 表示需要人工确认。
 */
export function buildWritePolicy(specs) {
  if (!Array.isArray(specs)) throw new TypeError('bigfish-ops: specs 必须是工具规格数组')
  const byName = new Map()
  for (const spec of specs) byName.set(spec?.definition?.name, spec)
  return function isWriteCall(name, args) {
    const spec = byName.get(name)
    if (spec === undefined || spec.access !== 'confirm') return false
    return spec.writeWhen === undefined ? true : spec.writeWhen(args) === true
  }
}

/**
 * 创建工具注册中间件。
 *
 * @param {{logger?: (line: string) => void, gate?: boolean}} [options] - logger 给一条注册摘要；gate=false 时不挂审批监听（沿用 writeGate 配置）。
 * @returns {{register: (ctx: object, specs: unknown) => {names: string[], counts: {read: number, confirm: number}, dispose: () => void}}} 中间件；dispose 同时解绑门禁监听与全部工具反注册器。
 */
export function createToolMiddleware({ logger, gate = true } = {}) {
  return {
    /**
     * 校验 → 注册工具 → 注册唯一一个门禁监听。
     *
     * 校验与宿主能力检查都放在产生副作用之前：非法 specs 不会注册半个插件。
     *
     * @param {object} ctx - Cordis 插件上下文（测试里用假 ctx）。
     * @param {unknown} specs - 工具规格数组。
     * @returns {{names: string[], counts: {read: number, confirm: number}, dispose: () => void}} 注册结果；dispose 解绑门禁监听并撤销全部工具。
     */
    register(ctx, specs) {
      const normalized = normalizeSpecs(specs)
      const tools = ctx?.tools
      if (tools === undefined || tools === null || typeof tools.register !== 'function') {
        throw new TypeError('bigfish-ops: 宿主 ctx 没有 tools.register()，无法注册工具')
      }
      if (gate && typeof ctx.on !== 'function') {
        throw new TypeError('bigfish-ops: 宿主 ctx 没有 on()，无法注册写操作审批门禁')
      }

      const names = []
      const counts = { read: 0, confirm: 0 }
      // 收好每个工具的反注册器：宿主 register() 返回一个精确 disposer（core/tools/src/index.ts:1027）。
      // 设置页关掉「是否启用」时用它把工具真的撤下来，省掉模型每轮的工具 schema 固定税。
      const toolDisposers = []
      for (const spec of normalized) {
        const unregister = ctx.tools.register(spec.definition)
        if (typeof unregister === 'function') toolDisposers.push(unregister)
        names.push(spec.definition.name)
        counts[spec.access] += 1
      }

      let gateDispose = () => {}
      if (gate) {
        const isWriteCall = buildWritePolicy(normalized)
        const byName = new Map(normalized.map((spec) => [spec.definition.name, spec]))
        gateDispose = ctx.on('tools/pre-execute', (exec, next) => {
          if (!isRecord(exec)) return next()
          if (!isWriteCall(exec.name, exec.arguments)) return next()
          const spec = byName.get(exec.name)
          return { kind: 'ask', reason: spec?.reason ?? defaultReason(exec.name) }
        })
        // 测试替换的 on() 可能返回 undefined：dispose 仍要是函数。
        if (typeof gateDispose !== 'function') gateDispose = () => {}
      }

      if (typeof logger === 'function') {
        logger(`工具注册完成：共 ${names.length} 个（read=${counts.read} / confirm=${counts.confirm}）`)
      }
      // 幂等：重复 dispose 不重复调用反注册器（真实宿主 disposer 多调一次通常无害，测试替身会 splice 到别的元素）。
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        gateDispose()
        for (const unregister of toolDisposers) unregister()
      }
      return { names, counts, dispose }
    },
  }
}
