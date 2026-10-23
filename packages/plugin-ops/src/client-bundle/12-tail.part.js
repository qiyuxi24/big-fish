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
    }
    return { apply, inject: ['slots', 'connection'] }
  },
})