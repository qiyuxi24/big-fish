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
          h('div', { style: S.sectionTitle }, '① 品类（决定问哪些信息）'),
          h('div', { style: S.chipRow }, ...template.data.categories.map(category => h('button', {
            key: category.id, type: 'button', 'data-role': 'copy-category', 'data-category': category.id,
            'aria-pressed': category.id === form.categoryId,
            onClick: () => props.onCategory(category.id),
            style: category.id === form.categoryId ? { ...S.chip, ...S.chipActive } : S.chip,
          }, category.label))),
          template.phase === 'offline'
            ? h('div', { style: S.warnText }, '品类模板没拉到（daemon 未启动或插件是旧版）：先用通用字段，规格等连上后台再填。')
            : h('div', { style: S.sectionHint }, '已选 ' + String(pickedSpecs) + '/' + String(specFields.length) + ' 项规格；未勾选的字段不会出现在提示词里。')),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '② 勾选要写进文案的信息'),
          h('div', { style: S.fieldRow }, ...rows(commonFields)),
          specFields.length === 0 ? null : h('div', { style: S.fieldRow }, ...rows(specFields)),
          h('div', { style: S.buttonRow },
            h('button', { type: 'button', 'data-role': 'copy-pick-all', onClick: () => props.onPickAll(), style: S.button }, '全选'),
            h('button', { type: 'button', 'data-role': 'copy-clear', onClick: () => props.onClear(), style: S.button }, '清空勾选'))),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '③ 文案风格（skill 注入）'),
          h(StylePicker, { styleId: form.styleId, onStyle: props.onStyle })),
        h('div', { style: S.section },
          h('div', { style: S.buttonRow },
            h('button', {
              type: 'button', 'data-role': 'copy-submit', disabled: !ready,
              title: ready ? '按当前品类/勾选/风格组装 xy_copy_plan 请求' : '先填商品名与价格（元）',
              onClick: () => props.onSubmit(), style: ready ? S.primary : S.button,
            }, '生成文案请求'),
            h('span', { style: S.sectionHint }, ready ? '生成的是工具参数，不是文案；拿到后由 agent 按 skill 出稿。' : '商品名与价格都填了才能生成（价格用于校验，不写进标题）。')),
          h('div', { style: S.sectionHint }, '图片：面板暂不能选文件（素材库接入前在对话里给本机绝对路径）；出稿后先 dry-run，再让 agent 跑 xianyu-listing-audit 自检。'),
          submitted ? h(CopyPlanPreview, { request }) : null))
    }
    function TabBar({ active, onSelect }) {
      return h('div', { role: 'tablist', 'aria-label': 'BigFish 面板分区', style: S.tabBar },
        ...PANEL_TABS.map(tab => h('button', {
          key: tab.id, type: 'button', role: 'tab', 'data-role': 'panel-tab',
          'aria-selected': tab.id === active, onClick: () => onSelect(tab.id),
          style: tab.id === active ? { ...S.tab, ...S.tabActive } : S.tab,
        }, tab.label)))
    }

