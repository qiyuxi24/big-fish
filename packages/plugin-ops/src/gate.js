/**
 * 写操作审批门禁。
 *
 * DSH 的 tools/pre-execute 是 waterfall：返回 {kind:'allow'|'deny'|'ask'} 或调 next()。
 * 本插件把所有"会真正写闲鱼/写凭据"的工具路由到人工确认：
 * - xy_task_enqueue：入队 publish/deliver/polish；
 * - xy_import_account：从本机 Chrome 读 cookie 并加密落盘；
 * - xy_publish_draft：只有 mode='enqueue' 才写队列，默认 dry-run 只读，放行；
 * - xy_publish_batch：同上口径，逐条入队批量发布草稿；
 * - xy_task_retry：把 failed / needs_review 任务重新排队（attempts 归零，会重放真实发布）。
 *
 * @module @bigfish/plugin-ops/gate
 */

/** 需要人工确认的工具名。 */
export const WRITE_TOOLS = new Set([
  'xy_task_enqueue',
  'xy_import_account',
  'xy_publish_draft',
  'xy_publish_batch',
  // 与 ack/fail/release 不同：retry 会重置重试预算并让 daemon 重放任务，真机（BF_PUBLISH_SUBMIT=1）就是再发一次发布。
  'xy_task_retry',
])

/** 每种写操作各自的确认原因；分开写是为了让人知道自己在批准什么。 */
const WRITE_REASONS = {
  xy_task_enqueue: '会入队写类任务（真机写闲鱼），需要人工确认。',
  xy_import_account: '会从本机 Chrome 读取闲鱼登录态 cookie 并加密落盘（写凭据），需要人工确认。',
  xy_publish_draft: '会把发布任务排进 daemon 队列（daemon 以 BF_PUBLISH_SUBMIT=1 启动时会真发布），需要人工确认。',
  xy_publish_batch: '会把一批发布任务排进 daemon 队列（daemon 以 BF_PUBLISH_SUBMIT=1 启动时会逐条真发布），需要人工确认。',
  xy_task_retry: '会把失败/待审任务重新排队并清零 attempts（daemon 以 BF_PUBLISH_SUBMIT=1 启动时会重放这次发布），需要人工确认。',
}

function isRecord(value) {
  return value !== null && typeof value === 'object'
}

/**
 * 判断一次调用是否属于写操作。
 *
 * @param {string} name - 工具名。
 * @param {unknown} args - 模型给的参数。
 * @returns {boolean} true 表示需要确认。
 */
export function isWriteCall(name, args) {
  if (!WRITE_TOOLS.has(name)) return false
  if (name === 'xy_task_enqueue' && isRecord(args)) {
    const kind = /** @type {{kind?: unknown}} */ (args).kind
    // 只读探针与 IM 回复不触碰商品数据，先不拦；发布/发货/擦亮都要确认。
    return kind === 'publish' || kind === 'deliver' || kind === 'polish'
  }
  if (name === 'xy_publish_draft' && isRecord(args)) {
    const mode = /** @type {{mode?: unknown}} */ (args).mode
    // 默认 dry-run：只读草稿文件并打印校准命令，不碰 daemon 写队列，无需审批。
    return mode !== undefined && mode !== 'dry-run'
  }
  if (name === 'xy_publish_batch' && isRecord(args)) {
    // 与 xy_publish_draft 同一口径：默认 dry-run 只读草稿（文件）并出计划，不写队列。
    const mode = /** @type {{mode?: unknown}} */ (args).mode
    return mode !== undefined && mode !== 'dry-run'
  }
  // 参数缺失时按保守方向处理：先问人，再让工具自己报 VALIDATION。
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
      reason: WRITE_REASONS[exec.name] ?? `${exec.name} 会写真实闲鱼数据，需要人工确认。`,
    }
  })
}
