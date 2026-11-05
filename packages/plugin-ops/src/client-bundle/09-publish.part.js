    /**
     * 片段 09：「发布」tab（草稿集校验入队 + 任务表按 state / kind 筛选）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** tasks.list 的过滤参数：state / kind 交给 daemon 过滤（GET /tasks?state&kind），面板只留最近 20 条。 */
    function taskListParams(filter) {
      const params = { limit: 20 }
      if (filter.state !== 'all') params.state = filter.state
      if (filter.kind !== 'all') params.kind = filter.kind
      return params
    }
    /** 一排筛选芯片；未接线的种类（deliver / reply）置灰，只占位置不给入口。 */
    function FilterChips({ value, options, unsupported, titleOf, onSelect }) {
      return h('div', { style: S.chipRow }, ...[['all', '全部'], ...options].map(([id, text]) => {
        const off = unsupported[id] !== undefined
        return h('button', {
          key: id, type: 'button', 'data-role': 'task-filter', 'data-filter': id, disabled: off,
          'aria-pressed': value === id, title: off ? unsupported[id] : titleOf + '：' + text,
          onClick: () => onSelect(id), style: off ? { ...S.chip, ...S.chipOff } : value === id ? { ...S.chip, ...S.chipActive } : S.chip,
        }, text)
      }))
    }
    /** 任务 id：全长展示 + 复制按钮（以前截断到 16 字符，重试/查日志时对不上号）。 */
    function TaskIdCell({ id }) {
      const [copied, setCopied] = React.useState('')
      if (id === '') return h('span', { style: S.small }, '—')
      // 任务 id 是 UUID 级别的长串：靠 wordBreak 换行 + title 悬停看全，别把整列撑宽（列宽 110px 起）。
      return h('span', { style: S.actions, 'data-role': 'task-id' },
        h('span', { style: { ...S.mono, wordBreak: 'break-all', flex: '1 1 auto', minWidth: 0 }, title: id }, id),
        h('button', {
          type: 'button', 'data-role': 'task-id-copy', title: '复制任务 id ' + id, style: S.chipMini,
          onClick: () => { void copyText(id).then(ok => setCopied(ok ? '已复制' : '复制失败')) },
        }, copied === '' ? '复制' : copied))
    }
    /** 任务区：状态 / 种类筛选 + 最近 20 条；failed / needs_review 可重试，leased 可放回队列（都要点两次）。 */
    function TasksTable({ connection, board, filter, onFilter, onChanged }) {
      const retry = useWrite(connection)
      const act = useWrite(connection)
      const rowOf = task => {
        const id = String(task.id ?? ''), canRetry = task.state === 'failed' || task.state === 'needs_review'
        // 卡在 leased 的任务：worker 崩了要等租约过期，人能做的只有 release 把它放回 queued。
        // 面板以前没有这个入口，只剩「等 60 秒」和「去敲 xy_task_action」两条路。
        const canRelease = task.state === 'leased'
        const busy = retry.state.busy || act.state.busy
        return h('div', { key: id, style: gridRow(TASK_GRID, false), 'data-role': 'task-row', 'data-task-id': id },
          h(TaskIdCell, { id }), h('span', { style: S.small }, String(task.kind ?? '?')),
          h('span', { style: task.state === 'failed' ? S.badText : S.small }, taskStateLabel(task.state)),
          h('span', { style: S.small }, String(task.attempts ?? 0) + '/' + String(task.maxAttempts ?? '?')),
          h('span', { style: S.small }, formatAgo(task.updatedAt)),
          h('span', { style: S.actions },
            canRetry ? h('button', { key: 'retry', type: 'button', 'data-role': 'task-retry', disabled: busy, onClick: () => retry.run('retry:' + id, 'tasks.retry', { id }, { hint: '再点一次重试 ' + id + '：会把它放回队列', busy: '正在重试…', done: () => '已重试 ' + id, after: onChanged }), style: retry.state.armed === 'retry:' + id ? S.rowArmedButton : busy ? S.rowOffButton : S.rowButton }, retry.state.armed === 'retry:' + id ? '确认重试' : '重试') : null,
            canRelease ? h('button', { key: 'release', type: 'button', 'data-role': 'task-release', disabled: busy, title: '把它从租约里放回排队：只有确认 worker 没在处理时才点', onClick: () => act.run('release:' + id, 'tasks.action', { id, action: 'release' }, { hint: '再点一次放回队列 ' + id + '：只有确认 worker 没在处理时才这样收尾', busy: '正在放回…', done: () => '已放回队列 ' + id, after: onChanged }, { confirm: false, arm: true }), style: act.state.armed === 'release:' + id ? S.rowArmedButton : busy ? S.rowOffButton : S.rowButton }, act.state.armed === 'release:' + id ? '确认放回' : '放回队列') : null))
      }
      return h('div', { style: S.section, 'data-role': 'tasks-section' },
        h('div', { style: S.sectionTitle }, '任务 · 最近 ' + String(board.items.length) + ' 条'),
        h('div', { style: S.fieldRow },
          h('div', { style: S.field },
            h('span', { style: S.fieldLabel }, '状态'),
            h(FilterChips, { value: filter.state, options: TASK_STATE_LABELS, unsupported: {}, titleOf: '只看状态', onSelect: state => onFilter({ ...filter, state }) })),
          h('div', { style: S.field },
            h('span', { style: S.fieldLabel }, '种类'),
            h(FilterChips, { value: filter.kind, options: TASK_KINDS, unsupported: UNSUPPORTED_KINDS, titleOf: '只看种类', onSelect: kind => onFilter({ ...filter, kind }) }))),
        resultLine(retry.state.result, 'task-result'),
        resultLine(act.state.result, 'task-action-result'),
        h('div', { 'data-role': 'tasks-table' },
          h('div', { style: gridRow(TASK_GRID, true) }, ...['任务', '种类', '状态', '重试', '更新', ''].map(label => h('span', { key: label }, label))),
          ...board.items.map(rowOf),
          board.items.length === 0 ? h('div', { style: S.small, 'data-role': 'tasks-empty' }, board.phase === 'loading' ? '正在读取任务…' : '这个筛选下没有任务') : null),
        h('div', { style: S.sectionHint }, '发货 / 客服两项灰着：deliver 执行器仍是 UNSUPPORTED（缺卡密规则引擎）；reply 已接 IM 长连，但 daemon 要 BF_IM=1 才开，面板暂不给入口。'))
    }
    /**
     * 生成好的入队参数：以前只有一个 <pre>，想拿去喂工具只能手动拖选长 JSON（一拖就跳）。
     * 文案 tab 早就有「复制 JSON」，这里补齐，否则「生成」按钮就是个死胡同。
     */
    function PublishRequestPreview({ request }) {
      const [state, setState] = React.useState({ kind: '', text: '' })
      const json = JSON.stringify(request, null, 2)
      const onCopy = () => {
        void copyText(json).then(ok => setState(ok
          ? { kind: 'ok', text: '已复制：可以粘给 agent 当 xy_publish_batch 的参数' }
          : { kind: 'bad', text: '宿主没给剪贴板权限：请手动选中下面的文本框内容复制' }))
      }
      return h('div', { style: S.preview, 'data-role': 'publish-request-preview' },
        h('div', { style: S.sectionTitle }, 'xy_publish_batch 参数已就绪'),
        h('div', { style: S.buttonRow },
          h('button', { type: 'button', 'data-role': 'publish-request-copy', title: '把这段 JSON 复制到剪贴板', onClick: onCopy, style: S.chipMini }, '复制 JSON')),
        state.kind === '' ? null : h('div', { style: state.kind === 'ok' ? S.goodText : S.manualHint, 'data-role': 'publish-request-hint', role: 'status' }, state.text),
        h('pre', { style: S.pre, 'data-role': 'publish-request' }, json),
        // 只读 textarea 兜底：剪贴板不可用时还能全选复制。
        h('textarea', { readOnly: true, rows: 8, value: json, 'data-role': 'publish-request-text', 'aria-label': '入队参数 JSON（只读）', style: S.textarea }))
    }
    /** 「发布」模块：草稿集 → 校验 → 入队（去重）→ 任务表跟进。 */
    function PublishBatchView({ connection }) {
      const snapshot = useDaemonSnapshot(connection)
      const [draftText, setDraftText] = React.useState('')
      const [mode, setMode] = React.useState('dry-run')
      const [accountId, setAccountId] = React.useState('')
      const [generated, setGenerated] = React.useState(null)
      const [filter, setFilter] = React.useState({ state: 'all', kind: 'all' })
      const [tasks, setTasks] = React.useState({ phase: 'loading', items: [] })
      const [address, setAddress] = React.useState('')
      const enqueue = useWrite(connection)
      const loadTasks = () => callRead(connection, 'tasks.list', taskListParams(filter)).then(reply => setTasks(tasksState(reply)))
      // 任务状态是 daemon 侧异步推进的（排队 → 执行中 → 完成/失败），只拉一次会永远停在入队瞬间，所以按 3 秒轮询。
      React.useEffect(() => { void loadTasks(); const timer = setInterval(() => { void loadTasks() }, POLL_MS); return () => clearInterval(timer) }, [connection, filter.state, filter.kind])
      const results = parseDraftLines(draftText), valid = results.filter(result => result.ok), invalid = results.filter(result => !result.ok)
      // 1 条就够：真机验过的路径就是「单件」，别再逼用户凑 2 条（批量只是多行重复同一个流程）。
      const ready = valid.length >= 1 && invalid.length === 0
      const blocked = results.length === 0 ? '先粘贴至少 1 条合法草稿' : invalid.length > 0 ? '有 ' + String(invalid.length) + ' 行校验不通过，先修好再生成' : '至少 1 条合法草稿才能生成（现在 ' + String(valid.length) + ' 条）'
      const request = buildPublishBatchArguments(mode, results, accountId)
      const update = setter => value => { setter(value); setGenerated(null) }
      const accounts = snapshot.phase === 'ok' && snapshot.data !== null && Array.isArray(snapshot.data.accounts) ? snapshot.data.accounts : []
      const accountsMissing = snapshot.phase === 'ok' && snapshot.data !== null && Array.isArray(snapshot.data.missing) && snapshot.data.missing.includes('accounts')
      const accountIds = accounts.map(account => String(account !== null && typeof account === 'object' ? account.accountId ?? '' : '')).filter(id => id !== '')
      const targetAccount = accountId.trim() !== '' ? accountId.trim() : accountIds.length === 1 ? accountIds[0] : ''
      const settings = snapshot.phase === 'ok' && snapshot.data !== null && snapshot.data.settings !== null && typeof snapshot.data.settings === 'object' ? snapshot.data.settings : null
      // 地址优先用本页输入的，其次用设置里的默认地址：队列任务执行时 daemon 读不到草稿文件，
      // payload 里没有 address，「必填项预检」必然 VALIDATION（宝贝所在地为空），任务只会 failed。
      const fallbackAddress = address.trim() !== '' ? address.trim() : typeof settings?.defaultAddress === 'string' ? settings.defaultAddress : ''
      const defaults = { shipping: typeof settings?.shipping === 'string' ? settings.shipping : undefined, address: fallbackAddress }
      const inline = valid.filter(result => result.kind === 'inline'), plan = buildPublishItems(inline, targetAccount, defaults)
      // 模式芯片必须真管事：以前它对按钮毫无影响，点着「dry-run 只填表」再按「校验并入队」
      // 却直接把任务写进队列——芯片成了装饰，而且是一条静默的写操作捷径。
      const dryRunMode = mode !== 'enqueue'
      const enqueueBlocked = dryRunMode ? '模式是 dry-run（只填表、不写队列）：要真入队先把上面的模式切到「enqueue 入队」'
        : targetAccount === '' ? (accountsMissing ? '这轮没读到账号列表，手动填账号 id（别以为是没账号）' : '先填账号 id（daemon 里有 0 个或多个账号）')
          : plan.problems.length > 0 ? plan.problems.join('；') : invalid.length > 0 ? '先修好校验不通过的行' : inline.length === 0 ? '至少 1 条内联草稿才能入队' : ''
      const canEnqueue = enqueueBlocked === ''
      const submitEnqueue = () => enqueue.run('batch', 'batch.enqueue', { batchId: 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), items: plan.items }, { hint: '再点一次「确认入队」：写操作，会进 daemon 队列', busy: '正在入队…', done: value => '已入队 ' + String(value?.batchId ?? '') + ' · ' + String(plan.items.length) + ' 条', after: loadTasks })
      const batch = enqueue.state.result
      const modeButtons = PUBLISH_MODES.map(([value, label, hint]) => h('button', { key: value, type: 'button', 'data-role': 'publish-mode', 'aria-pressed': value === mode, title: hint, onClick: () => update(setMode)(value), style: value === mode ? { ...S.chip, ...S.chipActive } : S.chip }, label))
      const online = snapshot.phase === 'ok' && snapshot.data !== null
      const statusMissing = snapshot.phase === 'ok' && snapshot.data !== null && Array.isArray(snapshot.data.missing) && snapshot.data.missing.includes('status')
      return h('div', null,
        h('div', { style: S.section, 'data-role': 'publish-backend' },
          h('div', { style: online ? S.small : S.warnText }, snapshot.phase === 'loading' ? '正在连接后台…'
            : online ? '后台在线' + (statusMissing ? '（这一轮没读到队列计数）' : ' · ' + describeQueue(snapshot.data.status?.queue ?? {}) + ' · 最近批次 ' + describeBatch(snapshot.data.batch))
              : '后台未连接：入队会失败，去「概览」tab 启动 daemon')),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '流水线'),
          h('div', { style: S.sectionHint }, '草稿 → 校验 → 入队（去重）→ daemon 串行发布，失败进待审 · ' + CATEGORY_MATRIX)),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '草稿集'),
          h('div', { style: S.sectionHint }, '每行一条：内联 JSON（title / desc / priceCents（分，也收 price）/ images）或 .json 路径；入队只收内联。1 条即可入队。'),
          h('textarea', { value: draftText, rows: 6, 'data-role': 'draft-input', placeholder: '{"title":"...","desc":"...","priceCents":990,"images":["D:/pics/1.jpg"]}', onChange: event => update(setDraftText)(event.target.value), style: { ...S.input, ...S.textarea } })),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '发布前校验'),
          ...results.map(result => h('div', { key: String(result.index), style: S.cmdRow, 'data-role': 'draft-check', 'data-ok': result.ok }, h('span', { style: S.cmdLabel }, '第 ' + String(result.index + 1) + ' 行'), h('span', { style: result.ok ? S.okText : S.badText }, result.message))),
          h('div', { style: S.sectionHint }, '通过 ' + String(valid.length) + ' · 未通过 ' + String(invalid.length) + '（1 条通过就能生成）')),
        h('div', { style: S.section },
          h('div', { style: S.fieldRow }, h('div', { style: S.field }, h('span', { style: S.fieldLabel }, '模式'), h('div', { style: S.chipRow }, ...modeButtons))),
          h(Field, { label: '账号（可选）', control: h('input', { type: 'text', value: accountId, placeholder: 'daemon 账号 id，默认唯一账号', onChange: event => update(setAccountId)(event.target.value), style: S.input }) }),
          // 地址不给入口时，入队体只能是「缺 address」，执行器必填项预检必然 VALIDATION —— 用户会以为是自己草稿写错了。
          h(Field, { label: '宝贝所在地（可选）', control: h('input', { type: 'text', value: address, placeholder: fallbackAddress !== '' && address.trim() === '' ? '默认用设置里的：' + fallbackAddress : '留空则用设置里的默认地址；可用真实地点关键词', onChange: event => setAddress(event.target.value), style: S.input }) }),
          h('div', { style: S.buttonRow },
            h('button', { type: 'button', 'data-role': 'publish-batch-submit', disabled: !ready, title: ready ? '组装 xy_publish_batch 参数 JSON' : blocked, onClick: () => setGenerated(request), style: ready ? S.primary : S.offButton }, '生成批量发布请求'),
            h('button', { type: 'button', 'data-role': 'batch-enqueue', disabled: !canEnqueue || enqueue.state.busy, title: canEnqueue ? '把内联草稿写进 daemon 队列（写操作，点两次）' : enqueueBlocked, onClick: submitEnqueue, style: canEnqueue && !enqueue.state.busy ? (enqueue.state.armed === 'batch' ? S.armedButton : S.primary) : S.offButton }, enqueue.state.armed === 'batch' ? '确认入队' : enqueue.state.busy ? '入队中…' : '校验并入队')),
          resultLine(batch, 'batch-result'),
          ...(batch !== null && batch.value !== undefined && Array.isArray(batch.value.tasks) ? batch.value.tasks.map((task, index) => h('div', { key: String(index), style: S.small, 'data-role': 'batch-item' }, '第 ' + String(index + 1) + ' 条 · ' + taskStateLabel(task.state) + (Array.isArray(batch.value.created) && batch.value.created[index] === false ? '（已存在，跳过）' : ''))) : [])),
        h(TasksTable, { connection, board: tasks, filter, onFilter: setFilter, onChanged: loadTasks }),
        generated === null ? null : h(PublishRequestPreview, { request: generated }))
    }
