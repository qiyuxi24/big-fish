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
    /** 面板上的按钮都只能看（原因见 BUTTON_NOTE）。 */
    const BUTTONS = [{ label: '导入登录态', tool: 'xy_import_account' }, { label: '发布 dry-run', tool: 'xy_publish_draft' }]
    /** 面板内模块 tab：全部在侧边栏面板里切换（不注册 conversation.view）。 */
    const PANEL_TABS = [
      { id: 'publish-batch', label: '自动发布' }, { id: 'account', label: '账号' }, { id: 'copy', label: '文案' },
      { id: 'reference', label: '采集' }, { id: 'overview', label: '概览' }, { id: 'diagnose', label: '诊断' },
    ]
    /** 可复制命令：按钮不可点时，人能在终端直接执行的入口（按 tab 分组）。 */
    const COMMANDS = {
      account: [{ label: '导入登录态（CLI）', command: 'npm run daemon:import-account' }],
      publish: [
        { label: '发布 dry-run（CLI）', command: 'npm run daemon:publish -- --draft <草稿.json>' },
        { label: '入队发布（需审批）', command: '让模型调用 xy_publish_draft（mode=enqueue）' },
      ],
      diagnose: [{ label: '起 daemon', command: 'npm run daemon' }, { label: '隔离 dev 实例', command: 'npm run dsh:dev -- --fresh' }],
    }
    const PUBLISH_MODES = [['dry-run', 'dry-run（只填表）', '只填表、不点提交'], ['enqueue', 'enqueue（入队，走审批）', '入队后由 daemon 执行，需要审批门禁']]
    const BUTTON_NOTE = '按钮为什么是灰的：宿主没有公开「面板直接调用工具」的 API，工具调用要经过 host 侧审批门禁，入口仍在对话里；也可以复制下面的命令。'
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
    /** 发布流水线四步：面板只展示契约，真正执行在 daemon。 */
    const PIPELINE_STEPS = [
      { title: '1 草稿集', value: '标题 / 文案 / 图片 / 价格 / 成色' },
      { title: '2 文案与图片', value: 'agent 调 xy_copy_plan 出文案；图片用本地目录' },
      { title: '3 批量入队', value: '幂等 dedupeKey，重复草稿自动跳过' },
      { title: '4 daemon 发布', value: '单账号串行 CDP；每步截图，失败进待审' },
    ]
    const CATEGORY_MATRIX = '✅ 电子资料 / 学习笔记 / 课业本；❌ 教材教辅 / 语言与兴趣培训 / 学习资料定制 / 文学 / 考研咨询（网页端不支持发布）'
    /** 内联草稿示例（price 单位是分）。 */
    const DRAFT_EXAMPLE = '{"title":"课程笔记 PDF","price":990,"condition":"like-new","images":["D:/pics/note-1.jpg"]}'
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
    /** 组装 xy_copy_plan 参数（纯数据）；价格按「元」原样传，转分交给 host。 */
    function buildCopyPlanArguments(styleId, productName, priceYuan, condition) {
      const args = { styleId, productName: productName.trim(), condition }
      const price = priceYuan.trim()
      if (price !== '') args.priceYuan = price
      return { tool: 'xy_copy_plan', arguments: args }
    }

    // —— 实时状态：client → host rpc（只读端点）——
    const RPC_CHANNEL = '/bigfish'
    const POLL_MS = 3000
    const OFFLINE_TEXT = '未连接后台（daemon 未启动）'
    /** 队列状态的展示顺序与中文名；与 src/rpc.js 的 TASK_STATES 一致。 */
    const TASK_STATE_LABELS = [['queued', '排队'], ['leased', '执行中'], ['done', '完成'], ['failed', '失败'], ['needs_review', '待审']]
    /** 读连接服务：宿主没给 connection / 没有 rpc.call 时返回 null，让面板降级而不是抛错。 */
    function readConnection(ctx) {
      try {
        const connection = ctx.connection
        if (connection === null || connection === undefined) return null
        if (connection.rpc === null || connection.rpc === undefined || typeof connection.rpc.call !== 'function') return null
        return connection
      } catch { return null }
    }
    /** 单次只读 rpc：传输失败、信封非法、handler 抛错都折成 { ok:false }，绝不冒泡。 */
    async function callRead(connection, endpoint, payload) {
      if (connection === null) return { ok: false }
      try {
        const reply = await connection.rpc.call(RPC_CHANNEL, endpoint, payload ?? {})
        if (reply === null || typeof reply !== 'object' || reply.ok !== true) return { ok: false }
        return { ok: true, value: reply.value }
      } catch { return { ok: false } }
    }
    /** 面板动作（启停 daemon）：与只读快照不同，这里要把 error.message 带回 UI。 */
    async function callAction(connection, endpoint, payload) {
      if (connection === null || connection === undefined) return { ok: false, message: '宿主没有连接服务，无法操作 daemon；请在 DSH 桌面端打开面板' }
      try {
        const reply = await connection.rpc.call(RPC_CHANNEL, endpoint, payload ?? {})
        if (reply !== null && typeof reply === 'object' && reply.ok === true) return { ok: true, message: '' }
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
    /** 设置摘要：只列三个对发布节奏有影响的字段。 */
    function describeSettings(settings) {
      const styleId = String(settings.copyStyle ?? '默认')
      const style = COPY_STYLE_OPTIONS.find(option => option.id === styleId)
      const interval = Number(settings.publishMinIntervalMs)
      const seconds = Number.isFinite(interval) ? String(Math.round(interval / 1000)) + ' 秒' : '?'
      const category = typeof settings.defaultCategory === 'string' && settings.defaultCategory.trim() !== '' ? settings.defaultCategory : '未设置'
      return '文案风格 ' + (style === undefined ? styleId : styleId + '（' + style.label + '）')
        + ' · 默认类目 ' + category + ' · 发布间隔 ' + seconds
    }

    /** 侧边栏栏位图标。 */
    function BigFishIcon({ size, active }) {
      return h('span', {
        style: { ...ICON_STYLE, fontSize: String(Math.max(12, size)) + 'px', opacity: active ? 1 : 0.72 },
        'aria-hidden': 'true',
      }, '🐟')
    }
    function Card({ title, value, hint }) {
      return h('div', { style: S.card },
        h('div', { style: S.cardTitle }, title),
        h('div', { style: S.cardValue }, value),
        hint === undefined ? null : h('div', { style: S.cardHint }, hint))
    }
    /** 按钮区：disabled + title 说明原因。 */
    function ActionButtons() {
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, '操作入口'),
        h('div', { style: S.buttonRow }, ...BUTTONS.map(button => h('button', {
          key: button.tool, type: 'button', disabled: true, style: S.button,
          title: '暂不可点：请在对话里让模型调用 ' + button.tool + '，或复制下面的命令。',
        }, button.label))),
        h('div', { style: S.sectionHint }, BUTTON_NOTE))
    }
    function CommandList({ items, title }) {
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, title ?? '可复制命令'),
        ...items.map(item => h('div', { key: item.label, style: S.cmdRow },
          h('span', { style: S.cmdLabel }, item.label),
          h('code', { style: S.cmdCode }, item.command))))
    }
    /** 一行「工具名 + 用途」，诊断页用。 */
    function ToolRow({ name, desc }) {
      return h('div', { style: S.cmdRow }, h('span', { style: S.cmdLabel }, desc), h('code', { style: S.cmdCode }, name))
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
    /** 商品事实输入：只收最小集，其余字段在对话里补。 */
    function CopyInputs({ productName, onName, priceYuan, onPrice, condition, onCondition }) {
      const text = (label, value, placeholder, onChange) => h(Field, { label, control: h('input', {
        type: 'text', value, placeholder, onChange: event => onChange(event.target.value), style: S.input,
      }) })
      return h('div', { style: S.fieldRow },
        text('商品名', productName, '如：iPhone 13 128G 星光色', onName),
        text('价格（元）', priceYuan, '如：129.90', onPrice),
        h(Field, { label: '成色', control: h('select', {
          value: condition, onChange: event => onCondition(event.target.value), style: S.input,
        }, ...CONDITION_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.label))) }))
    }
    /** 请求预览：把参数 JSON 摊开，便于复制或直接在对话里让模型执行。 */
    function CopyPlanPreview({ request }) {
      return h('div', { style: S.preview },
        h('div', { style: S.sectionTitle }, '生成请求已就绪'),
        h('div', { style: S.sectionHint }, '面板不联网、不调模型：这里只选风格与组参数。把下面这段交给模型，它会调 xy_copy_plan 拿到注入好的提示词，再按 skill 出草稿 JSON → xy_publish_draft 做 dry-run。'),
        h('pre', { style: S.pre }, JSON.stringify(request, null, 2)))
    }
    /** 文案风格区：选风格 → 填事实 → 生成请求。 */
    function CopyStudio(props) {
      const { styleId, onStyle, ready, submitted, request } = props
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, '文案风格（skill 注入）'),
        h(StylePicker, { styleId, onStyle }),
        h(CopyInputs, props),
        h('div', { style: S.buttonRow },
          h('button', {
            type: 'button', 'data-role': 'copy-submit', disabled: !ready,
            title: ready ? '按当前风格组装 xy_copy_plan 请求' : '先填商品名与价格（元）',
            onClick: () => props.onSubmit(), style: ready ? S.primary : S.button,
          }, '生成文案请求'),
          h('span', { style: S.sectionHint }, ready ? '' : '商品名与价格都填了才能生成（价格用于校验，不写进标题）。')),
        submitted ? h(CopyPlanPreview, { request }) : null)
    }
    function TabBar({ active, onSelect }) {
      return h('div', { role: 'tablist', 'aria-label': 'BigFish 面板分区', style: S.tabBar },
        ...PANEL_TABS.map(tab => h('button', {
          key: tab.id, type: 'button', role: 'tab', 'data-role': 'panel-tab',
          'aria-selected': tab.id === active, onClick: () => onSelect(tab.id),
          style: tab.id === active ? { ...S.tab, ...S.tabActive } : S.tab,
        }, tab.label)))
    }

    /** 采集参考的只读口径：给什么、不给什么、下一步缺什么。 */
    const REFERENCE_CARDS = [
      { title: '输入', value: '商品 id（≤20）或商家 id', hint: '商家 id 先取主页与在售列表，再逐件读详情统计' },
      { title: '产出', value: '价格带 / 标题长度 / 类目 / 卖点词', hint: '全部是统计量；不给图片直链、不产出可发布草稿' },
      { title: '数据来源', value: 'mtop 只读接口', hint: '账号登录态由 daemon 解密后使用；_m_h5_tk 过期自动刷新回写' },
    ]
    const REFERENCE_NOTES = [
      '只做统计参考：图片数量、价格、标题长度、类目、卖点词；任何一条都不构成「拿来就能发」的素材。',
      '红线：不下载他人图片、不照抄文案、不跨账号复制他人商品。要发的是自己的货（AGENTS §1.6）。',
      '单件失败不影响整批：失败条目进 skipped 列表，AUTH_EXPIRED / RISK_CONTROL / UNAUTHORIZED 会中止整批。',
    ]

    /** 「采集」模块：讲清参考分析能给什么、怎么调工具。纯 UI，不联网、不执行写操作。 */
    function ReferenceView() {
      return h('div', null,
        h('div', { style: S.sectionHint }, '读他人商品做统计分析 → 给自己的定价与文案找参照；面板不联网，采集由 agent 调工具'),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '能拿到什么'),
          h('div', { style: S.grid }, ...REFERENCE_CARDS.map(card => h(Card, { key: card.title, ...card })))),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '怎么调（让模型执行）'),
          h(ToolRow, { name: 'xy_reference_collect', desc: '按商品 id / 商家 id 采集只读统计（最坏 20 件串行）' }),
          h(ToolRow, { name: 'xy_items_list', desc: '本地商品快照（自己已上架的，不是参考）' }),
          h('div', { style: S.sectionHint }, '示例参数：{"accountId":"2206569289277","itemIds":["1091933071728"]} 或 {"accountId":"…","sellerId":"…"}')),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '已知边界'),
          ...REFERENCE_NOTES.map((note, index) => h('div', { key: String(index), style: S.sectionHint }, '· ' + note))),
        h('div', { style: S.note }, '下一步（未做）：自有商品搬家（R2）要先拍板范围——只搬自己名下商品才不碰搬运红线；采用前写进 docs/repost-feature-parity.md 并补真机记录。'))
    }

    /** daemon 实时状态 + 进程管理：health / 账号就绪 / 队列计数 / 最近批次 / 设置摘要 + 启停按钮。 */
    function DaemonView({ connection }) {
      const snapshot = useDaemonSnapshot(connection)
      // hooks 必须在早退之前调用（React 规则），所以动作状态在 loading 分支也建好。
      const actions = useDaemonAction(connection)
      const online = snapshot.phase === 'ok' && snapshot.data !== null
      const action = actions.state
      // 进程管理：两个分支都渲染，用户离线时点「启动」、在线时点「停止」。
      const manage = h('div', { style: S.section, 'data-role': 'daemon-manage' },
        h('div', { style: S.sectionTitle }, '进程管理（daemon 是常驻后台监听进程）'),
        h('div', { style: S.sectionHint },
          'daemon 在后台常驻监听：worker 按固定间隔轮询本地队列，执行发布 / 擦亮 / 探针等任务；面板只是看板，关掉它 daemon 照旧运行。'
          + '停止后队列不再执行、面板转为离线；下次打开面板宿主会自动拉起，也可以在这里手动启动。'),
        h('div', { style: S.buttonRow },
          h('button', {
            type: 'button', 'data-role': 'daemon-start', disabled: online || action.busy !== '',
            title: online ? 'daemon 已在线' : '让宿主拉起本地 daemon（跳过 30 秒冷却）',
            onClick: actions.start, style: !online && action.busy === '' ? S.primary : S.button,
          }, action.busy === 'daemon.start' ? '正在启动…' : '启动 daemon'),
          h('button', {
            type: 'button', 'data-role': 'daemon-stop', disabled: !online || action.busy !== '',
            title: online ? '停止常驻 daemon（会中断在飞任务）' : 'daemon 未运行',
            onClick: actions.stop, style: online && action.busy === '' ? S.primary : S.button,
          }, action.stopArmed ? '确认停止 daemon' : action.busy === 'daemon.stop' ? '正在停止…' : '停止 daemon')),
        action.notice === null ? null : h('div', {
          style: action.notice.kind === 'bad' ? S.badText : S.okText, 'data-role': 'daemon-manage-notice',
        }, action.notice.text))
      if (snapshot.phase === 'loading') return h('div', { style: S.sectionHint, 'data-role': 'daemon-state' }, '正在连接 daemon…')
      const data = snapshot.data
      // 降级时给一句可执行的下一步：宿主会自己拉起 daemon，失败后 30 秒冷却，仍不行再看日志。
      if (snapshot.phase !== 'ok' || data === null) return h('div', { 'data-role': 'daemon-state' },
        h('div', { style: S.badText }, OFFLINE_TEXT),
        h('div', { style: S.sectionHint, 'data-role': 'daemon-hint' },
          '宿主已尝试自动拉起 daemon（失败后 30 秒冷却；日志在数据目录的 plugin.log / daemon.log）。仍连不上就手动执行 pnpm daemon:start。'),
        manage)
      const health = data.health ?? {}
      const queue = data.status?.queue ?? {}
      const accounts = Array.isArray(data.accounts) ? data.accounts : []
      const readyCount = accounts.filter(account => account !== null && typeof account === 'object' && account.ready === true).length
      const line = (role, label, value) => h('div', { style: S.cmdRow, 'data-role': role },
        h('span', { style: S.cmdLabel }, label), h('span', null, value))
      return h('div', { style: S.section, 'data-role': 'daemon-state' },
        h('div', { style: S.sectionTitle }, 'daemon 实时状态（每 3 秒轮询）'),
        line('daemon-health', 'daemon', '在线 · v' + String(health.version ?? '?') + ' · 已运行 ' + formatUptime(health.uptimeMs)),
        line('daemon-accounts', '账号就绪', String(accounts.length) + ' 个账号 · ' + String(readyCount) + ' 个可写' + (accounts.length === 0 ? '（先导入登录态）' : '')),
        line('daemon-queue', '队列', describeQueue(queue)),
        line('daemon-batch', '最近批次', describeBatch(data.batch)),
        line('daemon-settings', '设置摘要', describeSettings(data.settings ?? {})),
        manage)
    }

    /** 诊断页：daemon 实时状态 + 只读工具与进程命令。 */
    function DiagnoseTab({ connection }) {
      return h('div', null,
        h(DaemonView, { connection }),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '读状态（让模型调）'),
          h(ToolRow, { name: 'xy_status', desc: '队列/账号/熔断/worker' }),
          h(ToolRow, { name: 'xy_tasks_list', desc: '任务列表（可按状态/种类过滤）' }),
          h(ToolRow, { name: 'xy_items_list', desc: '本地商品快照' }),
          h(ToolRow, { name: 'xy_ping', desc: '插件 ↔ daemon ↔ 鉴权自检' })),
        h(CommandList, { items: COMMANDS.diagnose, title: '进程' }),
        h('div', { style: S.note }, '面板不读凭据：实时状态经宿主 rpc 只读轮询，写操作仍走 host 侧审批。'))
    }

    /** 当前 tab 的内容区；copy 页的状态留在 Panel 里（切走再切回不丢输入）。 */
    function PanelBody({ tab, copyProps, connection }) {
      if (tab === 'publish-batch') return h(PublishBatchView, { connection })
      if (tab === 'account') return h(AccountView)
      if (tab === 'copy') return h(CopyStudio, copyProps)
      if (tab === 'reference') return h(ReferenceView)
      if (tab === 'diagnose') return h(DiagnoseTab, { connection })
      return h('div', null,
        h('div', { style: S.sectionHint }, '登录态导入：xy_import_account（从本机 Chrome 读 cookie 后加密落盘）；daemon：127.0.0.1:47001 · 前台进程，实时状态见「诊断」页。'),
        h(ActionButtons), h(CommandList, { items: COMMANDS.account, title: '账号' }))
    }

    /** 面板骨架：顶部 tab + 内容区 + 门禁说明。connection 由 apply 注入（模块级单实例）。 */
    function BigFishPanel() {
      const [tab, setTab] = React.useState(PANEL_TABS[0].id)
      const [styleId, setStyleId] = React.useState(COPY_STYLE_OPTIONS[0].id)
      const [productName, setProductName] = React.useState('')
      const [priceYuan, setPriceYuan] = React.useState('')
      const [condition, setCondition] = React.useState('like-new')
      const [submitted, setSubmitted] = React.useState(false)
      const ready = productName.trim() !== '' && priceYuan.trim() !== ''
      const request = buildCopyPlanArguments(styleId, productName, priceYuan, condition)
      // 任一输入变化都撤销「已就绪」，避免拿着旧参数去生成。
      const reset = setter => value => { setter(value); setSubmitted(false) }
      const copyProps = {
        styleId, onStyle: reset(setStyleId), productName, onName: reset(setProductName),
        priceYuan, onPrice: reset(setPriceYuan), condition, onCondition: reset(setCondition),
        ready, submitted, onSubmit: () => setSubmitted(true), request,
      }
      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', { style: S.logo }, '🐟'),
          h('div', null,
            h('div', { style: S.title }, 'BigFish 闲鱼运营'),
            h('div', { style: S.subtitle }, '发布 / 账号 / 文案 / 采集 · 面板只组参数，执行交给 agent 与 daemon'))),
        h(TabBar, { active: tab, onSelect: setTab }),
        h(PanelBody, { tab, copyProps, connection: panelConnection }),
        h('div', { style: S.note },
          '写操作门禁：导入登录态、入队发布走 ask；dry-run 与 xy_copy_plan 只读放行。实时状态在「诊断」页。真机校准通过前，任何路径都不会声称「发布成功」。'))
    }

    /** 「自动发布」模块：daemon 实时状态 + 草稿集 → 校验 → 组 xy_publish_batch 参数。 */
    function PublishBatchView({ connection }) {
      const [draftText, setDraftText] = React.useState('')
      const [mode, setMode] = React.useState('dry-run')
      const [accountId, setAccountId] = React.useState('')
      const [generated, setGenerated] = React.useState(null)
      const results = parseDraftLines(draftText)
      const valid = results.filter(result => result.ok)
      const invalid = results.filter(result => !result.ok)
      const ready = valid.length >= 2 && invalid.length === 0
      const blocked = results.length === 0 ? '先粘贴至少 2 条合法草稿'
        : invalid.length > 0 ? '有 ' + String(invalid.length) + ' 行校验不通过，先修好再生成'
          : '至少 2 条合法草稿才能生成（现在 ' + String(valid.length) + ' 条）'
      const request = buildPublishBatchArguments(mode, results, accountId)
      const update = setter => value => { setter(value); setGenerated(null) }
      const modeButtons = PUBLISH_MODES.map(([value, label, hint]) => h('button', {
        key: value, type: 'button', 'data-role': 'publish-mode', 'aria-pressed': value === mode, title: hint,
        onClick: () => update(setMode)(value), style: value === mode ? { ...S.chip, ...S.chipActive } : S.chip,
      }, label))
      return h('div', null,
        h('div', { style: S.sectionHint }, '批量入队 → daemon 串行执行；面板只组参数，不执行写操作'),
        h(DaemonView, { connection }),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '流水线'),
          h('div', { style: S.grid }, ...PIPELINE_STEPS.map(step => h(Card, { key: step.title, title: step.title, value: step.value })))),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '草稿集'),
          h('div', { style: S.sectionHint }, '每行一条：内联 JSON 对象，或草稿 .json 文件路径（由 host 侧读取）。price 单位是分。'),
          h('textarea', {
            value: draftText, rows: 6, 'data-role': 'draft-input',
            placeholder: '每行一条草稿：{"title":"...","price":990,"images":["D:/pics/1.jpg"]} 或 D:/drafts/note.json',
            onChange: event => update(setDraftText)(event.target.value),
            style: { ...S.input, ...S.textarea },
          }),
          h('div', { style: S.sectionHint }, '示例：' + DRAFT_EXAMPLE)),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '发布前校验'),
          h('div', { style: S.sectionHint }, '类目矩阵：' + CATEGORY_MATRIX),
          ...results.map(result => h('div', { key: String(result.index), style: S.cmdRow, 'data-role': 'draft-check', 'data-ok': result.ok },
            h('span', { style: S.cmdLabel }, '第 ' + String(result.index + 1) + ' 行'),
            h('span', { style: result.ok ? S.okText : S.badText }, result.message))),
          h('div', { style: S.sectionHint }, '已通过 ' + String(valid.length) + ' 条 / 未通过 ' + String(invalid.length) + ' 条；至少 2 条合法草稿才能生成。')),
        h('div', { style: S.section },
          h('div', { style: S.fieldRow }, h('div', { style: S.field }, h('span', { style: S.fieldLabel }, '模式'),
            h('div', { style: S.chipRow }, ...modeButtons))),
          h(Field, { label: '账号（可选）', control: h('input', {
            type: 'text', value: accountId, placeholder: 'daemon 账号 id，默认唯一账号',
            onChange: event => update(setAccountId)(event.target.value), style: S.input,
          }) }),
          h('div', { style: S.buttonRow },
            h('button', {
              type: 'button', 'data-role': 'publish-batch-submit', disabled: !ready,
              title: ready ? '组装 xy_publish_batch 参数 JSON' : blocked,
              onClick: () => setGenerated(request), style: ready ? S.primary : S.button,
            }, '生成批量发布请求'),
            h('span', { style: S.sectionHint }, '生成的 JSON 交给 agent 调 xy_publish_batch。'))),
        generated === null ? null : h('div', { style: S.preview },
          h('div', { style: S.sectionTitle }, 'xy_publish_batch 参数已就绪'),
          h('pre', { style: S.pre, 'data-role': 'publish-request' }, JSON.stringify(generated, null, 2))),
        h(CommandList, { items: COMMANDS.publish, title: '发布命令' }),
        h('div', { style: S.note }, '面板不执行发布：命令由 agent 调 xy_publish_batch / CLI 执行 —— 执行与 UI 解耦'))
    }
    /** 行内样式表：跟随 DSH 主题变量，不引入样式文件。 */
    const S = {
      page: { padding: '32px', maxWidth: '860px', margin: '0 auto', color: 'var(--dsw-alias-label-primary)' },
      header: { display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '24px' },
      logo: { fontSize: '34px', lineHeight: '1' }, title: { fontSize: '20px', fontWeight: 600, lineHeight: '28px' },
      subtitle: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      tabBar: { display: 'flex', gap: '2px', borderBottom: '1px solid var(--dsw-alias-border-l2)', marginBottom: '4px' },
      tab: { fontSize: '13px', padding: '8px 14px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', borderBottom: '2px solid transparent', marginBottom: '-1px' },
      tabActive: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, borderBottom: '2px solid var(--dsw-alias-label-primary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '16px' },
      cardTitle: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px' },
      cardValue: { fontSize: '15px', fontWeight: 500, lineHeight: '22px' },
      cardHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '6px', lineHeight: '18px' },
      section: { marginTop: '24px' },
      sectionTitle: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' },
      sectionHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '10px', lineHeight: '18px' },
      buttonRow: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px' },
      button: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'not-allowed', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l2)', color: 'var(--dsw-alias-label-secondary)' },
      primary: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l3)', color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
      chipRow: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      chip: { fontSize: '12px', padding: '5px 12px', borderRadius: '999px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)' },
      chipActive: { background: 'var(--dsw-alias-bg-l3)', color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-label-secondary)', fontWeight: 600 },
      fieldRow: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '12px' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '180px', flex: '1 1 180px' },
      fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      input: { fontSize: '13px', padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
      preview: { marginTop: '16px' },
      pre: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', background: 'var(--dsw-alias-bg-l2)', borderRadius: '8px', padding: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '10px 0 0' },
      cmdRow: { display: 'flex', gap: '10px', alignItems: 'baseline', padding: '5px 0', flexWrap: 'wrap' },
      cmdLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', minWidth: '150px' },
      cmdCode: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', background: 'var(--dsw-alias-bg-l2)', borderRadius: '4px', padding: '2px 6px', wordBreak: 'break-all' },
      note: { marginTop: '24px', fontSize: '13px', lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' },
      textarea: { width: '100%', boxSizing: 'border-box', resize: 'vertical', marginTop: '8px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      okText: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, badText: { fontSize: '12px', color: 'var(--dsw-alias-label-danger, #c0392b)' },
    }
    /** 账号模块的三张来源卡：都是 daemon/host 侧动作，面板只解释怎么触发。 */
    const ACCOUNT_SOURCES = [
      { title: '导入登录态', value: '从本机 Chrome 读 cookie', hint: 'Chrome 需带 --remote-debugging-port 启动；会加密写凭据，工具执行前要人工确认。' },
      { title: '扫码登录', value: 'npm run daemon:login', hint: '打开闲鱼登录页等扫码；unb 与 _m_h5_tk 齐备才算成功（默认等 180s）。' },
      { title: '凭据存储', value: '加密落盘', hint: 'Windows 走 DPAPI；daemon 只在执行时解密，插件与 UI 都拿不到 cookie 明文。' },
    ]
    /** 账号模块的已知边界：写清「面板看到的是什么、过期怎么处理」。 */
    const ACCOUNT_NOTES = [
      '摘要字段只有 id / 最后更新 / 登录态字段数 / 是否可写（unb + _m_h5_tk 齐备）；任何 cookie 值都不出 daemon 进程。',
      '_m_h5_tk 约 2 小时过期：过期后写操作报 AUTH_EXPIRED；重新导入或扫码即可刷新（mtop 响应带新 token 时 daemon 也会自动续期）。',
      '导入与扫码都是写操作（写加密凭据），走 ask 门禁；本面板只读，实时状态从 host rpc 轮询。',
    ]
    function AccountView() {
      return h('div', null,
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '账号管理'),
          h('div', { style: S.sectionHint }, '登录态来源、只读摘要与刷新方式；面板不读 cookie、不联网')),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '登录态怎么进来'),
          h('div', { style: S.grid }, ...ACCOUNT_SOURCES.map(source => h(Card, { key: source.title, title: source.title, value: source.value, hint: source.hint })))),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '看当前账号'),
          h('div', { style: S.sectionHint }, '面板不执行工具：下面这些交给 agent 调，摘要在对话里返回。'),
          h('div', { style: S.cmdRow }, h('span', { style: S.cmdLabel }, '只读摘要'), h('code', { style: S.cmdCode }, 'xy_accounts_list'),
            h('span', { style: S.sectionHint }, '账号 id / 更新于 / 字段数 / 是否可写')),
          h('div', { style: S.cmdRow }, h('span', { style: S.cmdLabel }, '导入登录态（需确认）'), h('code', { style: S.cmdCode }, 'xy_import_account')),
          h('div', { style: S.cmdRow }, h('span', { style: S.cmdLabel }, '队列概览里也能看到'), h('code', { style: S.cmdCode }, 'xy_status'),
            h('span', { style: S.sectionHint }, 'accounts 是启动时快照，导入/扫码后 daemon 会刷新'))),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '已知边界'),
          ...ACCOUNT_NOTES.map(note => h('div', { key: note, style: S.sectionHint }, '· ' + note))),
        h('div', { style: S.note }, '下一步（未做）：面板里直接点「导入 / 扫码」需要写类 rpc 端点 + 二次确认 UI，留到下一轮；在那之前写操作入口只在工具审批里。'))
    }
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