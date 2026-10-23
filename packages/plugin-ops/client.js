    // 生成物：由 scripts/build-client.mjs 从 src/client-bundle/*.part.js 拼接而成，不要直接编辑本文件。
/**
 * BigFish 运营面板（client bundle；手写 loader 产物，id 必须等于包名）。
 * 只做 UI 与只读状态：daemon 状态走 ctx.connection.rpc.call('/bigfish', ...) 每 3 秒轮询，
 * 失败统一降级成一行提示；写操作仍由 agent 走 host 侧审批门禁。
 * @module @bigfish/plugin-ops/client
 */
window.__ModuleLoader__.load({
  id: '@bigfish/plugin-ops',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const ICON_STYLE = { display: 'block', lineHeight: '1' }
    /** 面板内模块 tab：全部在侧边栏面板里切换（不注册 conversation.view）。 */
    const PANEL_TABS = [
      { id: 'publish-batch', label: '自动发布' }, { id: 'account', label: '账号' }, { id: 'copy', label: '文案' },
      { id: 'reference', label: '采集' }, { id: 'overview', label: '概览' }, { id: 'diagnose', label: '诊断' },
    ]
    const PUBLISH_MODES = [['dry-run', 'dry-run（只填表）', '只填表、不点提交'], ['enqueue', 'enqueue（入队，走审批）', '入队后由 daemon 执行，需要审批门禁']]
    /** 语言风格展示副本；权威定义在 src/copy.js 的 COPY_STYLES，漂移由单测守护。 */
    const COPY_STYLE_OPTIONS = [
      { id: 'plain', label: '闲鱼口语', summary: '短句直给，像老买家聊天，不客套' },
      { id: 'warm', label: '亲切安利', summary: '带使用感受与推荐理由，语气温和' },
      { id: 'professional', label: '参数党', summary: '参数与成色逐条列清楚，适合数码、器材' },
      { id: 'urgent', label: '急出清仓', summary: '搬家/换新/清库存，节奏快、直奔交易条件' },
      { id: 'story', label: '场景氛围', summary: '以使用场景开头，适合家居、服饰、手作' },
    ]
    /** 成色选项，与 skill 的 condition 枚举一致。 */
    const CONDITION_OPTIONS = [
      { id: 'new', label: '全新' }, { id: 'like-new', label: '几乎全新' }, { id: 'light-wear', label: '轻微使用痕迹' },
      { id: 'visible-wear', label: '明显使用痕迹' }, { id: 'flawed', label: '有瑕疵' },
    ]
    const CATEGORY_MATRIX = '✅ 电子资料 / 学习笔记 / 课业本；❌ 教材教辅 / 语言与兴趣培训 / 学习资料定制 / 文学 / 考研咨询（网页端不支持发布）'
    /**
     * 片段 02：草稿集解析与发布参数组装（纯数据：不联网、不碰 daemon、只组 JSON）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 逐行解析草稿集（内联 JSON 对象或 .json 路径）：路径条目交给 host 侧读取，这里只认形状。 */
    function parseDraftLines(text) {
      return text.split('\n').map(line => line.trim()).filter(line => line !== '').map((line, index) => {
        if (!line.startsWith('{')) {
          return /\.json$/i.test(line)
            ? { index, kind: 'path', ok: true, path: line, message: '路径条目（host 侧读取，面板不校验内容）' }
            : { index, kind: 'bad', ok: false, message: '既不是内联 JSON 对象，也不是 .json 路径' }
        }
        let draft
        try { draft = JSON.parse(line) } catch { return { index, kind: 'inline', ok: false, message: 'JSON 不合法' } }
        if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return { index, kind: 'inline', ok: false, message: 'JSON 不是对象' }
        const missing = ['title', 'price', 'images'].filter(key => draft[key] === undefined || draft[key] === null || draft[key] === '' || (Array.isArray(draft[key]) && draft[key].length === 0))
        return missing.length === 0
          ? { index, kind: 'inline', ok: true, draft, message: '格式通过' }
          : { index, kind: 'inline', ok: false, draft, message: '缺 ' + missing.join(' / ') }
      })
    }
    /** 组装 xy_publish_batch 参数：只组数据，不执行。 */
    function buildPublishBatchArguments(mode, results, accountId) {
      const args = {
        mode,
        draftPaths: results.filter(result => result.kind === 'path').map(result => result.path),
        drafts: results.filter(result => result.kind === 'inline' && result.ok).map(result => result.draft),
      }
      if (accountId.trim() !== '') args.accountId = accountId.trim()
      return args
    }
    /**
     * 模板兜底：rpc `copy.templates` 拉不到（daemon 未起、宿主里是旧插件）时，至少能填最小事实。
     * 有模板时以 host 下发的为准——client 不复刻品类表，避免第二份定义漂移。
     */
    const FALLBACK_TEMPLATE = {
      common: [
        { id: 'productName', label: '商品名', type: 'text', group: 'base', required: true, maxLength: 120 },
        { id: 'priceYuan', label: '售价（元）', type: 'text', group: 'base', required: true, maxLength: 20 },
        { id: 'condition', label: '成色', type: 'enum', group: 'base', required: true, options: CONDITION_OPTIONS.map(option => ({ value: option.id, label: option.label })) },
      ],
      categories: [{ id: 'other', label: '其他', categoryHint: '', specs: [] }],
    }
    /** 输入框占位符：只影响手感，不参与组装。 */
    const FIELD_PLACEHOLDERS = {
      productName: '如：iPhone 13 128G 星光色',
      priceYuan: '如：129.90',
      imagePaths: 'D:/pics/01.jpg, D:/pics/02.jpg',
      flaws: '边框两处磕碰, 屏幕无划痕',
      accessories: '原装充电线, 包装盒',
      reason: '换新机后闲置 / 搬家清库存',
    }
    function isTemplateField(value) {
      return value !== null && typeof value === 'object'
        && typeof value.id === 'string' && typeof value.label === 'string'
        && typeof value.type === 'string'
    }
    /** 手写窄化：host 的响应也是外部输入，形状不对就当离线处理。 */
    function isTemplateShape(value) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.common) || !Array.isArray(value.categories)) return false
      return value.common.every(isTemplateField) && value.categories.every(category => category !== null && typeof category === 'object'
        && typeof category.id === 'string' && typeof category.label === 'string'
        && Array.isArray(category.specs) && category.specs.every(isTemplateField))
    }
    /** 当前品类的字段全集：通用字段 + 该品类规格。 */
    function fieldsOfTemplate(template, categoryId) {
      const category = template.categories.find(item => item.id === categoryId) ?? template.categories[0]
      return [...template.common, ...(category === undefined ? [] : category.specs)]
    }
    /**
     * 勾选语义：勾选 = 允许写进本次文案。
     * 必填恒选；品类规格默认选（选了品类就是要把这些信息说清楚），可显式取消；其余默认不选。
     */
    function fieldPicked(field, form) {
      if (field.required === true) return true
      if (field.group === 'specs') return form.picked[field.id] !== false
      return form.picked[field.id] === true
    }
    /** 全选：非必填项全部显式选中（必填本来就恒选）。 */
    function allPicked(fields) {
      const picked = {}
      for (const field of fields) if (field.required !== true) picked[field.id] = true
      return picked
    }
    /** 清空：规格默认是选中的，必须显式 false 才能取消。 */
    function clearedPicked(fields) {
      const picked = {}
      for (const field of fields) if (field.required !== true) picked[field.id] = false
      return picked
    }
    /** 组装 xy_copy_plan 参数（纯数据）；未勾选/未填的字段一律不出现，避免模型替你编。 */
    function buildCopyPlanArguments(form, fields) {
      const args = { styleId: form.styleId }
      const specs = {}
      for (const field of fields) {
        if (!fieldPicked(field, form)) continue
        const raw = form.values[field.id]
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) continue
        if (field.group === 'specs') { specs[field.id] = String(raw).trim(); continue }
        if (field.type === 'integer') {
          const number = Number(raw)
          if (Number.isSafeInteger(number)) args[field.id] = number
          continue
        }
        if (field.type === 'bool') { if (raw === true) args[field.id] = true; continue }
        if (field.type === 'list') {
          const items = String(raw).split(/[,，\n]/u).map(item => item.trim()).filter(item => item !== '')
          if (items.length > 0) args[field.id] = items
          continue
        }
        args[field.id] = String(raw).trim()
      }
      if (Object.keys(specs).length > 0) args.specs = specs
      return { tool: 'xy_copy_plan', arguments: args }
    }
    /** 内联草稿 → publish 任务（面板的 price 是分）；daemon 执行时 title/desc/priceCents/images 必填，缺了在这里拦下。 */
    function buildPublishItems(results, accountId) {
      const items = [], problems = []
      for (const result of results) {
        const draft = result.draft ?? {}, priceCents = Number(draft.price), desc = typeof draft.desc === 'string' ? draft.desc.trim() : ''
        const invalid = typeof draft.title !== 'string' || draft.title.trim() === '' || desc === '' || !Number.isSafeInteger(priceCents) || priceCents <= 0 || !Array.isArray(draft.images) || draft.images.length === 0
        if (invalid) { problems.push('第 ' + String(result.index + 1) + ' 行缺 title / desc / price / images'); continue }
        const payload = { accountId, title: draft.title.trim(), desc, priceCents, images: draft.images }
        if (typeof draft.category === 'string' && draft.category.trim() !== '') payload.category = draft.category.trim()
        items.push({ kind: 'publish', dedupeKey: 'publish:' + JSON.stringify([payload.title, payload.desc, priceCents, draft.images, payload.category ?? null]), payload })
      }
      return { items, problems }
    }
    /** settings 对象 → 表单初值（发布间隔按秒展示）。 */
    function settingsForm(settings) { return { interval: String(Math.round(Number(settings.publishMinIntervalMs ?? 0) / 1000)), category: String(settings.defaultCategory ?? ''), style: String(settings.copyStyle ?? COPY_STYLE_OPTIONS[0].id) } }
    const resultLine = (result, role) => result === null ? null : h('div', { style: result.kind === 'bad' ? S.badText : result.kind === 'ok' ? S.goodText : S.small, 'data-role': role }, result.text)
    function gridRow(columns, head) { return { display: 'grid', gridTemplateColumns: columns, gap: '8px', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)', fontSize: head ? '12px' : '13px', color: head ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)' } }
    const TASK_GRID = 'minmax(110px, 1.2fr) 70px 84px 64px 92px 78px'

    /**
     * 片段 03：client → host 的只读 rpc 与轮询（连接探测、两次确认的写动作、快照与事件流）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    // —— 实时状态：client → host rpc（只读端点）——
    const RPC_CHANNEL = '/bigfish'
    const POLL_MS = 3000
    const OFFLINE_TEXT = '未连接后台（daemon 未启动）'
    /** 队列状态的展示顺序与中文名；与 src/rpc.js 的 TASK_STATES 一致。 */
    const TASK_STATE_LABELS = [['queued', '排队'], ['leased', '执行中'], ['done', '完成'], ['failed', '失败'], ['needs_review', '待审']]
    function taskStateLabel(value) { const hit = TASK_STATE_LABELS.find(([state]) => state === value); return hit === undefined ? (typeof value === 'string' && value !== '' ? value : '未知') : hit[1] }
    /** tasks.list 的回复 → 任务表状态（rpc 失败只降级成 offline，不把错误当空列表渲染）。 */
    const tasksState = reply => ({ phase: reply.ok ? 'ok' : 'offline', items: reply.ok && Array.isArray(reply.value) ? reply.value : [] })
    /** 读连接服务：宿主没给 connection / 没有 rpc.call 时返回 null，让面板降级而不是抛错。 */
    function readConnection(ctx) {
      try {
        const connection = ctx.connection
        if (connection === null || connection === undefined) return null
        if (connection.rpc === null || connection.rpc === undefined || typeof connection.rpc.call !== 'function') return null
        return connection
      } catch { return null }
    }
    /**
     * 单次只读 rpc：传输失败、信封非法、handler 抛错都折成 { ok:false }，绝不冒泡。
     * 失败时带上 error.code 与 message：面板要区分「daemon 断了」和「宿主加载的是旧插件、
     * 根本没有这个 rpc」——两者都表现为一次失败的 rpc，但用户该做的事完全不同；
     * message 用于展示可操作的原因（例如「短链需要在浏览器打开」）。
     */
    async function callRead(connection, endpoint, payload) {
      if (connection === null) return { ok: false, code: '', message: '' }
      try {
        const reply = await connection.rpc.call(RPC_CHANNEL, endpoint, payload ?? {})
        if (reply !== null && typeof reply === 'object' && reply.ok === true) return { ok: true, value: reply.value }
        const error = reply !== null && typeof reply === 'object' ? reply.error : undefined
        const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : ''
        return { ok: false, code, message }
      } catch { return { ok: false, code: '', message: '' } }
    }
    /** 面板动作（启停 daemon）：与只读快照不同，这里要把 error.message 带回 UI。 */
    async function callAction(connection, endpoint, payload) {
      if (connection === null || connection === undefined) return { ok: false, message: '宿主没有连接服务，无法操作 daemon；请在 DSH 桌面端打开面板' }
      try {
        const reply = await connection.rpc.call(RPC_CHANNEL, endpoint, payload ?? {})
        if (reply !== null && typeof reply === 'object' && reply.ok === true) return { ok: true, message: '', value: reply.value }
        const error = reply !== null && typeof reply === 'object' ? reply.error : undefined
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== ''
          ? error.message
          : '操作失败（rpc 返回 error 信封）'
        return { ok: false, message }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'rpc 调用失败' }
      }
    }
    /** 进程管理按钮的状态机：停止要点两次（第一次只上膛），避免误触停掉正在跑的队列。 */
    function useDaemonAction(connection) {
      const [state, setState] = React.useState({ busy: '', stopArmed: false, notice: null })
      const run = (endpoint, payload, doneText) => {
        setState(previous => ({ ...previous, busy: endpoint, stopArmed: false, notice: null }))
        void callAction(connection, endpoint, payload).then(result => {
          setState(previous => ({ ...previous, busy: '', notice: result.ok ? { kind: 'ok', text: doneText } : { kind: 'bad', text: result.message } }))
        })
      }
      const start = () => { if (state.busy !== '') return; run('daemon.start', {}, '已请求启动 daemon，等下一次轮询确认在线') }
      const stop = () => {
        if (state.busy !== '') return
        if (!state.stopArmed) {
          setState(previous => ({ ...previous, stopArmed: true, notice: { kind: 'warn', text: '再点一次「确认停止」才会停 daemon：在飞任务会被中断（任务保持 queued，下次启动后继续）' } }))
          return
        }
        run('daemon.stop', { confirm: true }, 'daemon 已停止；队列暂停执行，面板下一次轮询会转为离线')
      }
      const cancelStop = () => { setState(previous => ({ ...previous, stopArmed: false, notice: null })) }
      return { state, start, stop, cancelStop }
    }
    /** 写类动作点两次：第一次只上膛并给提示，第二次带 confirm:true 才发（host 门禁要求）。 */
    function useWrite(connection) {
      const [state, setState] = React.useState({ armed: '', busy: false, result: null })
      const run = (key, endpoint, payload, texts) => {
        if (state.busy) return
        if (state.armed !== key) return setState({ armed: key, busy: false, result: { kind: 'hint', text: texts.hint } })
        setState({ armed: '', busy: true, result: { kind: 'hint', text: texts.busy } })
        void callAction(connection, endpoint, { ...payload, confirm: true }).then(reply => {
          if (reply.ok && texts.after !== undefined) void texts.after(reply.value)
          setState({ armed: '', busy: false, result: reply.ok ? { kind: 'ok', text: texts.done(reply.value), value: reply.value } : { kind: 'bad', text: truncateText(reply.message) } })
        })
      }
      return { state, run }
    }
    /** 从 tasks.list 找最新一条带 batchId 的任务：daemon 没有「批次列表」读端点，只能反查。 */
    function newestBatchId(tasks) {
      if (!Array.isArray(tasks)) return null
      let newest = null
      for (const task of tasks) {
        if (task === null || typeof task !== 'object' || typeof task.batchId !== 'string' || task.batchId === '') continue
        if (newest === null || Number(task.createdAt ?? 0) > Number(newest.createdAt ?? 0)) newest = task
      }
      return newest === null ? null : newest.batchId
    }
    /** 一次轮询：5 个必需读端点全成功才算在线；批次明细失败不影响主状态。 */
    async function readDaemon(connection) {
      const [health, status, accounts, settings, tasks] = await Promise.all([
        callRead(connection, 'health'), callRead(connection, 'status'), callRead(connection, 'accounts'),
        callRead(connection, 'settings.get'), callRead(connection, 'tasks.list', { limit: 50 })])
      if (!health.ok || !status.ok || !accounts.ok || !settings.ok || !tasks.ok) return null
      let batch = null
      const batchId = newestBatchId(tasks.value)
      if (batchId !== null) {
        const reply = await callRead(connection, 'batches.get', { id: batchId })
        const value = reply.value
        if (reply.ok && value !== null && typeof value === 'object') {
          batch = { batchId: String(value.batchId ?? batchId), total: Number(value.total ?? 0), counts: value.counts }
        }
      }
      return { health: health.value, status: status.value, accounts: accounts.value, settings: settings.value, batch }
    }
    /** 3 秒轮询：卸载时清定时器并阻止在途响应 setState；依赖只放 connection（句柄稳定）。 */
    function useDaemonSnapshot(connection) {
      const [snapshot, setSnapshot] = React.useState({ phase: 'loading', data: null })
      React.useEffect(() => {
        let alive = true
        const tick = () => {
          readDaemon(connection)
            .then(data => { if (alive) setSnapshot({ phase: data === null ? 'offline' : 'ok', data }) })
            .catch(() => { if (alive) setSnapshot({ phase: 'offline', data: null }) })
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [connection])
      return snapshot
    }
    /** 事件流每轮拉多少条：够覆盖一次批量发布，又不至于让单次响应过大。 */
    const EVENT_PAGE_LIMIT = 200
    /** 面板只留最近 300 条事件：长开侧边栏时内存不随事件数无限增长。 */
    const EVENT_BUFFER_LIMIT = 300
    /** 步骤事件的状态文案（daemon 侧映射：开始/完成/失败…）。 */
    const STEP_STATE_LABELS = [['started', '开始'], ['done', '完成'], ['failed', '失败']]
    /**
     * 增量轮询 GET /events：游标放闭包里（React state 异步，读旧值会重复拉取）；
     * 连接句柄变了就重建 effect、游标归零重播最近一页。
     */
    function useWorkflowEvents(connection) {
      const [stream, setStream] = React.useState({ phase: 'loading', events: [], code: '' })
      React.useEffect(() => {
        let alive = true
        let since = 0
        const tick = () => {
          callRead(connection, 'events.list', { since, limit: EVENT_PAGE_LIMIT })
            .then(reply => {
              if (!alive) return
              if (!reply.ok) {
                setStream(previous => previous.phase === 'offline' && previous.code === reply.code
                  ? previous : { ...previous, phase: 'offline', code: reply.code })
                return
              }
              const value = reply.value ?? {}
              const items = Array.isArray(value.items) ? value.items : []
              const nextSince = Number.isInteger(value.nextSince) && value.nextSince >= since ? value.nextSince : since
              if (items.length === 0 && nextSince === since) {
                setStream(previous => previous.phase === 'ok' ? previous : { ...previous, phase: 'ok', code: '' })
                return
              }
              since = nextSince
              setStream(previous => ({ phase: 'ok', events: previous.events.concat(items).slice(-EVENT_BUFFER_LIMIT), code: '' }))
            })
            .catch(() => { if (alive) setStream(previous => previous.phase === 'offline' ? previous : { ...previous, phase: 'offline', code: '' }) })
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [connection])
      return stream
    }
    /** 事件 → 「任务 → 步骤」两级结构：任务按首次出现顺序，步骤保持到达顺序。 */
    function groupEventsByTask(events) {
      const order = []
      const byTask = new Map()
      for (const event of Array.isArray(events) ? events : []) {
        if (event === null || typeof event !== 'object') continue
        const taskId = typeof event.taskId === 'string' ? event.taskId : ''
        if (taskId === '') continue
        let node = byTask.get(taskId)
        if (node === undefined) {
          node = { taskId, batchId: null, state: '', steps: [] }
          byTask.set(taskId, node)
          order.push(node)
        }
        if (typeof event.batchId === 'string' && event.batchId !== '') node.batchId = event.batchId
        // 状态只认 task.state 事件；步骤事件里的 started/done 是步骤状态，别把任务状态覆盖成它。
        if (event.kind === 'task.state' && typeof event.state === 'string' && event.state !== '') node.state = event.state
        if (event.kind === 'task.step' && typeof event.step === 'string') node.steps.push(event)
      }
      return order
    }
    /** 毫秒 → 人读时长；异常值显示 ?，不让 NaN 进 UI。 */
    function formatUptime(ms) {
      const total = Number(ms)
      if (!Number.isFinite(total) || total < 0) return '?'
      const seconds = Math.floor(total / 1000)
      if (seconds < 60) return String(seconds) + ' 秒'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return String(minutes) + ' 分钟'
      return String(Math.floor(minutes / 60)) + ' 小时 ' + String(minutes % 60) + ' 分钟'
    }
    /** 队列计数：固定顺序输出，缺字段按 0。 */
    function describeQueue(queue) {
      return TASK_STATE_LABELS.map(([state, label]) => label + ' ' + String(queue[state] ?? 0)).join(' · ')
    }
    /** 最近批次摘要：非零计数才列，避免「失败 0」刷屏。 */
    function describeBatch(batch) {
      if (batch === null) return '暂无批次'
      const counts = batch.counts ?? {}
      const parts = TASK_STATE_LABELS.filter(([state]) => counts[state] > 0).map(([state, label]) => label + ' ' + String(counts[state]))
      return batch.batchId + ' · 共 ' + String(batch.total) + (parts.length === 0 ? '' : ' · ' + parts.join(' · '))
    }

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

    /**
     * 片段 07：设置表单、daemon 状态卡、工作流树、「诊断」tab。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 设置：发布间隔（秒）/ 默认类目 / 文案风格；保存是写类，点两次才发 settings.put，成功后重新拉 settings.get。 */
    function SettingsForm({ connection, settings }) {
      const save = useWrite(connection)
      const [form, setForm] = React.useState(settingsForm(settings))
      const seconds = Number(form.interval)
      const valid = Number.isFinite(seconds) && seconds >= 30 && seconds <= 3600 && form.category.trim() !== ''
      const patch = { publishMinIntervalMs: Math.round(seconds * 1000), defaultCategory: form.category.trim(), copyStyle: form.style }
      const refresh = () => { void callRead(connection, 'settings.get').then(reply => { if (reply.ok && reply.value !== null && typeof reply.value === 'object') setForm(settingsForm(reply.value)) }) }
      const change = key => event => setForm({ ...form, [key]: event.target.value })
      return h('div', { 'data-role': 'settings-form', style: S.fieldRow },
        h(Field, { label: '发布间隔（秒）', control: h('input', { type: 'number', min: 30, max: 3600, value: form.interval, onChange: change('interval'), style: S.input }) }),
        h(Field, { label: '默认类目', control: h('input', { type: 'text', value: form.category, maxLength: 200, onChange: change('category'), style: S.input }) }),
        h(Field, { label: '文案风格', control: h('select', { value: form.style, onChange: change('style'), style: S.input }, ...COPY_STYLE_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.label))) }),
        h('div', { style: S.buttonRow },
          h('button', { type: 'button', 'data-role': 'settings-save', disabled: !valid || save.state.busy, title: valid ? '写盘并重新读取 settings' : '间隔 30–3600 秒，类目不能为空', onClick: () => save.run('settings', 'settings.put', { patch }, { hint: '再点一次「确认保存」写入设置', busy: '正在保存…', done: () => '设置已保存', after: refresh }), style: valid && !save.state.busy ? S.primary : S.button }, save.state.armed === 'settings' ? '确认保存' : save.state.busy ? '保存中…' : '保存设置')),
        resultLine(save.state.result, 'settings-result'))
    }
    /** daemon 实时状态 + 进程管理；发布页把设置摘要换成可保存的输入。 */
    function DaemonStatus({ connection, snapshot, editable }) {
      const actions = useDaemonAction(connection)
      const online = snapshot.phase === 'ok' && snapshot.data !== null
      const action = actions.state
      const manage = h('div', { style: S.section, 'data-role': 'daemon-manage' },
        h('div', { style: S.sectionTitle }, '进程管理'),
        h('div', { style: S.buttonRow },
          h('button', { type: 'button', 'data-role': 'daemon-start', disabled: online || action.busy !== '', title: online ? 'daemon 已在线' : '让宿主拉起本地 daemon（跳过 30 秒冷却）', onClick: actions.start, style: !online && action.busy === '' ? S.primary : S.button }, action.busy === 'daemon.start' ? '正在启动…' : '启动 daemon'),
          h('button', { type: 'button', 'data-role': 'daemon-stop', disabled: !online || action.busy !== '', title: online ? '停止常驻 daemon（会中断在飞任务）' : 'daemon 未运行', onClick: actions.stop, style: online && action.busy === '' ? S.primary : S.button }, action.stopArmed ? '确认停止 daemon' : action.busy === 'daemon.stop' ? '正在停止…' : '停止 daemon')),
        action.notice === null ? null : h('div', { style: action.notice.kind === 'bad' ? S.badText : S.okText, 'data-role': 'daemon-manage-notice' }, action.notice.text))
      if (snapshot.phase === 'loading') return h('div', { style: S.sectionHint, 'data-role': 'daemon-state' }, '正在连接 daemon…')
      const data = snapshot.data
      if (snapshot.phase !== 'ok' || data === null) return h('div', { 'data-role': 'daemon-state' }, h('div', { style: S.badText }, OFFLINE_TEXT), manage)
      const health = data.health ?? {}
      const accounts = Array.isArray(data.accounts) ? data.accounts : []
      const readyCount = accounts.filter(account => account !== null && typeof account === 'object' && account.ready === true).length
      const line = (role, label, value) => h('div', { style: S.cmdRow, 'data-role': role }, h('span', { style: S.cmdLabel }, label), h('span', null, value))
      return h('div', { style: S.section, 'data-role': 'daemon-state' },
        h('div', { style: S.sectionTitle }, 'daemon 状态'),
        line('daemon-health', 'daemon', '在线 · v' + String(health.version ?? '?') + ' · 已运行 ' + formatUptime(health.uptimeMs)),
        line('daemon-accounts', '账号就绪', String(accounts.length) + ' 个账号 · ' + String(readyCount) + ' 个可写' + (accounts.length === 0 ? '（先导入登录态）' : '')),
        line('daemon-queue', '队列', describeQueue(data.status?.queue ?? {})),
        line('daemon-batch', '最近批次', describeBatch(data.batch)),
        editable ? h(SettingsForm, { connection, settings: data.settings ?? {} }) : null,
        manage)
    }
    /** 诊断页的 daemon 状态：自己拉快照，设置只读。 */
    function DaemonView({ connection }) { return h(DaemonStatus, { connection, snapshot: useDaemonSnapshot(connection), editable: false }) }

    /** 工作流树：把 /events 的增量事件渲染成「任务 → 步骤」，只显示最近 6 个任务 × 最近 6 步。 */
    function WorkflowTree({ connection }) {
      const stream = useWorkflowEvents(connection)
      const tasks = groupEventsByTask(stream.events).slice(-6).reverse()
      // UNSUPPORTED 只可能来自「宿主加载的是重启前的旧插件」：该重启 DSH 桌面应用，不是重启 daemon。
      const hint = stream.phase === 'loading' ? '正在读取步骤事件…'
        : stream.phase === 'offline' ? (stream.code === 'UNSUPPORTED' ? '这一版面板需要宿主里加载新版插件，但现在跑的是重启前的旧代码（没有 events.list 这个 rpc）：重启 DSH 桌面应用后自动恢复' : '事件流拉取失败（daemon 离线，或旧 daemon 没有 /events）')
          : tasks.length === 0 ? '还没有步骤事件：daemon 执行任务时才会写' : '最近 ' + String(tasks.length) + ' 个任务，每 3 秒增量追加'
      const stepLine = (task, step, index) => {
        const state = typeof step.state === 'string' ? step.state : ''
        const hit = STEP_STATE_LABELS.find(([value]) => value === state)
        const text = String(step.step ?? '?') + ' · ' + (hit === undefined ? taskStateLabel(state) : hit[1]) + (typeof step.message === 'string' && step.message !== '' ? ' · ' + step.message : '')
        return h('div', { key: task.taskId + '-step-' + String(index), style: S.cmdRow, 'data-role': 'workflow-step', 'data-step-state': state }, h('span', { style: S.cmdLabel }, '步骤'), h('span', { style: state === 'failed' ? S.badText : S.okText }, text))
      }
      return h('div', { style: S.section, 'data-role': 'workflow-tree' },
        h('div', { style: S.sectionTitle }, '工作流（现在在干嘛）'),
        h('div', { style: S.sectionHint }, hint),
        ...tasks.map(task => h('div', { key: task.taskId, 'data-role': 'workflow-task', 'data-task-id': task.taskId },
          h('div', { style: S.cmdRow }, h('span', { style: S.cmdLabel }, '任务 ' + task.taskId.slice(0, 12) + (task.batchId === null ? '' : ' · 批次 ' + task.batchId)), h('span', { style: S.okText }, '状态 ' + taskStateLabel(task.state))),
          ...task.steps.slice(-6).map((step, index) => stepLine(task, step, index)))))
    }

    /** 诊断页：daemon 实时状态 + 只读工具与进程命令。 */
    function DiagnoseTab({ connection }) {
      return h('div', null,
        h(DaemonView, { connection }),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '工具与命令'),
          h('div', { style: S.cmdRow }, ...['xy_status', 'xy_tasks_list', 'xy_items_list', 'xy_ping'].map(name => h('code', { key: name, style: S.cmdCode }, name))),
          h('div', { style: S.cmdRow }, h('code', { style: S.cmdCode }, 'npm run daemon'), h('code', { style: S.cmdCode }, 'npm run dsh:dev -- --fresh'))))
    }

    /**
     * 片段 08：面板骨架（tab 分发 + 面板级状态，切 tab 不丢输入）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 当前 tab 的内容区；copy 页的状态留在 Panel 里（切走再切回不丢输入）。 */
    function PanelBody({ tab, copyProps, connection }) {
      if (tab === 'publish-batch') return h(PublishBatchView, { connection })
      if (tab === 'account') return h(AccountView, { connection })
      if (tab === 'copy') return h(CopyStudio, copyProps)
      if (tab === 'reference') return h(ReferenceView, { connection })
      if (tab === 'diagnose') return h(DiagnoseTab, { connection })
      return h('div', { style: S.section },
        h('div', { style: S.sectionHint }, '登录态导入：xy_import_account（本机 Chrome → 加密凭据）；daemon：127.0.0.1:47001（前台进程）。'),
        h('div', { style: S.cmdRow }, h('code', { style: S.cmdCode }, 'npm run daemon:import-account'), h('code', { style: S.cmdCode }, 'npm run daemon')))
    }

    /** 面板骨架：顶部 tab + 内容区 + 门禁说明。connection 由 apply 注入（模块级单实例）。 */
    function BigFishPanel() {
      const [tab, setTab] = React.useState(PANEL_TABS[0].id)
      const [template, setTemplate] = React.useState({ phase: 'loading', data: FALLBACK_TEMPLATE })
      const [copyForm, setCopyForm] = React.useState({
        categoryId: 'digital', styleId: COPY_STYLE_OPTIONS[0].id,
        picked: {}, values: { condition: 'like-new', shipping: 'free' }, submitted: false,
      })
      // 品类模板只拉一次（纯常量、不轮询）；失败就用兜底模板，面板照常可用。
      React.useEffect(() => {
        let alive = true
        void callRead(panelConnection, 'copy.templates').then(reply => {
          if (!alive) return
          const ok = reply.ok && isTemplateShape(reply.value)
          setTemplate({ phase: ok ? 'ok' : 'offline', data: ok ? reply.value : FALLBACK_TEMPLATE })
        })
        return () => { alive = false }
      }, [])
      const fields = fieldsOfTemplate(template.data, copyForm.categoryId)
      const name = copyForm.values.productName, price = copyForm.values.priceYuan
      const ready = typeof name === 'string' && name.trim() !== '' && typeof price === 'string' && price.trim() !== ''
      // 任一输入变化都撤销「已就绪」，避免拿着旧参数去生成。
      const patch = next => setCopyForm(previous => ({ ...previous, ...next, submitted: false }))
      const copyProps = {
        template, form: copyForm, fields, ready,
        request: buildCopyPlanArguments(copyForm, fields),
        submitted: copyForm.submitted,
        onCategory: id => patch({ categoryId: id }),
        onStyle: id => patch({ styleId: id }),
        onToggle: (id, checked) => setCopyForm(previous => ({ ...previous, submitted: false, picked: { ...previous.picked, [id]: checked } })),
        onValue: (id, value) => setCopyForm(previous => ({ ...previous, submitted: false, values: { ...previous.values, [id]: value } })),
        onPickAll: () => setCopyForm(previous => ({ ...previous, submitted: false, picked: allPicked(fields) })),
        onClear: () => setCopyForm(previous => ({ ...previous, submitted: false, picked: clearedPicked(fields) })),
        onSubmit: () => setCopyForm(previous => ({ ...previous, submitted: true })),
      }
      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', { style: S.logo }, '🐟'),
          h('div', null,
            h('div', { style: S.title }, 'BigFish 闲鱼运营'),
            h('div', { style: S.subtitle }, '发布 / 账号 / 文案 / 采集 · 面板只组参数，执行交给 agent 与 daemon'))),
        h(TabBar, { active: tab, onSelect: setTab }),
        h(PanelBody, { tab, copyProps, connection: panelConnection }))
    }

    /**
     * 片段 09：「自动发布」tab（任务表 + 草稿集校验入队）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 任务区：最近 20 条；failed / needs_review 可重试（两次确认），执行中与完成不给按钮。 */
    function TasksTable({ connection, board, onChanged }) {
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
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, '任务（最近 20 条）'),
        resultLine(retry.state.result, 'task-result'),
        h('div', { 'data-role': 'tasks-table' },
          h('div', { style: gridRow(TASK_GRID, true) }, ...['任务', '种类', '状态', '重试', '更新', ''].map(label => h('span', { key: label }, label))),
          ...board.items.map(rowOf),
          board.items.length === 0 ? h('div', { style: S.small, 'data-role': 'tasks-empty' }, board.phase === 'loading' ? '正在读取任务…' : '队列里还没有任务') : null))
    }
    /** 「自动发布」模块：daemon 状态与设置 + 工作流 + 任务 + 草稿集校验入队 + 组参数。 */
    function PublishBatchView({ connection }) {
      const snapshot = useDaemonSnapshot(connection)
      const [draftText, setDraftText] = React.useState('')
      const [mode, setMode] = React.useState('dry-run')
      const [accountId, setAccountId] = React.useState('')
      const [generated, setGenerated] = React.useState(null)
      const [tasks, setTasks] = React.useState({ phase: 'loading', items: [] })
      const enqueue = useWrite(connection)
      const loadTasks = () => callRead(connection, 'tasks.list', { limit: 20 }).then(reply => setTasks(tasksState(reply)))
      // 任务状态是 daemon 侧异步推进的（排队 → 执行中 → 完成/失败），只拉一次会永远停在入队瞬间，所以按 3 秒轮询。
      React.useEffect(() => { void loadTasks(); const timer = setInterval(() => { void loadTasks() }, 3000); return () => clearInterval(timer) }, [connection])
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
      return h('div', null,
        h(DaemonStatus, { connection, snapshot, editable: true }),
        h(WorkflowTree, { connection }),
        h(TasksTable, { connection, board: tasks, onChanged: loadTasks }),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '流水线'),
          h('div', { style: S.sectionHint }, '草稿 → 校验 → 入队（幂等 dedupeKey）→ daemon 串行发布，每步截图、失败进待审。类目矩阵：' + CATEGORY_MATRIX)),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '草稿集'),
          h('div', { style: S.sectionHint }, '每行一条：内联 JSON（title / desc / price（分）/ images）或 .json 路径（host 侧读取）；入队只收内联草稿。'),
          h('textarea', { value: draftText, rows: 6, 'data-role': 'draft-input', placeholder: '{"title":"...","desc":"...","price":990,"images":["D:/pics/1.jpg"]}', onChange: event => update(setDraftText)(event.target.value), style: { ...S.input, ...S.textarea } })),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '发布前校验'),
          ...results.map(result => h('div', { key: String(result.index), style: S.cmdRow, 'data-role': 'draft-check', 'data-ok': result.ok }, h('span', { style: S.cmdLabel }, '第 ' + String(result.index + 1) + ' 行'), h('span', { style: result.ok ? S.okText : S.badText }, result.message))),
          h('div', { style: S.sectionHint }, '已通过 ' + String(valid.length) + ' 条 / 未通过 ' + String(invalid.length) + ' 条；至少 2 条合法草稿才能生成。')),
        h('div', { style: S.section },
          h('div', { style: S.fieldRow }, h('div', { style: S.field }, h('span', { style: S.fieldLabel }, '模式'), h('div', { style: S.chipRow }, ...modeButtons))),
          h(Field, { label: '账号（可选）', control: h('input', { type: 'text', value: accountId, placeholder: 'daemon 账号 id，默认唯一账号', onChange: event => update(setAccountId)(event.target.value), style: S.input }) }),
          h('div', { style: S.buttonRow },
            h('button', { type: 'button', 'data-role': 'publish-batch-submit', disabled: !ready, title: ready ? '组装 xy_publish_batch 参数 JSON' : blocked, onClick: () => setGenerated(request), style: ready ? S.primary : S.button }, '生成批量发布请求'),
            h('button', { type: 'button', 'data-role': 'batch-enqueue', disabled: !canEnqueue || enqueue.state.busy, title: canEnqueue ? '把内联草稿写进 daemon 队列（写操作，点两次）' : enqueueBlocked, onClick: submitEnqueue, style: canEnqueue && !enqueue.state.busy ? S.primary : S.button }, enqueue.state.armed === 'batch' ? '确认入队' : enqueue.state.busy ? '入队中…' : '校验并入队')),
          resultLine(batch, 'batch-result'),
          ...(batch !== null && batch.value !== undefined && Array.isArray(batch.value.tasks) ? batch.value.tasks.map((task, index) => h('div', { key: String(index), style: S.small, 'data-role': 'batch-item' }, '第 ' + String(index + 1) + ' 条 · ' + taskStateLabel(task.state) + (Array.isArray(batch.value.created) && batch.value.created[index] === false ? '（已存在，跳过）' : ''))) : [])),
        generated === null ? null : h('div', { style: S.preview }, h('div', { style: S.sectionTitle }, 'xy_publish_batch 参数已就绪'), h('pre', { style: S.pre, 'data-role': 'publish-request' }, JSON.stringify(generated, null, 2))),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '命令'),
          h('div', { style: S.cmdRow }, h('code', { style: S.cmdCode }, 'pnpm daemon:publish -- --draft <草稿.json>'), h('code', { style: S.cmdCode }, 'xy_publish_batch（入队/审批走模型）'))))
    }
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
    /**
     * 片段 11：「账号」tab（多账号表、登录检测缓存、保活开关）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    // —— 账号管理：多账号表（切换 / 退出 / 登录态剩余 / 保活）+ 进入即检测（10 分钟内不重复）——
    const VERIFY_TTL_MS = 600_000
    const ACCOUNT_COLUMNS = ['当前', '账号', '登录状态', '登录态剩余', '最近检测', '凭据更新', '操作']
    const ACCOUNT_GRID = '92px minmax(88px, 1fr) 136px 112px 100px 172px 268px'
    const ACCOUNT_CODE_LABELS = { AUTH_EXPIRED: '登录态过期', RISK_CONTROL: '风控拦截', RATE_LIMITED: '被限流', NETWORK: '网络异常', VALIDATION: '参数不合法', INTERNAL: '后台错误' }
    /** 自动检测的 10 分钟缓存：自动检测真调 mtop head（账号级风控敏感），缓存期内重开面板不重复打；行内「检测」仍强制刷新。 */
    const verifyCache = new Map()
    /** 正在检测的账号：3 秒轮询和手动点击可能撞在一起，用模块级集合去重。 */
    const verifyInFlight = new Set()
    function formatClock(ms) { const value = Number(ms); return Number.isFinite(value) && value > 0 ? new Date(value).toTimeString().slice(0, 8) : '—' }
    function formatAgo(ms) { const value = Number(ms); if (!Number.isFinite(value) || value <= 0) return '—'; const minutes = Math.floor((Date.now() - value) / 60_000); if (minutes < 1) return '刚刚'; if (minutes < 60) return String(minutes) + ' 分钟前'; const hours = Math.floor(minutes / 60); return hours < 24 ? String(hours) + ' 小时前' : String(Math.floor(hours / 24)) + ' 天前' }
    /** 登录态剩余：loginExpiresAt 是毫秒时间戳；估算值加后缀，缺失/过期不虚构。 */
    function formatLifetime(expiresAt, source) {
      const value = Number(expiresAt)
      if (!Number.isFinite(value) || value <= 0) return '—'
      const minutes = Math.floor((value - Date.now()) / 60_000)
      if (minutes <= 0) return '已过期'
      const hours = Math.floor(minutes / 60)
      return (hours > 0 ? String(hours) + ' 小时 ' + String(minutes % 60) + ' 分' : String(minutes) + ' 分') + (source === 'estimated' ? '（估算）' : '')
    }
    /** 状态徽标：未检测 / 检测中 / 在线 / 已过期 / 无法确认（网络、限流、风控只影响这一行）。 */
    function accountBadge(entry) {
      if (entry === undefined) return ['未检测', S.small]
      if (entry.phase === 'checking') return ['检测中', S.small]
      if (entry.phase === 'failed') return ['无法确认 · ' + (ACCOUNT_CODE_LABELS[entry.code] ?? '检测请求失败'), S.badText]
      if (entry.online === true) return ['在线', S.goodText]
      if (entry.code === 'AUTH_EXPIRED') return ['已过期', S.badText]
      return ['无法确认 · ' + (ACCOUNT_CODE_LABELS[entry.code] ?? '未返回原因'), S.warnText]
    }
    function truncateText(text) { const value = typeof text === 'string' && text !== '' ? text : '操作失败'; return value.length > 120 ? value.slice(0, 118) + '…' : value }
    /** daemon 摘要里的最近检测（本地没有会话时兜底）；没有 lastCheckedAt 就不虚构。 */
    function storedEntry(account) {
      const checkedAt = Number(account.lastCheckedAt)
      if (!Number.isFinite(checkedAt) || checkedAt <= 0) return undefined
      return { phase: 'done', online: account.lastOnline === true, code: typeof account.lastCode === 'string' ? account.lastCode : '', checkedAt, source: 'auto' }
    }
    /** 保活设置 → 表单初值（间隔按秒展示，缺省 600 秒）。 */
    function keepAliveForm(settings) {
      const seconds = Math.round(Number(settings.keepAliveIntervalMs) / 1000)
      return { enabled: settings.keepAliveEnabled === true, seconds: String(Number.isFinite(seconds) && seconds > 0 ? seconds : 600) }
    }
    /** 账号表：进入自动检测（10 分钟缓存）+ 3 秒轮询摘要；导入 / 扫码 / 退出 / 保活点两次才发 confirm。 */
    function AccountView({ connection }) {
      const [board, setBoard] = React.useState({ phase: 'loading', accounts: [], verifies: {}, keep: null, addId: '', addPort: '9222', result: null })
      const writes = useWrite(connection)
      const [switching, setSwitching] = React.useState('')
      const update = patch => setBoard(previous => ({ ...previous, ...patch }))
      const busy = writes.state.busy || switching !== ''
      /** 只改这一行的状态：检测失败（网络/限流/风控）不降级整页。 */
      const verifyOne = async (accountId, source) => {
        if (verifyInFlight.has(accountId)) return
        verifyInFlight.add(accountId)
        setBoard(previous => ({ ...previous, verifies: { ...previous.verifies, [accountId]: { phase: 'checking' } } }))
        const reply = await callRead(connection, 'accounts.verify', { accountId })
        const value = reply.ok && reply.value !== null && typeof reply.value === 'object' ? reply.value : null
        const entry = value === null
          ? { phase: 'failed', code: reply.code, checkedAt: Date.now(), source }
          : { phase: 'done', online: value.online === true, code: typeof value.code === 'string' ? value.code : '', checkedAt: Number(value.checkedAt) || Date.now(), source }
        verifyCache.set(accountId, { at: Date.now(), entry })
        verifyInFlight.delete(accountId)
        setBoard(previous => ({ ...previous, verifies: { ...previous.verifies, [accountId]: entry } }))
      }
      /** 拉账号摘要；auto=true 时对缓存过期的账号自动检测（新导入的账号也会补一次）。 */
      const pull = async (auto, alive = () => true) => {
        const reply = await callRead(connection, 'accounts')
        if (!alive()) return
        const list = reply.ok && Array.isArray(reply.value) ? reply.value : []
        setBoard(previous => ({ ...previous, phase: reply.ok ? 'ok' : 'offline', accounts: list }))
        if (!auto || !reply.ok) return
        for (const account of list) {
          const accountId = String(account !== null && typeof account === 'object' ? account.accountId ?? '' : '')
          if (accountId === '') continue
          const cached = verifyCache.get(accountId)
          if (cached !== undefined && Date.now() - cached.at < VERIFY_TTL_MS) continue
          if (!alive()) return
          await verifyOne(accountId, 'auto')
        }
      }
      React.useEffect(() => {
        let alive = true
        void pull(true, () => alive)
        const timer = setInterval(() => { if (alive) void pull(true, () => alive) }, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [connection])
      // 保活设置只回填一次：3 秒轮询只刷新账号摘要，免得把正在编辑的输入覆盖掉。
      React.useEffect(() => {
        let alive = true
        void callRead(connection, 'settings.get').then(reply => {
          if (!alive || !reply.ok || reply.value === null || typeof reply.value !== 'object') return
          setBoard(previous => previous.keep === null ? { ...previous, keep: keepAliveForm(reply.value) } : previous)
        })
        return () => { alive = false }
      }, [connection])
      const switchAccount = accountId => {
        if (busy) return
        setSwitching(accountId)
        void callAction(connection, 'accounts.activate', { accountId }).then(reply => {
          setSwitching('')
          update({ result: reply.ok ? { kind: 'ok', text: '已切换到 ' + accountId } : { kind: 'bad', text: truncateText(reply.message) } })
          if (reply.ok) void pull(true)
        })
      }
      /** 第一次点只上膛；第二次带 confirm:true 才发（写类 rpc 的 host 门禁要求）。 */
      const rowTexts = (kind, accountId) => kind === 'import'
        ? { hint: '再点一次「确认导入」：从本机 Chrome 读 cookie 并加密写凭据', busy: '正在导入登录态…', done: () => '登录态已导入', after: () => pull(true) }
        : kind === 'login'
          ? { hint: '再点一次「确认扫码」：打开闲鱼登录页等你扫码，最长 180s', busy: '等待扫码…（最长 180s）', done: () => '扫码登录成功', after: () => pull(true) }
          : { hint: '再点一次：只删本地凭据，不会注销闲鱼网页会话', busy: '正在退出登录…', done: () => '已退出 ' + accountId, after: () => pull(true) }
      const runRowWrite = (kind, accountId) => {
        update({ result: null })
        return writes.run(kind + ':' + accountId, kind === 'import' ? 'accounts.import' : kind === 'login' ? 'accounts.login' : 'accounts.logout', { accountId }, rowTexts(kind, accountId))
      }
      const addTexts = kind => kind === 'import'
        ? { hint: '再点一次「确认导入」：从本机 Chrome 读 cookie 并加密写凭据', busy: '正在导入登录态…', done: value => '登录态已导入' + (value !== null && typeof value === 'object' && typeof value.accountId === 'string' ? ' · ' + value.accountId : ''), after: () => pull(true) }
        : { hint: '再点一次「确认扫码」：打开闲鱼登录页等你扫码，最长 180s', busy: '等待扫码…（最长 180s）', done: value => '扫码登录成功' + (value !== null && typeof value === 'object' && typeof value.accountId === 'string' ? ' · ' + value.accountId : ''), after: () => pull(true) }
      const runAdd = kind => {
        const port = Number(board.addPort)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return update({ result: { kind: 'bad', text: 'Chrome 端口必须是 1..65535 的整数' } })
        const payload = { port }, accountId = board.addId.trim()
        if (accountId !== '') payload.accountId = accountId
        update({ result: null })
        writes.run('add:' + kind, kind === 'import' ? 'accounts.import' : 'accounts.login', payload, addTexts(kind))
      }
      const keep = board.keep ?? { enabled: false, seconds: '600' }
      const keepSeconds = Number(keep.seconds), keepValid = Number.isInteger(keepSeconds) && keepSeconds >= 60 && keepSeconds <= 3600
      /** 保存成功后按 daemon 回读的值重填表单（不信本地推断）。 */
      const reloadKeep = () => { void callRead(connection, 'settings.get').then(reply => { if (reply.ok && reply.value !== null && typeof reply.value === 'object') update({ keep: keepAliveForm(reply.value) }) }) }
      /** 一个按钮管开关：当前关 → 点两次开启；当前开 → 点两次关闭。间隔与开关一起提交，免得两个入口打架。 */
      const toggleKeepAlive = () => {
        if (!keepValid) return update({ result: { kind: 'bad', text: '保活间隔必须是 60..3600 的整数秒' } })
        const enabled = !keep.enabled
        update({ result: null })
        writes.run('keepalive-toggle', 'settings.put', { patch: { keepAliveEnabled: enabled, keepAliveIntervalMs: keepSeconds * 1000 } }, {
          hint: enabled ? '再点一次「确认开启」：daemon 每 ' + keepSeconds + ' 秒校验一次当前账号登录态' : '再点一次「确认关闭」：停止定时校验（已保存的凭据不动）',
          busy: enabled ? '正在开启…' : '正在关闭…', done: () => (enabled ? '保活已开启' : '保活已关闭'), after: reloadKeep,
        })
      }
      /** 开启状态下改间隔：只提交新间隔，开关保持当前值。 */
      const saveKeepInterval = () => {
        if (!keepValid) return update({ result: { kind: 'bad', text: '保活间隔必须是 60..3600 的整数秒' } })
        update({ result: null })
        writes.run('keepalive-interval', 'settings.put', { patch: { keepAliveEnabled: keep.enabled, keepAliveIntervalMs: keepSeconds * 1000 } }, {
          hint: '再点一次「确认保存」写入保活间隔', busy: '正在保存…', done: () => '保活间隔已保存', after: reloadKeep,
        })
      }
      const actionButton = (role, label, onClick, disabled) => h('button', { key: role, type: 'button', 'data-role': role, disabled, onClick, style: disabled ? S.button : S.primary }, label)
      const rowActions = (accountId, checking) => [
        actionButton('account-verify', checking ? '检测中…' : '检测', () => void verifyOne(accountId, 'manual'), checking || busy),
        actionButton('account-import', writes.state.armed === 'import:' + accountId ? '确认导入' : busy ? '导入中…' : '导入', () => runRowWrite('import', accountId), busy),
        actionButton('account-login', writes.state.armed === 'login:' + accountId ? '确认扫码' : busy ? '等待扫码…' : '扫码', () => runRowWrite('login', accountId), busy),
        actionButton('account-logout', writes.state.armed === 'logout:' + accountId ? '确认退出登录' : busy ? '退出中…' : '退出', () => runRowWrite('logout', accountId), busy),
      ]
      const rowOf = account => {
        const accountId = String(account.accountId ?? ''), entry = board.verifies[accountId] ?? storedEntry(account), badge = accountBadge(entry)
        const checking = entry !== undefined && entry.phase === 'checking'
        return h('div', { key: accountId, style: gridRow(ACCOUNT_GRID, false), 'data-role': 'account-row', 'data-account-id': accountId },
          h('div', { style: S.actions },
            account.active === true ? h('span', { key: 'active', style: S.goodText, 'data-role': 'account-active' }, '当前') : null,
            h('button', { key: 'switch', type: 'button', 'data-role': 'account-switch', disabled: busy, title: '把当前账号切到 ' + accountId, onClick: () => switchAccount(accountId), style: S.chip }, switching === accountId ? '切换中…' : '切换')),
          h('span', null, accountId),
          h('span', { style: badge[1], 'data-role': 'account-status' }, badge[0]),
          h('span', { style: S.small, 'data-role': 'account-lifetime' }, formatLifetime(account.loginExpiresAt, account.loginExpiresSource)),
          h('span', { style: S.small, 'data-role': 'account-checked' }, entry === undefined ? '—' : formatClock(entry.checkedAt) + '（' + (entry.source === 'manual' ? '人工' : '自动') + '）'),
          h('span', null,
            h('span', { style: S.small, 'data-role': 'account-updated' }, formatAgo(account.updatedAt) + ' · ' + (account.ready === true ? '字段齐备' : '字段不齐')),
            h('span', { style: S.small, 'data-role': 'account-fields' }, ' · ' + String(account.savedFieldCount ?? '?') + ' 项')),
          h('div', { style: S.actions }, ...rowActions(accountId, checking)))
      }
      const addButton = (role, kind, label) => actionButton(role, writes.state.armed === 'add:' + kind ? (kind === 'import' ? '确认导入' : '确认扫码') : label, () => runAdd(kind), busy)
      const addSection = h('div', { style: S.section, 'data-role': 'account-add' },
        h('div', { style: S.sectionTitle }, '添加账户'),
        h('div', { style: S.fieldRow },
          h(Field, { label: '账号 id（留空 = 从 Chrome 读 unb）', control: h('input', { type: 'text', maxLength: 64, value: board.addId, placeholder: '2206569289277', 'data-role': 'account-add-id', onChange: event => update({ addId: event.target.value }), style: S.input }) }),
          h(Field, { label: 'Chrome 调试端口', control: h('input', { type: 'number', min: 1, max: 65535, value: board.addPort, 'data-role': 'account-add-port', onChange: event => update({ addPort: event.target.value }), style: S.input }) })),
        // 两种入口的前置条件不同，「导入」必须由用户先把带调试端口的浏览器准备好（面板不能替他登录），
        // 「扫码」会由 daemon 自己拉起窗口：写清这一句，省掉「点了没反应/报连不上」的往返。
        h('div', { style: S.small, 'data-role': 'account-add-hint' }, '「从 Chrome 导入」需要先用 --remote-debugging-port=' + String(board.addPort) + ' 启动并登录闲鱼的 Chrome；「扫码登录」由后台自己打开浏览器窗口。'),
        h('div', { style: S.buttonRow }, addButton('account-add-import', 'import', '从 Chrome 导入'), addButton('account-add-login', 'login', '扫码登录')))
      const keepButtonLabel = writes.state.armed === 'keepalive-toggle'
        ? (keep.enabled ? '确认关闭' : '确认开启')
        : busy ? '请稍候…' : (keep.enabled ? '关闭保活' : '开启保活')
      const keepaliveSection = h('div', { style: S.section, 'data-role': 'account-keepalive' },
        h('div', { style: S.sectionTitle }, '登录保活'),
        h('div', { style: S.fieldRow },
          h('div', { style: { ...S.buttonRow, marginTop: '0', alignSelf: 'flex-end' } }, actionButton('keepalive-toggle', keepButtonLabel, toggleKeepAlive, !keepValid || busy)),
          h(Field, { label: '间隔（秒，60–3600）', control: h('input', { type: 'number', min: 60, max: 3600, value: keep.seconds, 'data-role': 'keepalive-interval', onChange: event => update({ keep: { ...keep, seconds: event.target.value } }), style: S.input }) }),
          h('div', { style: { ...S.buttonRow, marginTop: '0', alignSelf: 'flex-end' } }, actionButton('keepalive-save', writes.state.armed === 'keepalive-interval' ? '确认保存' : busy ? '保存中…' : '保存间隔', saveKeepInterval, !keepValid || busy))),
        h('div', { style: { ...S.small, marginTop: '10px' }, 'data-role': 'keepalive-state' }, keep.enabled ? '已开启：每 ' + keep.seconds + ' 秒校验一次当前账号登录态' : '未开启'))
      const emptyRow = h('div', { style: gridRow(ACCOUNT_GRID, false), 'data-role': 'account-empty' }, h('span', { style: { ...S.small, gridColumn: 'span 7' } }, '还没有导入账号'))
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, '账号管理'),
        addSection,
        keepaliveSection,
        board.phase === 'loading' ? h('div', { style: S.small }, '正在读取账号…') : null,
        board.phase === 'offline' ? h('div', { style: S.badText, 'data-role': 'account-offline' }, '连不上 daemon：启动 daemon 后重开本页') : null,
        h('div', { 'data-role': 'account-table' },
          h('div', { style: gridRow(ACCOUNT_GRID, true) }, ...ACCOUNT_COLUMNS.map(label => h('span', { key: label }, label))),
          ...board.accounts.map(rowOf), board.phase === 'ok' && board.accounts.length === 0 ? emptyRow : null),
        resultLine(board.result ?? writes.state.result, 'account-result'))
    }
    /**
     * 片段 12：连接句柄与 apply（只注册侧边栏栏位 + 主面板）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 当前连接句柄：apply 时从 ctx 取一次（服务由宿主注入；缺失则 null → 面板降级）。 */
    let panelConnection = null

    function apply(ctx) {
      panelConnection = readConnection(ctx)
      // 用 inject 而不是直接 register：slots 由宿主插件声明，早于声明注册会在加载期抛错。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'bigfish', order: 30, label: 'BigFish 闲鱼运营',
      }, BigFishIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'bigfish' }, BigFishPanel))
    }
    return { apply, inject: ['slots', 'connection'] }
  },
})