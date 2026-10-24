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
    /** 任务区：状态 / 种类筛选 + 最近 20 条；failed / needs_review 可重试（两次确认）。 */
    function TasksTable({ connection, board, filter, onFilter, onChanged }) {
      const retry = useWrite(connection)
      const rowOf = task => {
        const id = String(task.id ?? ''), canRetry = task.state === 'failed' || task.state === 'needs_review'
        return h('div', { key: id, style: gridRow(TASK_GRID, false), 'data-role': 'task-row', 'data-task-id': id },
          h('span', null, id.slice(0, 16)), h('span', { style: S.small }, String(task.kind ?? '?')),
          h('span', { style: task.state === 'failed' ? S.badText : S.small }, taskStateLabel(task.state)),
          h('span', { style: S.small }, String(task.attempts ?? 0) + '/' + String(task.maxAttempts ?? '?')),
          h('span', { style: S.small }, formatAgo(task.updatedAt)),
          canRetry ? h('button', { type: 'button', 'data-role': 'task-retry', disabled: retry.state.busy, onClick: () => retry.run('retry:' + id, 'tasks.retry', { id }, { hint: '再点一次重试 ' + id + '：会把它放回队列', busy: '正在重试…', done: () => '已重试 ' + id, after: onChanged }), style: retry.state.armed === 'retry:' + id ? { ...S.chip, ...S.chipActive } : S.chip }, retry.state.armed === 'retry:' + id ? '确认重试' : '重试') : null)
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
        h('div', { 'data-role': 'tasks-table' },
          h('div', { style: gridRow(TASK_GRID, true) }, ...['任务', '种类', '状态', '重试', '更新', ''].map(label => h('span', { key: label }, label))),
          ...board.items.map(rowOf),
          board.items.length === 0 ? h('div', { style: S.small, 'data-role': 'tasks-empty' }, board.phase === 'loading' ? '正在读取任务…' : '这个筛选下没有任务') : null),
        h('div', { style: S.sectionHint }, '发货 / 客服两项灰着：daemon 执行器还没接线（deliver 缺 IM 协议与卡密规则引擎，reply 缺 wss 握手心跳）。'))
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
      const enqueue = useWrite(connection)
      const loadTasks = () => callRead(connection, 'tasks.list', taskListParams(filter)).then(reply => setTasks(tasksState(reply)))
      // 任务状态是 daemon 侧异步推进的（排队 → 执行中 → 完成/失败），只拉一次会永远停在入队瞬间，所以按 3 秒轮询。
      React.useEffect(() => { void loadTasks(); const timer = setInterval(() => { void loadTasks() }, POLL_MS); return () => clearInterval(timer) }, [connection, filter.state, filter.kind])
      const results = parseDraftLines(draftText), valid = results.filter(result => result.ok), invalid = results.filter(result => !result.ok)
      const ready = valid.length >= 2 && invalid.length === 0
      const blocked = results.length === 0 ? '先粘贴至少 2 条合法草稿' : invalid.length > 0 ? '有 ' + String(invalid.length) + ' 行校验不通过，先修好再生成' : '至少 2 条合法草稿才能生成（现在 ' + String(valid.length) + ' 条）'
      const request = buildPublishBatchArguments(mode, results, accountId)
      const update = setter => value => { setter(value); setGenerated(null) }
      const accounts = snapshot.phase === 'ok' && snapshot.data !== null && Array.isArray(snapshot.data.accounts) ? snapshot.data.accounts : []
      const accountIds = accounts.map(account => String(account !== null && typeof account === 'object' ? account.accountId ?? '' : '')).filter(id => id !== '')
      const targetAccount = accountId.trim() !== '' ? accountId.trim() : accountIds.length === 1 ? accountIds[0] : ''
      const inline = valid.filter(result => result.kind === 'inline'), plan = buildPublishItems(inline, targetAccount)
      const enqueueBlocked = targetAccount === '' ? '先填账号 id（daemon 里有 0 个或多个账号）' : plan.problems.length > 0 ? plan.problems.join('；') : invalid.length > 0 ? '先修好校验不通过的行' : inline.length === 0 ? '至少 1 条内联草稿才能入队' : ''
      const canEnqueue = enqueueBlocked === ''
      const submitEnqueue = () => enqueue.run('batch', 'batch.enqueue', { batchId: 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), items: plan.items }, { hint: '再点一次「确认入队」：写操作，会进 daemon 队列', busy: '正在入队…', done: value => '已入队 ' + String(value?.batchId ?? '') + ' · ' + String(plan.items.length) + ' 条', after: loadTasks })
      const batch = enqueue.state.result
      const modeButtons = PUBLISH_MODES.map(([value, label, hint]) => h('button', { key: value, type: 'button', 'data-role': 'publish-mode', 'aria-pressed': value === mode, title: hint, onClick: () => update(setMode)(value), style: value === mode ? { ...S.chip, ...S.chipActive } : S.chip }, label))
      const online = snapshot.phase === 'ok' && snapshot.data !== null
      return h('div', null,
        h('div', { style: S.section, 'data-role': 'publish-backend' },
          h('div', { style: online ? S.small : S.warnText }, snapshot.phase === 'loading' ? '正在连接后台…'
            : online ? '后台在线 · ' + describeQueue(snapshot.data.status?.queue ?? {}) + ' · 最近批次 ' + describeBatch(snapshot.data.batch)
              : '后台未连接：入队会失败，去「概览」tab 启动 daemon')),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '流水线'),
          h('div', { style: S.sectionHint }, '草稿 → 校验 → 入队（去重）→ daemon 串行发布，失败进待审 · ' + CATEGORY_MATRIX)),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '草稿集'),
          h('div', { style: S.sectionHint }, '每行一条：内联 JSON（title / desc / price（分）/ images）或 .json 路径；入队只收内联。'),
          h('textarea', { value: draftText, rows: 6, 'data-role': 'draft-input', placeholder: '{"title":"...","desc":"...","price":990,"images":["D:/pics/1.jpg"]}', onChange: event => update(setDraftText)(event.target.value), style: { ...S.input, ...S.textarea } })),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '发布前校验'),
          ...results.map(result => h('div', { key: String(result.index), style: S.cmdRow, 'data-role': 'draft-check', 'data-ok': result.ok }, h('span', { style: S.cmdLabel }, '第 ' + String(result.index + 1) + ' 行'), h('span', { style: result.ok ? S.okText : S.badText }, result.message))),
          h('div', { style: S.sectionHint }, '通过 ' + String(valid.length) + ' · 未通过 ' + String(invalid.length) + '（至少 2 条才能生成）')),
        h('div', { style: S.section },
          h('div', { style: S.fieldRow }, h('div', { style: S.field }, h('span', { style: S.fieldLabel }, '模式'), h('div', { style: S.chipRow }, ...modeButtons))),
          h(Field, { label: '账号（可选）', control: h('input', { type: 'text', value: accountId, placeholder: 'daemon 账号 id，默认唯一账号', onChange: event => update(setAccountId)(event.target.value), style: S.input }) }),
          h('div', { style: S.buttonRow },
            h('button', { type: 'button', 'data-role': 'publish-batch-submit', disabled: !ready, title: ready ? '组装 xy_publish_batch 参数 JSON' : blocked, onClick: () => setGenerated(request), style: ready ? S.primary : S.offButton }, '生成批量发布请求'),
            h('button', { type: 'button', 'data-role': 'batch-enqueue', disabled: !canEnqueue || enqueue.state.busy, title: canEnqueue ? '把内联草稿写进 daemon 队列（写操作，点两次）' : enqueueBlocked, onClick: submitEnqueue, style: canEnqueue && !enqueue.state.busy ? S.primary : S.offButton }, enqueue.state.armed === 'batch' ? '确认入队' : enqueue.state.busy ? '入队中…' : '校验并入队')),
          resultLine(batch, 'batch-result'),
          ...(batch !== null && batch.value !== undefined && Array.isArray(batch.value.tasks) ? batch.value.tasks.map((task, index) => h('div', { key: String(index), style: S.small, 'data-role': 'batch-item' }, '第 ' + String(index + 1) + ' 条 · ' + taskStateLabel(task.state) + (Array.isArray(batch.value.created) && batch.value.created[index] === false ? '（已存在，跳过）' : ''))) : [])),
        h(TasksTable, { connection, board: tasks, filter, onFilter: setFilter, onChanged: loadTasks }),
        generated === null ? null : h('div', { style: S.preview }, h('div', { style: S.sectionTitle }, 'xy_publish_batch 参数已就绪'), h('pre', { style: S.pre, 'data-role': 'publish-request' }, JSON.stringify(generated, null, 2))))
    }
