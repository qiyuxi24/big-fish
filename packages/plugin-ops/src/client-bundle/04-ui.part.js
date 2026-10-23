    /**
     * 片段 04：通用小组件（图标、风格芯片、带标签字段、字段勾选行、请求预览）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 侧边栏栏位图标。 */
    function BigFishIcon({ size, active }) {
      return h('span', {
        style: { ...ICON_STYLE, fontSize: String(Math.max(12, size)) + 'px', opacity: active ? 1 : 0.72 },
        'aria-hidden': 'true',
      }, '🐟')
    }
    /** 风格选择：一行芯片，选中态用 aria-pressed 与高亮同时表达。 */
    function StylePicker({ styleId, onStyle }) {
      const active = COPY_STYLE_OPTIONS.find(option => option.id === styleId) ?? COPY_STYLE_OPTIONS[0]
      return h('div', null,
        h('div', { style: S.chipRow }, ...COPY_STYLE_OPTIONS.map(option => h('button', {
          key: option.id, type: 'button', 'data-role': 'copy-style', 'aria-pressed': option.id === styleId,
          title: option.summary, onClick: () => onStyle(option.id),
          style: option.id === styleId ? { ...S.chip, ...S.chipActive } : S.chip,
        }, option.label))),
        h('div', { style: S.sectionHint }, active.label + '：' + active.summary))
    }
    /** 一个带标签的字段（control 用显式 prop：手写 loader 下不依赖 props.children）。 */
    function Field({ label, control }) {
      return h('label', { style: S.field }, h('span', { style: S.fieldLabel }, label), control)
    }
    /** 一个字段 = 「勾选 + 控件」；必填不渲染勾选框（锁死），只标「必填」。 */
    function CopyFieldRow({ field, picked, value, onToggle, onChange }) {
      const enabled = field.required === true || picked === true
      const control = field.type === 'enum'
        ? h('select', {
          value: typeof value === 'string' ? value : String(field.default ?? ''),
          'data-role': 'copy-select', 'data-field': field.id,
          onChange: event => onChange(field.id, event.target.value), style: S.input,
        }, ...(field.options ?? []).map(option => h('option', { key: option.value, value: option.value }, option.label)))
        : field.type === 'bool'
          ? h('label', { style: S.checkRow },
            h('input', {
              type: 'checkbox', 'data-role': 'copy-field-bool', 'data-field': field.id,
              checked: value === true, onChange: event => onChange(field.id, event.target.checked),
            }),
            h('span', { style: S.small }, '是'))
          : h('input', {
            type: field.type === 'integer' ? 'number' : 'text',
            'data-role': 'copy-input', 'data-field': field.id,
            value: typeof value === 'string' || typeof value === 'number' ? String(value) : '',
            placeholder: FIELD_PLACEHOLDERS[field.id] ?? '',
            onChange: event => onChange(field.id, event.target.value), style: S.input,
          })
      return h('div', { key: field.id, 'data-role': 'copy-field-row', 'data-field': field.id, style: S.copyField },
        h('div', { style: S.checkRow },
          field.required === true
            ? h('span', { style: S.requiredTag }, '必填')
            : h('input', {
              type: 'checkbox', 'data-role': 'copy-field', 'data-field': field.id,
              checked: picked === true, onChange: event => onToggle(field.id, event.target.checked),
            }),
          h('span', { style: S.fieldLabel }, field.label)),
        enabled ? control : null,
        enabled && typeof field.hint === 'string' ? h('div', { style: S.sectionHint }, field.hint) : null)
    }
    /** 请求预览：把参数 JSON 摊开，便于复制或直接在对话里让模型执行。 */
    function CopyPlanPreview({ request }) {
      return h('div', { style: S.preview },
        h('div', { style: S.sectionTitle }, '生成请求已就绪'),
        h('pre', { style: S.pre }, JSON.stringify(request, null, 2)))
    }
