    /**
     * 片段 05：「文案」tab 与面板 tab 栏。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 「文案」tab：选品类 → 勾信息 → 选风格 → 生成请求（不调模型、不写库、不碰 daemon 写）。 */
    function CopyStudio(props) {
      const { template, form, fields, ready, request, submitted } = props
      const commonFields = fields.filter(field => field.group !== 'specs')
      const specFields = fields.filter(field => field.group === 'specs')
      const rows = list => list.map(field => h(CopyFieldRow, {
        key: field.id, field, picked: fieldPicked(field, form), value: form.values[field.id],
        onToggle: props.onToggle, onChange: props.onValue,
      }))
      const pickedSpecs = specFields.filter(field => fieldPicked(field, form)).length
      return h('div', null,
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '品类'),
          h('div', { style: S.chipRow }, ...template.data.categories.map(category => h('button', {
            key: category.id, type: 'button', 'data-role': 'copy-category', 'data-category': category.id,
            'aria-pressed': category.id === form.categoryId,
            onClick: () => props.onCategory(category.id),
            style: category.id === form.categoryId ? { ...S.chip, ...S.chipActive } : S.chip,
          }, category.label))),
          template.phase === 'offline'
            ? h('div', { style: S.warnText }, '品类模板没拉到：先用通用字段。')
            : h('div', { style: S.sectionHint }, '已选 ' + String(pickedSpecs) + '/' + String(specFields.length) + ' 项规格')),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '写进文案的信息'),
          h('div', { style: S.fieldRow }, ...rows(commonFields)),
          specFields.length === 0 ? null : h('div', { style: S.fieldRow }, ...rows(specFields)),
          h('div', { style: S.buttonRow },
            h('button', { type: 'button', 'data-role': 'copy-pick-all', onClick: () => props.onPickAll(), style: S.button }, '全选'),
            h('button', { type: 'button', 'data-role': 'copy-clear', onClick: () => props.onClear(), style: S.button }, '清空'))),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '文案风格'),
          h(StylePicker, { styleId: form.styleId, onStyle: props.onStyle })),
        h('div', { style: S.section },
          h('div', { style: S.buttonRow },
            h('button', {
              type: 'button', 'data-role': 'copy-submit', disabled: !ready,
              title: ready ? '按当前品类/勾选/风格组装 xy_copy_plan 参数' : '先填商品名与价格（元）',
              onClick: () => props.onSubmit(), style: ready ? S.primary : S.offButton,
            }, '生成文案请求'),
            h('span', { style: S.sectionHint }, ready ? '产出的是工具参数，不是文案' : '填商品名与价格后可生成')),
          submitted ? h(CopyPlanPreview, { request }) : null))
    }
    /** 面板 tab 与内容区的 DOM id：tabpanel 与 tab 用 aria-labelledby / aria-controls 双向关联。 */
    const tabDomId = id => 'bigfish-tab-' + id
    const tabPanelId = id => 'bigfish-panel-' + id
    /** tab 栏：按 PANEL_TABS 的 group 分段，组名以小字前置（侧边栏窄时整条换行，不裁切）。 */
    function TabBar({ active, onSelect }) {
      const groups = []
      for (const tab of PANEL_TABS) {
        const last = groups[groups.length - 1]
        if (last === undefined || last.group !== tab.group) groups.push({ group: tab.group, tabs: [tab] })
        else last.tabs.push(tab)
      }
      return h('div', { role: 'tablist', 'aria-label': 'BigFish 面板分区', style: S.tabBar },
        ...groups.map(entry => h('div', { key: entry.group, style: S.tabGroup, 'data-role': 'panel-tab-group', 'data-group': entry.group },
          h('span', { style: S.tabGroupLabel, 'aria-hidden': 'true' }, entry.group),
          ...entry.tabs.map(tab => h('button', {
            key: tab.id, type: 'button', role: 'tab', id: tabDomId(tab.id), 'aria-controls': tabPanelId(tab.id),
            'data-role': 'panel-tab', 'data-tab': tab.id,
            'aria-selected': tab.id === active, onClick: () => onSelect(tab.id),
            style: tab.id === active ? { ...S.tab, ...S.tabActive } : S.tab,
          }, tab.label)))))
    }

