    /**
     * 片段 08：面板骨架（tab 分发 + 面板级状态，切 tab 不丢输入）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 当前 tab 的内容区；copy 页的状态留在 Panel 里（切走再切回不丢输入）。 */
    function PanelBody({ tab, copyProps, connection }) {
      if (tab === 'publish-batch') return h(PublishBatchView, { connection })
      if (tab === 'account') return h(AccountView, { connection })
      if (tab === 'copy') return h(CopyStudio, copyProps)
      if (tab === 'reference') return h(ReferenceView, { connection })
      if (tab === 'diagnose') return h(DiagnoseTab, { connection })
      return h('div', { style: S.section },
        h('div', { style: S.sectionHint }, '登录态导入：xy_import_account（本机 Chrome → 加密凭据）；daemon：127.0.0.1:47001（前台进程）。'),
        h('div', { style: S.cmdRow }, h('code', { style: S.cmdCode }, 'npm run daemon:import-account'), h('code', { style: S.cmdCode }, 'npm run daemon')))
    }

    /** 面板骨架：顶部 tab + 内容区 + 门禁说明。connection 由 apply 注入（模块级单实例）。 */
    function BigFishPanel() {
      const [tab, setTab] = React.useState(PANEL_TABS[0].id)
      const [template, setTemplate] = React.useState({ phase: 'loading', data: FALLBACK_TEMPLATE })
      const [copyForm, setCopyForm] = React.useState({
        categoryId: 'digital', styleId: COPY_STYLE_OPTIONS[0].id,
        picked: {}, values: { condition: 'like-new', shipping: 'free' }, submitted: false,
      })
      // 品类模板只拉一次（纯常量、不轮询）；失败就用兜底模板，面板照常可用。
      React.useEffect(() => {
        let alive = true
        void callRead(panelConnection, 'copy.templates').then(reply => {
          if (!alive) return
          const ok = reply.ok && isTemplateShape(reply.value)
          setTemplate({ phase: ok ? 'ok' : 'offline', data: ok ? reply.value : FALLBACK_TEMPLATE })
        })
        return () => { alive = false }
      }, [])
      const fields = fieldsOfTemplate(template.data, copyForm.categoryId)
      const name = copyForm.values.productName, price = copyForm.values.priceYuan
      const ready = typeof name === 'string' && name.trim() !== '' && typeof price === 'string' && price.trim() !== ''
      // 任一输入变化都撤销「已就绪」，避免拿着旧参数去生成。
      const patch = next => setCopyForm(previous => ({ ...previous, ...next, submitted: false }))
      const copyProps = {
        template, form: copyForm, fields, ready,
        request: buildCopyPlanArguments(copyForm, fields),
        submitted: copyForm.submitted,
        onCategory: id => patch({ categoryId: id }),
        onStyle: id => patch({ styleId: id }),
        onToggle: (id, checked) => setCopyForm(previous => ({ ...previous, submitted: false, picked: { ...previous.picked, [id]: checked } })),
        onValue: (id, value) => setCopyForm(previous => ({ ...previous, submitted: false, values: { ...previous.values, [id]: value } })),
        onPickAll: () => setCopyForm(previous => ({ ...previous, submitted: false, picked: allPicked(fields) })),
        onClear: () => setCopyForm(previous => ({ ...previous, submitted: false, picked: clearedPicked(fields) })),
        onSubmit: () => setCopyForm(previous => ({ ...previous, submitted: true })),
      }
      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', { style: S.logo }, '🐟'),
          h('div', null,
            h('div', { style: S.title }, 'BigFish 闲鱼运营'),
            h('div', { style: S.subtitle }, '发布 / 账号 / 文案 / 采集 · 面板只组参数，执行交给 agent 与 daemon'))),
        h(TabBar, { active: tab, onSelect: setTab }),
        h(PanelBody, { tab, copyProps, connection: panelConnection }))
    }

