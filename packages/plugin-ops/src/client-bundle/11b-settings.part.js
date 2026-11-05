    /**
     * 片段 11b：宿主设置页「BigFish 是否启用」卡片（settings.plugin.item，key=bigfish-ops）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     *
     * 为什么走宿主设置页而不是侧边栏：用户 2026-11-05 拍板「宿主设置页插件卡片」。
     * host 侧（src/settings-host.js）注册同名命名空间 bigfish-ops，client 侧按同 key 注册卡片，
     * 两者交集才显示（DSH ui-settings-plugins 的约束）。settingsScope 是可选服务：旧宿主 / CLI /
     * 测试替身没有它时整段跳过，不影响侧边栏面板。决策见 docs/adr/0007。
     */
    /** 与 host 的 SETTINGS_NAMESPACE 逐字一致；client 物理隔离拿不到 host 常量，只能复制一份。 */
    const SETTINGS_NS = 'bigfish-ops'

    /** 守卫式读 settingsScope 服务：缺失返回 null，绝不因设置页把侧边栏拖垮。 */
    function readSettingsScope(ctx) {
      try {
        const service = ctx === null || ctx === undefined ? undefined : ctx.settingsScope
        if (service === null || service === undefined || typeof service.bind !== 'function') return null
        return service
      } catch { return null }
    }

    /** 取一次快照；坏值按「未就绪」处理，不假装知道开关状态。 */
    function settingsSnapshot(scope) {
      try {
        const snapshot = scope.getSnapshot()
        return snapshot !== null && typeof snapshot === 'object' ? snapshot : {}
      } catch { return {} }
    }

    /** 当前是否启用：value.enabled 明确是 false 才算关，其余（含缺失）按装配层默认开。 */
    function settingsEnabled(snapshot) {
      const value = snapshot.value
      return !(value !== null && typeof value === 'object' && value.enabled === false)
    }

    /**
     * 设置卡片：一个布尔开关，点一下就通过 settingsScope.mutate 写回 ~/.dsh/settings.yaml。
     * 订阅 scope 变化刷新显示；未 ready / 不可写时禁用按钮并说明原因（不静默）。
     */
    function BigFishSettingsCard(props) {
      const scope = props.scope
      const [snapshot, setSnapshot] = React.useState(settingsSnapshot(scope))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        if (typeof scope.subscribe !== 'function') return undefined
        return scope.subscribe(() => setSnapshot(settingsSnapshot(scope)))
      }, [scope])
      const enabled = settingsEnabled(snapshot)
      const ready = snapshot.status === 'ready'
      const writable = ready && snapshot.writable === true
      const toggle = () => {
        if (busy || !writable || typeof scope.mutate !== 'function') return
        const next = !enabled
        const revision = snapshot.revision
        setBusy(true)
        setError('')
        Promise.resolve()
          .then(() => scope.mutate([{ op: 'set', path: ['enabled'], value: next }], revision))
          .then(() => { setBusy(false); setSnapshot(settingsSnapshot(scope)) })
          .catch((failure) => { setBusy(false); setError(failure instanceof Error ? failure.message : String(failure)) })
      }
      return h('li', { 'data-role': 'bigfish-settings-card' },
        h('div', { style: { fontWeight: 600 } }, 'BigFish 闲鱼运营'),
        h('p', { style: { margin: '4px 0', opacity: 0.75 } },
          '关闭后本插件不再注册任何 xy_* 工具与写操作审批门禁，也不再占用每轮会话的工具定义 token；后台 daemon 桥接不受影响。'),
        h('button', {
          type: 'button',
          'data-role': 'bigfish-enabled-toggle',
          disabled: busy || !writable,
          onClick: toggle,
        }, busy ? '保存中…' : (enabled ? '已启用 · 点击停用' : '已停用 · 点击启用')),
        !writable ? h('p', { style: { opacity: 0.7 } }, '设置服务未就绪或不可写，暂时无法切换。') : null,
        error === '' ? null : h('p', { style: { opacity: 0.85 } }, '保存失败：' + error),
      )
    }
