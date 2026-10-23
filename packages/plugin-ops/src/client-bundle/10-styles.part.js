    /**
     * 片段 10：行内样式表（跟随 DSH 主题变量，不引入样式文件）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 行内样式表：跟随 DSH 主题变量，不引入样式文件。 */
    const S = {
      page: { padding: '32px', maxWidth: '860px', margin: '0 auto', color: 'var(--dsw-alias-label-primary)' },
      header: { display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '24px' },
      logo: { fontSize: '34px', lineHeight: '1' }, title: { fontSize: '20px', fontWeight: 600, lineHeight: '28px' }, subtitle: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      tabBar: { display: 'flex', gap: '2px', borderBottom: '1px solid var(--dsw-alias-border-l2)', marginBottom: '4px' },
      tab: { fontSize: '13px', padding: '8px 14px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', borderBottom: '2px solid transparent', marginBottom: '-1px' },
      tabActive: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, borderBottom: '2px solid var(--dsw-alias-label-primary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '16px' },
      cardTitle: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px' }, cardValue: { fontSize: '15px', fontWeight: 500, lineHeight: '22px' },
      cardHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '6px', lineHeight: '18px' },
      section: { marginTop: '24px' }, sectionTitle: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' },
      sectionHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '10px', lineHeight: '18px' },
      buttonRow: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px' },
      button: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'not-allowed', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l2)', color: 'var(--dsw-alias-label-secondary)' },
      primary: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l3)', color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
      chipRow: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      chip: { fontSize: '12px', padding: '5px 12px', borderRadius: '999px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)' },
      chipActive: { background: 'var(--dsw-alias-bg-l3)', color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-label-secondary)', fontWeight: 600 },
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
      note: { marginTop: '24px', fontSize: '13px', lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }, textarea: { width: '100%', boxSizing: 'border-box', resize: 'vertical', marginTop: '8px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      okText: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, badText: { fontSize: '12px', color: 'var(--dsw-alias-label-danger, #c0392b)' }, goodText: { fontSize: '12px', color: 'var(--dsw-alias-label-success, #1a7f37)' }, warnText: { fontSize: '12px', color: 'var(--dsw-alias-label-warning, #9a6700)' },
      small: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, actions: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
    }
