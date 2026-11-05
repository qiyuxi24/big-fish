/**
 * 宿主设置页「是否启用」的 host 侧注册（守卫式，零依赖）。
 *
 * 三层开关不要混：
 *   1. cordis.yml 条目的 `disabled:` = 宿主插件列表里的总开关（dshmarket 已提供 UI，本模块不碰）；
 *   2. cordis.patch.yml 的 `config.enabled` = 装配层默认值，apply() 同步读取，可靠；
 *   3. 本模块注册的 `bigfish-ops` 命名空间 { enabled } = 运行时软开关，落 ~/.dsh/settings.yaml。
 *
 * 为什么守卫式：GitHub checkout 的 settings 服务在 0.1.5-rc.2 有 `register`，0.1.7（#677）
 * 删掉 register 改由 Config schema 推导；CLI / 测试替身则可能连 settings 服务都没有。
 * 任何一层缺失都只静默跳过，插件仍按 config.enabled 正常工作，绝不因设置页没起来而拖垮加载。
 *
 * @module @bigfish/plugin-ops/settings-host
 */
import { SETTINGS_NAMESPACE, makeEnabledSchema } from './settings-schema.js'

/**
 * 注册设置命名空间并把值投影回启用控制器。
 *
 * @param {object} ctx - Cordis 插件上下文（测试替身可能没有 inject）。
 * @param {{defaultValue: boolean, onEnabledChange: (enabled: boolean) => void, log?: (line: string) => void}} options
 *   defaultValue 来自 config.enabled；onEnabledChange 是 index.js 的实时开关；log 缺省用 console.log。
 * @returns {{registered: boolean, status: string}} status: skipped/deferred/registered/unavailable/failed。
 */
export function registerSettingsHost(ctx, { defaultValue, onEnabledChange, log = console.log }) {
  // 没有 inject（CLI / 测试替身）就不可能有设置页：保持插件原样，零额外副作用。
  if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') {
    return { registered: false, status: 'skipped' }
  }
  try {
    // 动态注入：不要求写进静态 inject 导出（apply.test 断言 inject === ['tools']）。
    ctx.inject(['settings'], (scoped) => {
      const service = scoped?.settings
      // 0.1.7 宿主（#677）只有 describe/update，没有 register：卡片由宿主自己按 Config 推导。
      if (service === undefined || typeof service.register !== 'function') return
      let scope
      try {
        scope = service.register(SETTINGS_NAMESPACE, makeEnabledSchema(defaultValue), {
          base: { enabled: defaultValue },
        })
      } catch (error) {
        logSettingsFailure(log, error)
        return
      }
      const project = () => {
        let value
        try {
          value = scope.get()
        } catch {
          // 服务正在重装配：保留当前状态，等下一次 watch 再投影，别把插件弄成半死。
          return
        }
        // 坏值已被 schema 的 live 调用挡掉；这里只防「值还没解析出来」。
        onEnabledChange(value?.enabled !== false)
      }
      project() // 首次立即投影：用户上次存过 false 时，本次加载就应该是关的。
      if (typeof scope.watch === 'function') scope.watch(project)
    })
    return { registered: true, status: 'deferred' }
  } catch (error) {
    logSettingsFailure(log, error)
    return { registered: false, status: 'failed' }
  }
}

/** 设置注册失败只告警：工具与面板照常可用，不能让设置页把插件拖下水。 */
function logSettingsFailure(log, error) {
  const message = error instanceof Error ? error.message : String(error)
  log(JSON.stringify({
    level: 'warn',
    plugin: 'bigfish-ops',
    msg: '宿主设置命名空间注册失败，「是否启用」卡片暂不可用（插件按 config.enabled 正常运行）',
    error: message,
  }))
}
