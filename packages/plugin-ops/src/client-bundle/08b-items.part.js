    /**
     * 片段 08b：「商品」tab（自有商品快照 + 擦亮 / 详情探测入队）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 商品状态：与 core 的 ItemState 一致；未知状态不猜成在售。 */
    const ITEM_STATE_LABELS = [['online', '在售'], ['offline', '已下架'], ['unknown', '未知']]
    function itemStateLabel(value) { const hit = ITEM_STATE_LABELS.find(([state]) => state === value); return hit === undefined ? '未知' : hit[1] }
    const ITEM_COLUMNS = ['选', '商品', '价格', '状态', '账号', '更新']
    const ITEM_GRID = '44px minmax(140px, 1.4fr) 96px 72px 132px 92px'
    /**
     * 擦亮 / 探测的幂等键按「天」去重：同一天重复点不会把同一件商品塞两遍队列，
     * 第二天键变了可以再擦一次——擦亮本来就是每天一次的运营动作。
     * 必须用**本地**日期：toISOString() 是 UTC，北京时间 00:00–08:00 会被算成前一天，
     * 于是「今天擦过」的键与用户认知的日期错开一天（擦亮配额按自然日算）。
     */
    const pad2 = value => String(value).padStart(2, '0')
    const dayKey = () => { const now = new Date(); return String(now.getFullYear()) + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) }
    /** 「商品」tab：本地商品快照 → 勾选 → 入队 polish（擦亮，写）/ probe（详情探测，读）。 */
    function ItemsView({ connection }) {
      const [board, setBoard] = React.useState({ phase: 'loading', rows: [], accounts: [], accountId: '', picked: {} })
      const job = useWrite(connection)
      const update = patch => setBoard(previous => ({ ...previous, ...patch }))
      /**
       * 快照必须按账号过滤后再展示：daemon 的 GET /items 支持 accountId，
       * 但面板以前不传——于是「选中账号 B 却勾到 A 的商品」，
       * 擦亮入队就成了 itemId(A) + accountId(B) 的错账号写操作。
       * 选中账号变化时也要重拉，否则列表停在旧号上。
       */
      const loadItems = accountId => {
        const forAccount = accountId === undefined ? board.accountId : accountId
        update({ phase: 'loading' })
        void callRead(connection, 'items.list', forAccount === '' ? {} : { accountId: forAccount }).then(reply => {
          update({ phase: reply.ok ? 'ok' : 'offline', rows: reply.ok && Array.isArray(reply.value) ? reply.value : [] })
        })
      }
      // 进 tab 拉一次账号与快照；都不轮询（擦亮/探测是人工动作，入队后自己刷新）。
      React.useEffect(() => {
        let alive = true
        void callRead(connection, 'accounts').then(reply => {
          if (!alive || !reply.ok || !Array.isArray(reply.value)) return
          const ids = reply.value.map(row => String(row?.accountId ?? '')).filter(id => id !== '')
          setBoard(previous => ({ ...previous, accounts: ids, accountId: previous.accountId !== '' ? previous.accountId : (ids[0] ?? '') }))
        })
        loadItems('')
        return () => { alive = false }
      }, [connection])
      const pickedIds = Object.keys(board.picked).filter(id => board.picked[id] === true)
      const blocked = board.phase !== 'ok' ? '连上后台才能入队'
        : board.accountId === '' ? '先选一个账号（daemon 里没有账号就去「账号」tab 导入）'
          : pickedIds.length === 0 ? '先勾选至少一件商品' : ''
      const canRun = blocked === '' && !job.state.busy
      // probe 是纯读（只拉详情回写快照），门禁不该让它点两次：confirm:false 会一次点击直接发。
      const runJob = (kind, label, hint, options) => job.run(kind, 'batch.enqueue', {
        items: pickedIds.map(itemId => ({
          kind, dedupeKey: kind + ':' + itemId + ':' + dayKey(),
          payload: { accountId: board.accountId, itemId },
        })),
      }, {
        hint: '再点一次「确认' + label + '」：' + String(pickedIds.length) + ' 件进队列，daemon 按账号串行执行' + hint,
        busy: '正在入队…',
        done: value => '已入队 ' + String(Array.isArray(value?.tasks) ? value.tasks.length : pickedIds.length) + ' 条' + label + '任务',
        after: () => loadItems(),
      }, options)
      const allPicked = () => update({ picked: Object.fromEntries(board.rows.map(row => [String(row?.itemId ?? ''), true])) })
      const rowOf = row => {
        const itemId = String(row?.itemId ?? '')
        return h('div', { key: itemId, style: gridRow(ITEM_GRID, false), 'data-role': 'item-row', 'data-item-id': itemId },
          h('input', {
            type: 'checkbox', 'data-role': 'item-pick', 'data-item-id': itemId, checked: board.picked[itemId] === true,
            // 勾选框没有可读名字时读屏只会念「复选框」：把商品名带上。
            'aria-label': '选择商品 ' + String(row?.title ?? itemId),
            onChange: event => setBoard(previous => ({ ...previous, picked: { ...previous.picked, [itemId]: event.target.checked } })),
          }),
          h('span', { style: S.small }, String(row?.title ?? '—')),
          h('span', null, formatCentsText(row?.priceCents)),
          h('span', { style: S.small }, itemStateLabel(row?.state)),
          h('span', { style: S.small }, String(row?.accountId ?? '—')),
          h('span', { style: S.small }, formatAgo(row?.updatedAt)))
      }
      return h('div', null,
        h('div', { style: S.section, 'data-role': 'items-panel' },
          h('div', { style: S.sectionTitle }, '自有商品'),
          h('div', { style: S.sectionHint }, '本地快照（probe 探测 / 发布成功后落库）。擦亮走 mtop 写接口、消耗写预算；探测只读详情并回写快照。'),
          h('div', { style: S.buttonRow },
            h('button', { type: 'button', 'data-role': 'items-refresh', onClick: () => loadItems(), style: S.button }, '刷新快照'),
            h('button', { type: 'button', 'data-role': 'items-pick-all', onClick: allPicked, style: S.button }, '全选'),
            h('button', { type: 'button', 'data-role': 'items-pick-none', onClick: () => update({ picked: {} }), style: S.button }, '清空')),
          h('div', { style: S.fieldRow },
            h(Field, {
              label: '账号', control: board.accounts.length === 0
                ? h('div', { style: S.small }, '还没有导入账号（去「账号」tab）')
                : h('select', {
                  value: board.accountId, 'data-role': 'items-account',
                  // 换账号必须清掉已勾选并重拉：勾选是「这件商品」，换号后它的账号对不上了。
                  onChange: event => {
                    const next = event.target.value
                    update({ accountId: next, picked: {} })
                    loadItems(next)
                  }, style: S.input,
                }, ...board.accounts.map(id => h('option', { key: id, value: id }, id))),
            })),
          h('div', { style: S.buttonRow },
            h('button', {
              type: 'button', 'data-role': 'items-polish', disabled: !canRun, title: canRun ? '入队 polish：擦亮所选商品（写操作）' : blocked,
              onClick: () => runJob('polish', '擦亮', '，失败不退还预算'), style: canRun ? (job.state.armed === 'polish' ? S.armedButton : S.primary) : S.offButton,
            }, job.state.armed === 'polish' ? '确认擦亮' : job.state.busy ? '入队中…' : '擦亮所选'),
            h('button', {
              type: 'button', 'data-role': 'items-probe', disabled: !canRun, title: canRun ? '入队 probe：读商品详情并刷新本地快照（只读，不用二次确认）' : blocked,
              onClick: () => runJob('probe', '探测', '', { confirm: false }), style: canRun ? S.primary : S.offButton,
            }, job.state.busy ? '入队中…' : '探测详情')),
          resultLine(job.state.result, 'items-result')),
        h('div', { style: S.section, 'data-role': 'items-table' },
          h('div', { style: S.sectionTitle }, '商品快照 · ' + String(board.rows.length) + ' 件'),
          h('div', { style: gridRow(ITEM_GRID, true) }, ...ITEM_COLUMNS.map(label => h('span', { key: label }, label))),
          ...board.rows.map(rowOf),
          board.rows.length === 0
            ? h('div', { style: S.small, 'data-role': 'items-empty' }, board.phase === 'loading' ? '正在读取…'
              : board.phase === 'offline' ? '读不到商品快照（daemon 离线或旧版）'
                : '还没有商品：选账号后点「探测详情」，或先去「发布」tab 发一件')
            : null))
    }
