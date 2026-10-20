/**
 * 写操作审批门禁。
 *
 * DSH 的 tools/pre-execute 是 waterfall：返回 {kind:'allow'|'deny'|'ask'} 或调 next()。
 * 本插件把所有"会真正写闲鱼"的工具路由到人工确认；P0 阶段只有入队写类任务会触发，
 * 未来接入 xy_publish / xy_deliver 时把它们加进 WRITE_TOOLS 即可。
 *
 * @module @bigfish/plugin-ops/gate
 */

/** 需要人工确认的工具名。 */
export const WRITE_TOOLS = new Set(['xy_task_enqueue'])

/**
 * 判断一次调用是否属于写操作。
 *
 * @param {string} name - 工具名。
 * @param {unknown} args - 模型给的参数。
 * @returns {boolean} true 表示需要确认。
 */
export function isWriteCall(name, args) {
  if (!WRITE_TOOLS.has(name)) return false
  if (name === 'xy_task_enqueue' && args !== null && typeof args === 'object') {
    const kind = /** @type {{kind?: unknown}} */ (args).kind
    // 只读探针与 IM 回复不触碰商品数据，先不拦；发布/发货/擦亮都要确认。
    return kind === 'publish' || kind === 'deliver' || kind === 'polish'
  }
  return true
}

/**
 * 注册门禁监听器，返回 disposer（Cordis 在插件卸载时会回收 ctx 上的监听，
 * 但测试需要手动解绑，所以照样把 disposer 返回出去）。
 *
 * @param {object} ctx - Cordis 插件上下文（测试里用假 ctx）。
 * @param {{enabled?: boolean}} [options] - enabled=false 时不注册门禁。
 * @returns {() => void} 解绑函数。
 */
export function registerWriteGate(ctx, options = {}) {
  const enabled = options.enabled ?? true
  if (!enabled) return () => {}
  if (typeof ctx?.on !== 'function') {
    throw new TypeError('bigfish-ops: 宿主 ctx 没有 on()，无法注册写操作审批门禁')
  }
  return ctx.on('tools/pre-execute', (exec, next) => {
    if (!isWriteCall(exec?.name, exec?.arguments)) return next()
    return {
      kind: 'ask',
      reason: `${exec.name} 会入队写类任务（真机写闲鱼），需要人工确认。`,
    }
  })
}
