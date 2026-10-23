    /**
     * 片段 06：「采集」tab（贴链接 → 解析 → 两次确认入库 → 已入库快照）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 采集口径与红线（面板不联网、不下载图片；落库只留结构化元数据）。 */
    const REFERENCE_NOTES = [
      '贴商家主页链接（…/personal?userId=…）或商品链接（…/item?id=…），解析出商家后采其在售商品。',
      '落库只存标题 / 价格 / 类目 / 浏览·想要·收藏·卖出 / 图片张数 / 发布时间；不下载图片、不存描述全文。',
      '红线：不照抄文案、不跨账号复制他人商品；他人店铺必须勾选「仅用于看行情」才放开采集（AGENTS §1.6）。',
      '单件失败不影响整批：失败条目进 skipped，AUTH_EXPIRED / RISK_CONTROL / UNAUTHORIZED 会中止整批。',
    ]
    /** 采集商品表列；价格按整数分渲染（÷100 用整数运算，不做浮点乘）。 */
    const REFERENCE_COLUMNS = ['标题', '价格', '类目', '浏览', '想要', '收藏', '图', '发布']
    const REFERENCE_GRID = 'minmax(120px, 1fr) 82px 92px 48px 48px 48px 40px 88px'
    function formatCentsText(cents) {
      const value = Number(cents)
      if (!Number.isFinite(value) || value < 0) return '—'
      const yuan = Math.trunc(value / 100)
      const fen = value % 100
      return fen === 0 ? String(yuan) + ' 元' : String(yuan) + '.' + String(fen).padStart(2, '0') + ' 元'
    }
    function countText(value) { const num = Number(value); return Number.isFinite(num) && num >= 0 ? String(num) : '—' }
    /** 采集模块：贴链接 → 解析 → 采集入库（两次确认）→ 看已入库快照。 */
    function ReferenceView({ connection }) {
      const writes = useWrite(connection)
      const [board, setBoard] = React.useState({
        link: '', accountId: '', accounts: [], maxItems: '20', acknowledge: false,
        parsed: null, notice: null, sellers: [], sellerId: '', items: { phase: 'idle', total: 0, rows: [] },
      })
      const update = patch => setBoard(previous => ({ ...previous, ...patch }))
      const loadSellers = () => {
        void callRead(connection, 'sellers.list').then(reply => {
          if (reply.ok && Array.isArray(reply.value)) update({ sellers: reply.value })
        })
      }
      const loadItems = sellerId => {
        update({ sellerId, items: { phase: 'loading', total: 0, rows: [] } })
        void callRead(connection, 'seller.items', { sellerId, limit: 200 }).then(reply => {
          const value = reply.ok && reply.value !== null && typeof reply.value === 'object' ? reply.value : null
          const rows = value !== null && Array.isArray(value.items) ? value.items : []
          update({ items: { phase: reply.ok ? 'ok' : 'offline', total: Number(value?.total ?? rows.length), rows } })
        })
      }
      // 进 tab 拉一次账号（采集要选登录态）与已采集商家；都不轮询（采集是人工动作）。
      React.useEffect(() => {
        let alive = true
        void callRead(connection, 'accounts').then(reply => {
          if (!alive || !reply.ok || !Array.isArray(reply.value)) return
          const ids = reply.value.map(row => String(row?.accountId ?? '')).filter(id => id !== '')
          setBoard(previous => ({ ...previous, accounts: ids, accountId: previous.accountId !== '' ? previous.accountId : (ids[0] ?? '') }))
        })
        loadSellers()
        return () => { alive = false }
      }, [connection])
      const parse = () => {
        const link = board.link.trim()
        if (link === '') return update({ notice: { kind: 'bad', text: '先粘贴一条闲鱼商品或商家链接' }, parsed: null })
        update({ notice: null, parsed: null })
        void callRead(connection, 'reference.parseLink', { link }).then(reply => {
          if (reply.ok && reply.value !== null && typeof reply.value === 'object') return update({ parsed: reply.value })
          const hint = reply.message !== undefined && reply.message !== ''
            ? reply.message
            : reply.code === 'UNSUPPORTED' ? '宿主里还没有这个 rpc：重启 DSH 桌面应用加载新版插件' : '解析失败（' + (reply.code || 'UNKNOWN') + '）'
          update({ notice: { kind: 'bad', text: truncateText(hint) } })
        })
      }
      const parsed = board.parsed
      const sellerId = parsed !== null && parsed.kind === 'seller' ? String(parsed.sellerId ?? '') : ''
      const busy = writes.state.busy
      const collectValid = sellerId !== '' && board.accountId !== '' && !busy
      const collect = () => {
        if (!collectValid) return
        const maxItems = Number(board.maxItems)
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 60) {
          return update({ notice: { kind: 'bad', text: '件数必须是 1..60 的整数' } })
        }
        const payload = { accountId: board.accountId, sellerId, maxItems }
        if (board.acknowledge) payload.acknowledgeOther = true
        update({ notice: null })
        writes.run('collect', 'seller.collect', payload, {
          hint: '再点一次「确认采集」：翻页读该商家在售商品并写入本地库（不下载图片、不存描述）',
          busy: '正在采集…（逐件读详情，最多 1 分钟）',
          done: value => {
            const stored = value !== null && typeof value === 'object' ? Number(value.stored ?? 0) : 0
            const truncated = value !== null && typeof value === 'object' && value.truncated === true
            const skipped = value !== null && typeof value === 'object' && Array.isArray(value.skipped) ? value.skipped.length : 0
            return '已入库 ' + String(stored) + ' 件' + (skipped > 0 ? '，跳过 ' + String(skipped) + ' 件' : '') + (truncated ? '（还有更多，未采完：调大件数或分次采）' : '')
          },
          after: () => { loadSellers(); loadItems(sellerId) },
        })
      }
      const sellerLabel = profile => String(profile.nick ?? profile.sellerId) + ' · ' + String(profile.storedCount ?? 0) + ' 件'
      const sellerList = board.sellers.length === 0
        ? h('div', { style: S.sectionHint, 'data-role': 'reference-empty' }, '还没有采集记录：先贴链接解析，再点两次「采集并入库」')
        : h('div', { style: S.buttonRow }, ...board.sellers.map(profile => h('button', {
          key: String(profile.sellerId), type: 'button', 'data-role': 'reference-seller',
          onClick: () => loadItems(String(profile.sellerId)),
          style: String(profile.sellerId) === board.sellerId ? S.primary : S.button,
        }, sellerLabel(profile))))
      const rowOf = row => h('div', { key: String(row.itemId), style: gridRow(REFERENCE_GRID, false), 'data-role': 'reference-item', 'data-item-id': String(row.itemId) },
        h('span', { style: S.small }, String(row.title ?? '—')),
        h('span', null, formatCentsText(row.priceCents)),
        h('span', { style: S.small }, String(row.categoryId ?? '—')),
        h('span', { style: S.small }, countText(row.browseCount)),
        h('span', { style: S.small }, countText(row.wantCount)),
        h('span', { style: S.small }, countText(row.collectCount)),
        h('span', { style: S.small }, countText(row.imageCount)),
        h('span', { style: S.small }, row.publishedAt === undefined ? '—' : formatAgo(row.publishedAt)))
      const itemsBlock = board.items.phase === 'idle'
        ? null
        : board.items.phase === 'loading'
          ? h('div', { style: S.small }, '正在读已入库商品…')
          : board.items.phase === 'offline'
            ? h('div', { style: S.badText }, '读不到已入库商品：daemon 离线或这一版没有 seller.items')
            : h('div', { 'data-role': 'reference-items' },
              h('div', { style: S.sectionHint }, '商家 ' + board.sellerId + ' · 本地共 ' + String(board.items.total) + ' 件（最多显示 200 件）'),
              h('div', { style: gridRow(REFERENCE_GRID, true) }, ...REFERENCE_COLUMNS.map(label => h('span', { key: label }, label))),
              ...board.items.rows.map(rowOf),
              board.items.rows.length === 0 ? h('div', { style: S.small }, '这一版还没有商品（采集被截断或全部失败）') : null)
      return h('div', null,
        h('div', { style: S.section, 'data-role': 'reference-panel' },
          h('div', { style: S.sectionTitle }, '链接 → 商家商品入库'),
          h('div', { style: S.fieldRow },
            h(Field, { label: '闲鱼链接（商品或商家主页，支持整段分享文案）', control: h('input', {
              type: 'text', maxLength: 2048, value: board.link, 'data-role': 'reference-link',
              placeholder: 'https://www.goofish.com/personal?userId=…', onChange: event => update({ link: event.target.value, parsed: null }), style: S.input,
            }) }),
            h('div', { style: S.buttonRow },
              h('button', { type: 'button', 'data-role': 'reference-parse', onClick: parse, style: S.button }, '解析链接'))),
          parsed === null ? null : h('div', { style: S.small, 'data-role': 'reference-parsed' },
            parsed.kind === 'seller' ? '商家 id：' + String(parsed.sellerId) : '商品 id：' + String(parsed.itemId) + (parsed.categoryId === undefined ? '' : ' · 类目 ' + String(parsed.categoryId))),
          parsed !== null && parsed.kind === 'item'
            ? h('div', { style: S.warnText, 'data-role': 'reference-item-hint' }, '这是商品链接：要采全店请改贴商家主页链接（…/personal?userId=…）；单件统计请用 xy_reference_collect')
            : null,
          h('div', { style: S.fieldRow },
            h(Field, { label: '用哪个账号的登录态', control: board.accounts.length === 0
              ? h('div', { style: S.small }, '还没有导入账号（去「账号」tab 导入或扫码）')
              : h('select', { value: board.accountId, 'data-role': 'reference-account', onChange: event => update({ accountId: event.target.value }), style: S.input },
                ...board.accounts.map(id => h('option', { key: id, value: id }, id))) }),
            h(Field, { label: '最多采多少件（1–60）', control: h('input', {
              type: 'number', min: 1, max: 60, value: board.maxItems, 'data-role': 'reference-max-items',
              onChange: event => update({ maxItems: event.target.value }), style: S.input,
            }) })),
          h('div', { style: S.fieldRow },
            h(Field, { label: '他人店铺', control: h('input', {
              type: 'checkbox', checked: board.acknowledge, 'data-role': 'reference-acknowledge',
              onChange: event => update({ acknowledge: event.target.checked }),
            }) }),
            h('div', { style: S.sectionHint }, '只有采「不是当前账号」的店铺才要勾选；勾选即确认仅用于看行情、不搬运素材与文案')),
          h('div', { style: S.buttonRow },
            h('button', {
              type: 'button', 'data-role': 'reference-collect', disabled: !collectValid, onClick: collect,
              title: collectValid ? '翻页读该商家在售商品并写入本地库（写磁盘，点两次确认）' : '先解析出商家 id 并选一个账号',
              style: collectValid ? S.primary : S.button,
            }, writes.state.armed === 'collect' ? '确认采集' : busy ? '采集中…' : '采集并入库')),
          resultLine(board.notice ?? writes.state.result, 'reference-notice')),
        h('div', { style: S.section, 'data-role': 'reference-sellers' },
          h('div', { style: S.sectionTitle }, '已采集的商家'),
          sellerList,
          itemsBlock),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '口径与红线'),
          ...REFERENCE_NOTES.map((note, index) => h('div', { key: String(index), style: S.sectionHint }, '· ' + note))))
    }

