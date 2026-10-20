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
  console.log(JSON.stringify({
    level: 'info',
    plugin: name,
    msg: 'bigfish-ops 已加载',
    tools: tools.map(tool => tool.name),
    daemonUrl: resolved.daemonUrl,
    writeGate: resolved.writeGate,
  }))
}
