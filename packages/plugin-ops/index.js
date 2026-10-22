/**
 * BigFish 运营插件（Cordis 插件形态，零依赖纯 ESM）。
 *
 * 职责边界：
 * - 本插件只做「模型 ↔ 本地 daemon」的桥：注册 xy_* 工具、给写操作挂审批门禁。
 * - 不直接访问闲鱼、不持有闲鱼凭据、不跑常驻轮询——这些都在 @bigfish/daemon 里，
 *   这样关掉 DSH/Electron 后 daemon 仍能继续跑，日常动作也不消耗模型 token。
 *
 * @module @bigfish/plugin-ops
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startAlertWatcher } from './src/alert-watch.js'
import { createDaemonClient } from './src/client.js'
import { normalizeConfig } from './src/config.js'
import { createDaemonSupervisor } from './src/daemon-supervisor.js'
import { withDaemonWatch } from './src/daemon-watch.js'
import { registerWriteGate } from './src/gate.js'
import { createPanelRoute } from './src/host-route.js'
import { RPC_CHANNEL, createRpcBridge } from './src/rpc.js'
import { buildTools } from './src/tools.js'

/** Cordis 插件名，loader 诊断与 cordis.patch.yml 的 id 都靠它定位。 */
export const name = 'bigfish-ops'

/** 插件自身版本，xy_ping 会展示；与 package.json 手动保持一致。 */
export const version = '0.0.0'

/**
 * 依赖的 DSH 服务：注册工具必须声明 `tools`（Cordis 在未声明 inject 时拒绝读取服务属性）。
 * 事件总线（ctx.on）不需要 inject。
 */
export const inject = ['tools']

/**
 * 插件入口。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {Record<string, unknown>} [config] - cordis.patch.yml 中该行的 config。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config, ctx)
  const client = createDaemonClient(resolved)
  const tools = buildTools({ client, config: resolved, version })
  for (const definition of tools) {
    // register 的实现内部用 ctx 的 effect 登记，插件卸载时会自动解绑。
    ctx.tools.register(definition)
  }
  registerWriteGate(ctx, { enabled: resolved.writeGate })
  // 面板实时数据/写动作走宿主 rpc 通道；通道不存在时工具照常可用，面板退回静态说明（不阻断加载）。
  // 面板连不上 daemon（NETWORK）时由宿主自动拉起一个：用户不必先手动 pnpm daemon:start。
  const supervisor = createDaemonSupervisor({
    enabled: resolved.autoStartDaemon,
    daemonUrl: resolved.daemonUrl,
    dataDir: resolved.dataDir,
    tokenPath: resolved.tokenPath,
    nodePath: resolved.nodePath,
    daemonEntry: resolved.daemonEntry,
    pluginDir: dirname(fileURLToPath(import.meta.url)),
    log: (line) => console.log(line),
  })
  const bridge = withDaemonWatch(createRpcBridge({ client, supervisor }), supervisor)
  const rpcChannel = registerRpcChannel(ctx, bridge)
  // 异常唤醒：发布失败/待复核时把摘要推回当前会话（走 agent.followup，不调 LLM 做判断）。
  // 没有活着的 agent 时只注册监听、不轮询，等 agent/created 再开——避免拉起一堆空转定时器。
  const alerts = startAlerts(ctx, client, resolved)
  // 加载日志保持一条：面板 rpc 状态作为字段带出，便于按行 grep 且不打断 apply.test 的断言。
  console.log(JSON.stringify({
    level: 'info',
    plugin: name,
    msg: 'bigfish-ops 已加载',
    tools: tools.map(tool => tool.name),
    daemonUrl: resolved.daemonUrl,
    writeGate: resolved.writeGate,
    autoStartDaemon: resolved.autoStartDaemon,
    rpcChannel,
    alerts: describeAlerts(alerts),
  }))
}

/**
 * 启动异常唤醒轮询；配置关掉时返回 undefined。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {{listEvents: Function}} client - daemon 客户端。
 * @param {{enableAlerts: boolean}} config - 已规范化的插件配置。
 * @returns {{stop: Function, active: Function, pollNow: Function} | undefined} 控制器。
 */
function startAlerts(ctx, client, config) {
  if (config.enableAlerts !== true) return undefined
  const watcher = startAlertWatcher({ ctx, client, log: (line) => console.log(line) })
  // 插件卸载时停轮询：不留一个对着已销毁 ctx 的定时器。
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => watcher.stop(), 'bigfish: 异常唤醒轮询')
    } catch {
      // 测试替身的 effect 语义可能不同：停不掉也不影响本次加载。
    }
  }
  return watcher
}

