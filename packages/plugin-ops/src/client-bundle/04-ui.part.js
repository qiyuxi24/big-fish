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
    /**
     * 把文本塞进剪贴板：只用宿主环境自带能力（不走 DOM 直读、不碰本地存储）。
     * 失败或环境没有剪贴板时返回 false，调用方给「手动选中复制」的兜底提示。
     */
    function copyText(text) {
      try {
        if (typeof navigator === 'undefined' || navigator === null) return Promise.resolve(false)
        const clipboard = navigator.clipboard
        if (clipboard === undefined || clipboard === null || typeof clipboard.writeText !== 'function') return Promise.resolve(false)
        const written = clipboard.writeText(text)
        if (written === undefined) return Promise.resolve(true)
        return Promise.resolve(written).then(() => true, error => { void error; return false })
      } catch (error) {
        void error
        return Promise.resolve(false)
      }
    }
    /**
     * 请求预览：JSON 摊开 + 「复制 JSON」按钮 + 只读 textarea。
     * 之前只有 <pre>，用户只能手动拖选（长 JSON 一拖就跳），等于把请求困在面板里。
     * 复制走 navigator.clipboard；不可用时明确提示「手动选中下面文本框复制」，不静默失败。
     */
    function CopyPlanPreview({ request }) {
      const [state, setState] = React.useState({ kind: '', text: '' })
      const json = JSON.stringify(request, null, 2)
      const onCopy = () => {
        void copyText(json).then(ok => setState(ok
          ? { kind: 'ok', text: '已复制到剪贴板，可直接粘给 agent 或终端' }
          : { kind: 'bad', text: '宿主没给剪贴板权限：请手动选中下面的文本框内容复制' }))
      }
      return h('div', { style: S.preview, 'data-role': 'copy-preview' },
        h('div', { style: S.sectionTitle }, '生成请求已就绪'),
        h('div', { style: S.buttonRow },
          h('button', { type: 'button', 'data-role': 'copy-json', title: '把这段 JSON 复制到剪贴板', onClick: onCopy, style: S.chipMini }, '复制 JSON')),
        state.kind === '' ? null : h('div', { style: state.kind === 'ok' ? S.goodText : S.manualHint, 'data-role': 'copy-json-hint', role: 'status' }, state.text),
        h('pre', { style: S.pre }, json),
        // 只读 textarea：剪贴板不可用时用户还能全选复制；readOnly 保证不会被误改后当成新请求。
        h('textarea', { readOnly: true, rows: 8, value: json, 'data-role': 'copy-json-text', 'aria-label': '生成的请求 JSON（只读）', style: S.textarea }))
    }
