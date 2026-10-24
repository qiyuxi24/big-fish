    /**
     * 片段 10：行内样式表（跟随 DSH 主题变量，不引入样式文件）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /**
     * 行内样式表：跟随 DSH 主题变量，不引入样式文件。
     *
     * 滚动责任在插件这边：宿主 `main` 插槽的容器是 `display:flex; flex-direction:column; overflow:hidden`
     * （ui-layout 的 AppFrame.module.css `.centerCol`），它自己**不滚动**——占位组件必须撑满高度、
     * 自己开一个滚动容器，否则内容超出直接被裁，鼠标滚轮也没反应。所以这里分三层：
     * root（撑满 + 竖向 flex）→ header/tabBar（`flex:0 0 auto`，固定不动）→ scroll（唯一滚动区）。
     */
    const S = {
      root: {
        height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
      },
      header: { flex: '0 0 auto', display: 'flex', gap: '12px', alignItems: 'center', padding: '16px 24px 8px' },
      logo: { fontSize: '26px', lineHeight: '1' }, title: { fontSize: '16px', fontWeight: 600, lineHeight: '24px' }, subtitle: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      tabBar: {
        flex: '0 0 auto', display: 'flex', gap: '10px', flexWrap: 'wrap', overflowX: 'auto',
        padding: '0 24px', borderBottom: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
      },
      /** 唯一滚动容器：竖向滚到底，宽表格（账号/采集/商品）横向也能滚，不被裁切。 */
      scroll: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '4px 24px 40px' },
      /** 内容宽度轴：宽屏时居中限宽，窄屏时自然铺满。 */
      content: { maxWidth: '860px', margin: '0 auto' },
      tabGroup: { display: 'flex', gap: '2px', alignItems: 'center' },
      tabGroupLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.7, paddingRight: '2px' },
      tab: { fontSize: '13px', padding: '8px 14px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', borderBottom: '2px solid transparent', marginBottom: '-1px' },
      tabActive: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, borderBottom: '2px solid var(--dsw-alias-label-primary)' },
      section: { marginTop: '24px' }, sectionTitle: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' },
      sectionHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '10px', lineHeight: '18px' },
      buttonRow: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px' },
      button: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l2)', color: 'var(--dsw-alias-label-primary)' },
      primary: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l3)', color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
      chipRow: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      chip: { fontSize: '12px', padding: '5px 12px', borderRadius: '999px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)' },
      chipActive: { background: 'var(--dsw-alias-bg-l3)', color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-label-secondary)', fontWeight: 600 },
      chipOff: { opacity: 0.5, cursor: 'not-allowed' },
      fieldRow: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '12px' }, field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '180px', flex: '1 1 180px' },
      fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      copyField: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '200px', flex: '1 1 200px' },
      checkRow: { display: 'flex', gap: '6px', alignItems: 'center' },
      requiredTag: { fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: 'var(--dsw-alias-bg-l3)', color: 'var(--dsw-alias-label-secondary)' },
      input: { fontSize: '13px', padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
      preview: { marginTop: '16px' },
      pre: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', background: 'var(--dsw-alias-bg-l2)', borderRadius: '8px', padding: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '10px 0 0' },
      cmdRow: { display: 'flex', gap: '10px', alignItems: 'baseline', padding: '5px 0', flexWrap: 'wrap' }, cmdLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', minWidth: '150px' },
      cmdCode: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', background: 'var(--dsw-alias-bg-l2)', borderRadius: '4px', padding: '2px 6px', wordBreak: 'break-all' },
      textarea: { width: '100%', boxSizing: 'border-box', resize: 'vertical', marginTop: '8px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      okText: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, badText: { fontSize: '12px', color: 'var(--dsw-alias-label-danger, #c0392b)' }, goodText: { fontSize: '12px', color: 'var(--dsw-alias-label-success, #1a7f37)' }, warnText: { fontSize: '12px', color: 'var(--dsw-alias-label-warning, #9a6700)' },
      small: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, actions: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
    }
    /** 置灰态：与可用按钮同形，光标与透明度明确「点不动」（S.button 现在表示可用）。 */
    S.offButton = { ...S.button, cursor: 'not-allowed', opacity: 0.55, color: 'var(--dsw-alias-label-secondary)' }
