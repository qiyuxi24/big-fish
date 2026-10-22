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
import { createDaemonClient } from './src/client.js'
import { normalizeConfig } from './src/config.js'
import { registerWriteGate } from './src/gate.js'
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
  const rpcChannel = registerRpcChannel(ctx, createRpcBridge({ client }))
  // 加载日志保持一条：面板 rpc 状态作为字段带出，便于按行 grep 且不打断 apply.test 的断言。
  console.log(JSON.stringify({
    level: 'info',
    plugin: name,
    msg: 'bigfish-ops 已加载',
    tools: tools.map(tool => tool.name),
    daemonUrl: resolved.daemonUrl,
    writeGate: resolved.writeGate,
    rpcChannel,
  }))
}

/**
 * 读取 connection 服务。Cordis 对未 inject 的服务读取会抛错，
 * 所以优先用 ctx.get（反射读取不触发 inject 约束），再退回属性读取并兜异常。
 *
 * @param {object} ctx - Cordis 插件上下文或测试替身。
 * @returns {{rpc?: {handle?: Function}} | undefined} connection 服务（未就绪时为 undefined）。
 */
function readConnection(ctx) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') {
    const connection = ctx.get('connection')
    if (connection !== undefined) return connection
  }
  try {
    return ctx.connection
  } catch {
    // 没有 connection 的宿主（CLI/测试）会在访问时抛 inject 错误：视作「通道不可用」而不是加载失败。
    return undefined
  }
}

/**
 * 挂载 /bigfish rpc 通道。返回 'registered' | 'deferred' | 'skipped' | 'failed'，只写进加载日志。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {{handle: Function}} bridge - createRpcBridge 的返回值。
 * @returns {string} 通道状态。
 */
function registerRpcChannel(ctx, bridge) {
  const mount = (context) => {
    const rpc = readConnection(context)?.rpc
    if (rpc === undefined || typeof rpc.handle !== 'function') return 'skipped'
    try {
      // 用 effect 登记：插件卸载时随 effect 一起解绑（Cordis 的清理语义）。
      if (typeof context.effect === 'function') {
        context.effect(() => rpc.handle(RPC_CHANNEL, bridge.handle), 'bigfish: ' + RPC_CHANNEL + ' rpc 通道')
      } else {
        rpc.handle(RPC_CHANNEL, bridge.handle)
      }
      return 'registered'
    } catch (error) {
      logRpcFailure(error)
      return 'failed'
    }
  }
  // Cordis 的服务可能在插件 apply 时还没就绪：用 ctx.inject 等 connection 出现再挂。
  if (typeof ctx.inject === 'function') {
    let status = 'deferred'
    try {
      ctx.inject(['connection'], (injected) => {
        status = mount(injected)
      })
    } catch (error) {
      logRpcFailure(error)
      return 'failed'
    }
    return status
  }
  return mount(ctx)
}

/** 通道注册失败只告警：面板降级，但工具/门禁必须照常可用。 */
function logRpcFailure(error) {
  console.log(JSON.stringify({
    level: 'warn',
    plugin: name,
    msg: 'bigfish 面板 rpc 通道注册失败，面板实时数据暂不可用（工具不受影响）',
    error: error instanceof Error ? error.message : String(error),
  }))
}
