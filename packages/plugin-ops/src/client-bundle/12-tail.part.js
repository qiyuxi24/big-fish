    /**
     * 片段 12：连接句柄与 apply（只注册侧边栏栏位 + 主面板）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 当前连接句柄：apply 时从 ctx 取一次（服务由宿主注入；缺失则 null → 面板降级）。 */
    let panelConnection = null

    function apply(ctx) {
      panelConnection = readConnection(ctx)
      // 用 inject 而不是直接 register：slots 由宿主插件声明，早于声明注册会在加载期抛错。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'bigfish', order: 30, label: 'BigFish 闲鱼运营',
      }, BigFishIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'bigfish' }, BigFishPanel))
      // 宿主设置页卡片走 fiber inject 等可选的 settingsScope 服务（与 dshmarket 同款）。
      // 守卫：旧宿主 / CLI / 测试替身没有 ctx.inject 时整段跳过，绝不把侧边栏面板拖垮，
      // 也让 client-bundle.test 的「只注册 sidebar.panellist + main」断言继续成立。
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['settingsScope'], (scoped) => {
            const service = readSettingsScope(scoped)
            if (service === null || scoped.slots === undefined) return
            const scope = service.bind({ namespace: SETTINGS_NS })
            scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
              name: 'settings.plugin.item', key: SETTINGS_NS,
            }, () => h(BigFishSettingsCard, { scope })))
          })
        } catch (error) {
          // 设置页是可选增强：任何异常都只让卡片缺席，不波及侧边栏主面板；但要留痕，不静默吞。
          console.warn('bigfish: 设置卡片注册失败（侧边栏不受影响）', error instanceof Error ? error.message : String(error))
        }
      }
    }
    return { apply, inject: ['slots', 'connection'] }
  },
})