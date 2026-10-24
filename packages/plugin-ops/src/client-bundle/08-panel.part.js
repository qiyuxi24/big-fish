    /**
     * 片段 08：面板骨架（tab 分发 + 面板级状态，切 tab 不丢输入）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /**
     * 当前 tab 的内容区：只在 `PANEL_TABS` 里查表，**不写 if 链**——
     * 加模块不会再出现「加了 tab 忘了分支」这类半死 tab。未知 id 回落到默认页，不渲染空白。
     */
    function PanelBody({ tab, copyProps, connection }) {
      const entry = PANEL_TABS.find(item => item.id === tab) ?? PANEL_TABS[0]
      return h(entry.component, entry.pickProps === undefined ? { connection } : entry.pickProps({ copyProps, connection }))
    }

    /** 面板骨架：页头 + 固定 tab 栏 + 唯一滚动的内容区。connection 由 apply 注入（模块级单实例）。 */
    function BigFishPanel() {
      const [tab, setTab] = React.useState(DEFAULT_TAB_ID)
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
      return h('div', { style: S.root, 'data-role': 'panel-root' },
        h('div', { style: S.header },
          h('div', { style: S.logo }, '🐟'),
          h('div', null,
            h('div', { style: S.title }, 'BigFish 闲鱼运营'),
            h('div', { style: S.subtitle }, '账号 → 采集 → 文案 → 发布 → 商品'))),
        // tab 栏在滚动区之外：滚到内容底部也能直接切模块。
        h(TabBar, { active: tab, onSelect: setTab }),
        h('div', { style: S.scroll, 'data-role': 'panel-scroll' },
          h('div', {
            style: S.content, role: 'tabpanel', id: tabPanelId(tab), 'aria-labelledby': tabDomId(tab),
          }, h(PanelBody, { tab, copyProps, connection: panelConnection }))))
    }