/**
 * 加载日志里的告警状态：active / waiting-for-agent / disabled。
 *
 * @param {{active?: Function} | undefined} watcher - startAlerts 的返回值。
 * @returns {string} 状态文案。
 */
function describeAlerts(watcher) {
  if (watcher === undefined) return 'disabled'
  return typeof watcher.active === 'function' && watcher.active() ? 'active' : 'waiting-for-agent'
}

/**
 * 读取 Cordis 服务。Cordis 对未 inject 的服务读取会抛错，
 * 所以优先用 ctx.get（反射读取不触发 inject 约束），再退回属性读取并兜异常。
 *
 * @param {object} ctx - Cordis 插件上下文或测试替身。
 * @param {string} name - 服务名（connection / webServer）。
 * @returns {object | undefined} 服务（未就绪时为 undefined）。
 */
function readService(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') {
    const service = ctx.get(name)
    if (service !== undefined) return service
  }
  try {
    return ctx[name]
  } catch {
    // 没有该服务的宿主（CLI/测试）会在访问时抛 inject 错误：视作「服务不可用」而不是加载失败。
    return undefined
  }
}

/**
 * 读取 connection 服务。
 *
 * @param {object} ctx - Cordis 插件上下文或测试替身。
 * @returns {{rpc?: {handle?: Function}, requestRejection?: Function} | undefined} connection 服务（未就绪时为 undefined）。
 */
function readConnection(ctx) {
  return readService(ctx, 'connection')
}

/**
 * 挂载 /bigfish rpc 通道。返回 'registered' | 'deferred' | 'skipped' | 'failed' | 'registered-webServer'，只写进加载日志。
 *
 * 回退顺序：先走宿主官方通道（宿主修好 bug 后自动走正路），失败/缺失再退回插件自己的
 * webServer 兼容路由（见 src/host-route.js）。两条路都不通时面板保持降级，不阻断插件加载。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {{handle: Function}} bridge - createRpcBridge 的返回值。
 * @returns {string} 通道状态。
 */
function registerRpcChannel(ctx, bridge) {
  // Cordis 的服务可能在插件 apply 时还没就绪：用 ctx.inject 等 connection 出现再挂。
  if (typeof ctx.inject === 'function') {
    let status = 'deferred'
    try {
      ctx.inject(['connection'], (injected) => {
        status = mountPanelChannel(injected, bridge)
      })
    } catch (error) {
      logRpcFailure(error)
      return 'failed'
    }
    return status
  }
  return mountPanelChannel(ctx, bridge)
}

/**
 * 先官方通道、再兼容路由地挂载面板 rpc。
 *
 * @param {object} context - 已注入 connection 的插件上下文。
 * @param {{handle: Function}} bridge - createRpcBridge 的返回值。
 * @returns {string} 通道状态。
 */
function mountPanelChannel(context, bridge) {
  const official = mountOfficialChannel(context, bridge)
  if (official.status === 'registered') return 'registered'
  const fallback = mountCompatibleRoute(context, bridge)
  if (fallback.status === 'registered') return 'registered-webServer'
  // 真实 Cordis 里嵌套 inject 是异步的：这里还不能判定失败，交给后续回调打成功/失败日志。
  if (fallback.status === 'deferred') return 'deferred'
  if (fallback.status === 'failed') logRouteFailure(fallback.error)
  if (official.status === 'failed') {
    // 两条路都不通才把宿主错误抬到日志：能绕开时不让「面板不可用」的告警误导排障。
    logRpcFailure(official.error)
    return 'failed'
  }
  return 'skipped'
}

/**
 * 走宿主 connection.rpc.handle（官方通道）。返回 {status, error?}。
 *
 * @param {object} context - 插件上下文。
 * @param {{handle: Function}} bridge - createRpcBridge 的返回值。
 * @returns {{status: string, error?: unknown}} 挂载结果。
 */
function mountOfficialChannel(context, bridge) {
  const rpc = readConnection(context)?.rpc
  if (rpc === undefined || typeof rpc.handle !== 'function') return { status: 'skipped' }
  try {
    // 用 effect 登记：插件卸载时随 effect 一起解绑（Cordis 的清理语义）。
    if (typeof context.effect === 'function') {
      context.effect(() => rpc.handle(RPC_CHANNEL, bridge.handle), 'bigfish: ' + RPC_CHANNEL + ' rpc 通道')
    } else {
      rpc.handle(RPC_CHANNEL, bridge.handle)
    }
    return { status: 'registered' }
  } catch (error) {
    return { status: 'failed', error }
  }
}

