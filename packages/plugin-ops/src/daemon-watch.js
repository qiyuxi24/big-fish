/**
 * rpc 桥的 daemon 掉线旁路：把「daemon 连不上」翻译成「宿主拉起一次 daemon」。
 *
 * 单独成文件的原因：daemon-supervisor.js 已经贴着 400 行上限（AGENTS §3），
 * 拉起策略与「检测到掉线」的接线逻辑分开更好读。
 *
 * 为什么不放在 client（面板）里：client bundle 不能 spawn 进程、不能读文件（AGENTS §4）；
 * 拉起 daemon 属于宿主侧动作，和工具、门禁同层。
 */

/**
 * 判断 rpc 结果是否是「daemon 连不上」。
 *
 * @param {unknown} result - bridge 的返回值。
 * @returns {boolean} 是否 NETWORK 失败。
 */
export function isNetworkFailure(result) {
  if (!isRecord(result) || result.ok !== false) return false
  const error = result.error
  return isRecord(error) && error.code === 'NETWORK'
}

/**
 * 给 rpc 桥加一层「daemon 掉线就拉起」的旁路：结果原样返回，只在 NETWORK 时触发一次 ensure。
 *
 * @param {{handle: Function}} bridge - createRpcBridge 的返回值。
 * @param {{ensure: Function}} supervisor - createDaemonSupervisor 的返回值。
 * @returns {object} 装饰后的桥（其余字段透传）。
 */
export function withDaemonWatch(bridge, supervisor) {
  if (!isRecord(bridge) || typeof bridge.handle !== 'function') {
    throw new TypeError('withDaemonWatch 需要带 handle 的 rpc 桥')
  }
  if (!isRecord(supervisor) || typeof supervisor.ensure !== 'function') {
    throw new TypeError('withDaemonWatch 需要带 ensure 的 supervisor')
  }
  async function handle(endpoint, payload, signal) {
    const result = await bridge.handle(endpoint, payload, signal)
    // 只对 NETWORK 触发：VALIDATION/审批类失败说明 daemon 在线，拉起只会白开一个进程。
    if (isNetworkFailure(result)) trigger(supervisor, 'rpc:' + String(endpoint).slice(0, 40))
    return result
  }
  return { ...bridge, handle }
}

/**
 * 后台拉起，不阻塞本次 rpc 响应。
 *
 * 为什么不等：宿主 rpc 路由有 15 秒上限，而拉起的就绪等待最长 20 秒（等待超时也要有结论）。
 * 若同步等，最坏情况是这条 rpc 被宿主判超时、面板看到的是另一种错误；
 * 而面板每 3 秒轮询一次，本次先返回「daemon 没起」，下一次轮询时进程已在就绪路上，自然变在线。
 *
 * @param {{ensure: Function}} supervisor - supervisor 实例。
 * @param {string} reason - 触发原因（写日志用）。
 * @returns {void}
 */
function trigger(supervisor, reason) {
  try {
    // ensure 内部已 catch；这里再兜「同步抛错」，绝不因为拉起失败污染 rpc 结果。
    const pending = supervisor.ensure(reason)
    if (pending && typeof pending.then === 'function') pending.then(noop, noop)
  } catch {
    // 拉起失败只影响下一次轮询，不影响本次响应。
  }
}

/** 吞掉 settle 结果（占位回调，保持返回值是 undefined）。 */
function noop() {}

/**
 * 窄化：非 null 的对象。
 *
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 是否为普通对象。
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null
}