/**
 * 回退方案：inject webServer 后自建 prefix 路由（DSH 0.1.5-rc.2 宿主 bug 的插件侧绕过）。
 *
 * @param {object} context - 插件上下文。
 * @param {{handle: Function}} bridge - createRpcBridge 的返回值。
 * @returns {{status: string, error?: unknown}} 挂载结果。
 */
function mountCompatibleRoute(context, bridge) {
  if (typeof context.inject !== 'function') return { status: 'skipped' }
  let status = 'deferred'
  try {
    // 与宿主 connection 插件自己拿 webServer 的方式一致：子 fiber 里注入，随插件卸载级联释放。
    context.inject(['webServer', 'connection'], (webCtx) => {
      status = mountWebServerRoute(webCtx, bridge)
    })
  } catch (error) {
    return { status: 'failed', error }
  }
  return { status }
}

/**
 * 在已注入 webServer 的上下文里注册兼容路由；缺少鉴权入口时 fail-closed（宁可不注册）。
 *
 * @param {object} webCtx - 已注入 webServer/connection 的上下文。
 * @param {{handle: Function}} bridge - createRpcBridge 的返回值。
 * @returns {string} 挂载结果。
 */
function mountWebServerRoute(webCtx, bridge) {
  const webServer = readService(webCtx, 'webServer')
  const connection = readConnection(webCtx)
  if (webServer === undefined || typeof webServer.register !== 'function') return 'skipped'
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    // 有 webServer 却没有鉴权入口：宁可面板降级，也不能无鉴权暴露 daemon 数据。
    logRouteUnavailable()
    return 'skipped'
  }
  let route
  try {
    route = createPanelRoute({ channel: RPC_CHANNEL, bridge, connection, onInternalError: logRouteFailure })
  } catch (error) {
    logRouteFailure(error)
    return 'failed'
  }
  try {
    // effect 保证插件卸载时反注册路由；没有 effect 的测试替身直接注册。
    if (typeof webCtx.effect === 'function') {
      webCtx.effect(() => webServer.register(route), 'bigfish: ' + RPC_CHANNEL + ' webServer 兼容路由')
    } else {
      webServer.register(route)
    }
    logRouteActive()
    return 'registered'
  } catch (error) {
    logRouteFailure(error)
    return 'failed'
  }
}

/**
 * 通道注册失败只告警：面板降级，但工具/门禁必须照常可用。
 * DSH 0.1.5-rc.2 有一个已知宿主 bug（connection 插件用自己 ctx 注册 webServer），
 * 命中时补一句指向 ADR，免得把宿主问题当成插件坏掉。见 docs/adr/0004-client-host-rpc.md。
 */
function logRpcFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  const hostBug = message.includes('webServer')
  console.log(JSON.stringify({
    level: 'warn',
    plugin: name,
    msg: hostBug
      ? 'bigfish 面板 rpc 通道注册失败：命中 DSH 已知宿主 bug（connection 插件未 inject webServer），面板实时数据暂不可用（工具不受影响）；修法见 docs/adr/0004-client-host-rpc.md'
      : 'bigfish 面板 rpc 通道注册失败，面板实时数据暂不可用（工具不受影响）',
    error: message,
  }))
}

/** 兼容路由启用成功：单独一条 info，便于在日志里确认「宿主 bug 已被绕开」。 */
function logRouteActive() {
  console.log(JSON.stringify({
    level: 'info',
    plugin: name,
    msg: '面板 rpc 通道已启用 webServer 兼容路由（绕过 DSH 已知宿主 bug：connection 插件未 inject webServer）',
    rpcChannel: 'registered-webServer',
    hostBug: true,
  }))
}

/** 有 webServer 但缺鉴权入口：拒绝注册，并把原因写清楚（fail-closed，不静默）。 */
function logRouteUnavailable() {
  console.log(JSON.stringify({
    level: 'warn',
    plugin: name,
    msg: '面板 rpc 兼容路由未启用：宿主的 connection 没有 requestRejection，拒绝在无鉴权下暴露 daemon 数据（面板保持降级）',
  }))
}

/** 兼容路由注册或处理请求失败：只告警，不影响工具与门禁。 */
function logRouteFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  console.log(JSON.stringify({
    level: 'warn',
    plugin: name,
    msg: '面板 rpc 兼容路由失败（面板实时数据暂不可用，工具不受影响）',
    error: message,
  }))
}
