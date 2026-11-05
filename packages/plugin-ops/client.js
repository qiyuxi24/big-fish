    // 生成物：由 scripts/build-client.mjs 从 src/client-bundle/*.part.js 拼接而成，不要直接编辑本文件。
/**
 * BigFish 运营面板（client bundle；手写 loader 产物，id 必须等于包名）。
 * 只做 UI 与只读状态：daemon 状态走 rpc 每 3 秒轮询，失败降级成一行；写操作走 host 审批。
 * @module @bigfish/plugin-ops/client
 */
window.__ModuleLoader__.load({
  id: '@bigfish/plugin-ops',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const ICON_STYLE = { display: 'block', lineHeight: '1' }
    /**
     * 面板内模块 tab：**唯一定义点**——一条记录 = 一个模块（id / 文案 / 分组 / 组件）。
     * 分组只影响渲染顺序上的小字标签：监控（看状态）/ 准备（备料）/ 作业（动手）。
     * 加模块 = 这里追加一条 + 新片段（每片段 ≤ 400 行）；`PanelBody` 查表渲染，不需要再补 if 分支。
     * 组件都是函数声明（会被提升到 factory 顶部），所以这里可以按名字引用后面片段里的组件。
     * `pickProps` 只给需要面板级状态（文案表单）的模块用，默认注入 `{ connection }`。
     */
    const PANEL_TABS = [
      { id: 'overview', label: '概览', group: '监控', component: OverviewTab },
      { id: 'account', label: '账号', group: '准备', component: AccountView },
      { id: 'research', label: '采集', group: '准备', component: ReferenceView },
      { id: 'copy', label: '文案', group: '准备', component: CopyStudio, pickProps: props => props.copyProps },
      { id: 'publish', label: '发布', group: '作业', component: PublishBatchView },
      { id: 'items', label: '商品', group: '作业', component: ItemsView },
    ]
    /** 默认落地页 = 清单第一项；不要在别处再写死 'overview'。 */
    const DEFAULT_TAB_ID = PANEL_TABS[0].id
    /** 任务种类：与 src/rpc-schema.js 的 TASK_KINDS 一致；deliver / reply 未接线，筛选里置灰只占位。 */
    const TASK_KINDS = [['publish', '发布'], ['polish', '擦亮'], ['probe', '探测'], ['deliver', '发货'], ['reply', '客服']]
    /**
     * 面板暂不给入口的任务种类。**文案必须与 daemon 的真实能力一致**（2026-10-28 修正）：
     * - deliver：daemon 执行器确实还是 UNSUPPORTED（缺卡密规则引擎），如实说未接线；
     * - reply：执行器已经接了 IM 长连（P2.1），但 daemon 要 `BF_IM=1` 才开，面板还没给入口——
     *   所以不能再说「未接线」，否则用户会以为能力不存在。
     */
    const UNSUPPORTED_KINDS = {
      deliver: '自动发货：执行器仍是 UNSUPPORTED（缺卡密规则引擎），先走 xy_task_action',
      reply: 'AI 客服：已接 IM 长连，但 daemon 要 BF_IM=1 才开，面板暂不给入口',
    }
    const PUBLISH_MODES = [['dry-run', 'dry-run 只填表', '只填表，不点提交'], ['enqueue', 'enqueue 入队', '写进 daemon 队列，走审批']]
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
    const CATEGORY_MATRIX = '✅ 电子资料 / 学习笔记 / 课业本；❌ 教材教辅 / 培训 / 文学 / 考研咨询（网页端）'
    /**
     * 片段 02：草稿集解析与发布参数组装（纯数据：不联网、不碰 daemon、只组 JSON）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /**
     * 草稿价格（单位：分）。协议字段是 `priceCents`（core 与 daemon 都只认它），
     * 但面板早期文案与示例写的是 `price`——两个都收，避免用户按示例粘贴却被判「缺 priceCents」。
     * 返回 NaN 表示两个都没给，交给调用方报错。
     */
    function draftPriceCents(draft) {
      const raw = draft.priceCents !== undefined && draft.priceCents !== null ? draft.priceCents : draft.price
      if (typeof raw === 'number') return raw
      if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim())
      return Number.NaN
    }
    /** 逐行解析草稿集（内联 JSON 对象或 .json 路径）：路径条目交给 host 侧读取，这里只认形状。 */
    function parseDraftLines(text) {
      return text.split('\n').map(line => line.trim()).filter(line => line !== '').map((line, index) => {
        if (!line.startsWith('{')) {
          return /\.json$/i.test(line)
            ? { index, kind: 'path', ok: true, path: line, message: '路径条目（host 读取）' }
            : { index, kind: 'bad', ok: false, message: '既不是 JSON，也不是 .json 路径' }
        }
        let draft
        try { draft = JSON.parse(line) } catch { return { index, kind: 'inline', ok: false, message: 'JSON 错误' } }
        if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return { index, kind: 'inline', ok: false, message: 'JSON 不是对象' }
        // 价格单独判：字段名两个都收，但报错统一说协议名 priceCents（否则用户不知道该改哪个键）。
        const missing = ['title', 'images'].filter(key => draft[key] === undefined || draft[key] === null || draft[key] === '' || (Array.isArray(draft[key]) && draft[key].length === 0))
        if (!Number.isSafeInteger(draftPriceCents(draft)) || draftPriceCents(draft) <= 0) missing.push('priceCents')
        return missing.length === 0
          ? { index, kind: 'inline', ok: true, draft, message: '通过' }
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
    /**
     * 内联草稿 → publish 任务（面板的价格一律按「分」理解）；daemon 执行时 title/desc/priceCents/images 必填。
     *
     * shipping / address 必须带上：队列任务执行时 daemon 读不到草稿文件，
     * 少了 address「必填项预检」必然 VALIDATION（宝贝所在地为空），任务只会 failed。
     * 取值优先级：草稿里显式给了 > daemon 设置里的 defaultAddress / shipping。
     * 与 host 侧 publish-flow.js 的 buildPublishEnqueueInput 保持同一口径。
     */
    function buildPublishItems(results, accountId, defaults) {
      const items = [], problems = []
      const fallback = defaults === undefined || defaults === null ? {} : defaults
      for (const result of results) {
        const draft = result.draft ?? {}, priceCents = draftPriceCents(draft), desc = typeof draft.desc === 'string' ? draft.desc.trim() : ''
        const invalid = typeof draft.title !== 'string' || draft.title.trim() === '' || desc === '' || !Number.isSafeInteger(priceCents) || priceCents <= 0 || !Array.isArray(draft.images) || draft.images.length === 0
        if (invalid) { problems.push('第 ' + String(result.index + 1) + ' 行缺 title / desc / priceCents / images'); continue }
        const payload = { accountId, title: draft.title.trim(), desc, priceCents, images: draft.images }
        if (typeof draft.category === 'string' && draft.category.trim() !== '') payload.category = draft.category.trim()
        const shipping = draft.shipping === 'free' || draft.shipping === 'none' ? draft.shipping : fallback.shipping
        if (shipping === 'free' || shipping === 'none') payload.shipping = shipping
        const address = typeof draft.address === 'string' && draft.address.trim() !== '' ? draft.address.trim() : fallback.address
        if (typeof address === 'string' && address.trim() !== '') payload.address = address.trim()
        // 幂等键带上账号：daemon 的 dedupe_key 是全局唯一，不带账号会让 B 号发同款被判成重复丢单。
        items.push({ kind: 'publish', dedupeKey: 'publish:' + JSON.stringify([accountId, payload.title, payload.desc, priceCents, draft.images, payload.shipping ?? null, payload.address ?? null, payload.category ?? null]), payload })
      }
      return { items, problems }
    }
    /** settings 对象 → 表单初值（发布间隔按秒展示）。 */
    function settingsForm(settings) { return { interval: String(Math.round(Number(settings.publishMinIntervalMs ?? 0) / 1000)), category: String(settings.defaultCategory ?? ''), style: String(settings.copyStyle ?? COPY_STYLE_OPTIONS[0].id) } }
    /**
     * 动作结果行：所有「点两次写操作」的提示都走这里。
     * `role=status` + aria-live 让读屏把「再点一次」「已过期」「失败原因」播报出来——上膛态原本只有颜色差别。
     */
    const resultLine = (result, role) => result === null ? null : h('div', { style: result.kind === 'bad' ? S.badText : result.kind === 'ok' ? S.goodText : S.small, 'data-role': role, role: 'status', 'aria-live': 'polite' }, result.text)
    function gridRow(columns, head) { return { display: 'grid', gridTemplateColumns: columns, gap: '8px', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)', fontSize: head ? '12px' : '13px', color: head ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)' } }
    const TASK_GRID = 'minmax(110px, 1.2fr) 70px 84px 64px 92px 78px'

    /**
     * 片段 03：client → host 的只读 rpc 与轮询（连接探测、两次确认的写动作、快照与事件流）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    // —— 实时状态：client → host rpc（只读端点）——
    const RPC_CHANNEL = '/bigfish'
    /** 轮询周期（毫秒）：所有面板数据共用一个节奏，别再各写各的 3000。 */
    const POLL_MS = 3000
    /** daemon 默认监听地址（只用于文案提示；面板本身只走 rpc，不直连）。 */
    const DAEMON_ADDR = '127.0.0.1:47001'
    const OFFLINE_TEXT = '未连接后台（daemon 未启动）'
    /** 队列状态的展示顺序与中文名；与 src/rpc-schema.js 的 TASK_STATES 一致。 */
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
    /** 单次只读 rpc：失败折成 { ok:false } 并带 code/message（区分 daemon 断连与旧插件缺 rpc）。 */
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
    /** 二次确认的有效期（毫秒）：上膛后没人再点就自动撤销，避免「点了一次就走开」留下永久的确认态。 */
    const ARM_TIMEOUT_MS = 5000
    /**
     * 从 daemon.start 的返回值里挑出「为什么没起来」的证据：supervisor 失败时把
     * { exitCode, daemonLog, tail } 塞进 detail（daemon-supervisor.js 的 finish），
     * 面板把它原样摊出来——否则用户只能看到一句「daemon 没起来」，无从下手。
     */
    function startFailureDetail(value) {
      const detail = value !== null && typeof value === 'object' ? value.detail : null
      if (detail === null || typeof detail !== 'object') return { daemonLog: '', exitCode: null, tail: '' }
      const path = typeof detail.daemonLog === 'string' ? detail.daemonLog : ''
      const tail = typeof detail.tail === 'string' ? detail.tail : ''
      const exitCode = typeof detail.exitCode === 'number' && Number.isFinite(detail.exitCode) ? detail.exitCode : null
      return { daemonLog: path, exitCode, tail }
    }
    /** 进程管理按钮的状态机：停止要点两次（第一次只上膛），避免误触停掉正在跑的队列。 */
    function useDaemonAction(connection) {
      const [state, setState] = React.useState({ busy: '', stopArmed: false, notice: null, value: null })
      const run = (endpoint, payload, doneText) => {
        setState(previous => ({ ...previous, busy: endpoint, stopArmed: false, notice: null, value: null }))
        void callAction(connection, endpoint, payload).then(result => {
          // 保留 value：daemon.start 失败时，日志路径与日志尾部就藏在这里。
          setState(previous => ({ ...previous, busy: '', value: result.ok ? result.value ?? null : null, notice: result.ok ? { kind: 'ok', text: doneText } : { kind: 'bad', text: result.message } }))
        })
      }
      const start = () => { if (state.busy !== '') return; run('daemon.start', {}, '已请求启动，等下一次轮询确认在线') }
      const stop = () => {
        if (state.busy !== '') return
        if (!state.stopArmed) {
          setState(previous => ({ ...previous, stopArmed: true, notice: { kind: 'warn', text: '再点一次「确认停止」：在飞任务会中断（保持 queued，下次启动继续）' } }))
          return
        }
        run('daemon.stop', { confirm: true }, '已停止；队列暂停，下一次轮询转离线')
      }
      const cancelStop = () => { setState(previous => ({ ...previous, stopArmed: false, notice: null })) }
      // 上膛后 5 秒没人再点就自动撤销（用户点了一次就走开时，不该留下一个半激活的确认态）。
      React.useEffect(() => {
        if (!state.stopArmed) return undefined
        const timer = setTimeout(() => setState(previous => (previous.stopArmed ? { ...previous, stopArmed: false, notice: { kind: 'warn', text: '停止确认已过期（5 秒内没再点），要停请重新点两次' } } : previous)), ARM_TIMEOUT_MS)
        return () => clearTimeout(timer)
      }, [state.stopArmed])
      return { state, start, stop, cancelStop }
    }
    /**
     * 写类动作点两次：第一次只上膛并给提示，第二次带 confirm:true 才发（host 门禁要求）。
     * `busyKey` 是「正在跑的是哪个键」：表格里一次只该锁住那一行，别把整张表都禁掉
     * （账号页以前用一个布尔 busy，点一次「导入」全表 4 个按钮 × N 行一起变灰）。
     *
     * 传 `{ confirm: false }` 表示这次调用本来就不是写操作（例如 probe 只读详情）：
     * 一次点击直接发、也不带 confirm —— host 侧的门禁是按「这次到底写不写外部系统」判的
     * （rpc-schema.js 的 needsConfirm），面板不该再替它多点一次。
     *
     * 传 `{ confirm: false, arm: true }` 表示「不需要 confirm 字段，但仍然要人点两次」：
     * 典型是 release（只流转本地队列，不算写外部），可误点一下就会把 worker 正在处理的
     * 任务从租约里抢走，所以面板侧仍要上膛一次。
     */
    function useWrite(connection) {
      const [state, setState] = React.useState({ armed: '', busy: false, busyKey: '', result: null })
      const send = (key, endpoint, payload, texts, withConfirm) => {
        setState({ armed: '', busy: true, busyKey: key, result: { kind: 'hint', text: texts.busy } })
        const body = withConfirm ? { ...payload, confirm: true } : payload
        void callAction(connection, endpoint, body).then(reply => {
          if (reply.ok && texts.after !== undefined) void texts.after(reply.value)
          setState({ armed: '', busy: false, busyKey: '', result: reply.ok ? { kind: 'ok', text: texts.done(reply.value), value: reply.value } : { kind: 'bad', text: truncateText(reply.message) } })
        })
      }
      const run = (key, endpoint, payload, texts, options) => {
        if (state.busy) return
        const withConfirm = options === undefined || options === null || options.confirm !== false
        const needsArm = withConfirm || (options !== undefined && options !== null && options.arm === true)
        if (!needsArm) return send(key, endpoint, payload, texts, false)
        if (state.armed !== key) return setState({ armed: key, busy: false, busyKey: '', result: { kind: 'hint', text: texts.hint } })
        send(key, endpoint, payload, texts, withConfirm)
      }
      // 同上：上膛态只活 5 秒，避免「点了确认重试却忘了再点」的悬空状态。
      React.useEffect(() => {
        if (state.armed === '') return undefined
        const key = state.armed
        const timer = setTimeout(() => setState(previous => (previous.armed === key ? { armed: '', busy: false, busyKey: '', result: { kind: 'hint', text: '确认已过期（5 秒内没再点），要执行请重新点两次' } } : previous)), ARM_TIMEOUT_MS)
        return () => clearTimeout(timer)
      }, [state.armed])
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
    /**
     * 一次轮询：只有 health 决定「daemon 在不在」，其余端点各自降级。
     *
     * 以前是 5 个端点全成功才算在线，任意一个失败整页就变成「未连接后台（daemon 未启动）」——
     * 而 daemon 其实好好地活着，只是 tasks.list 超时了。这种误报比真离线更气人：
     * 用户会去重启 daemon，重启前又永远好不了（因为坏的是那个端点，不是 daemon）。
     * 现在只有 health 失败才判离线，其余失败记进 missing，让界面说清「哪几项这轮没拉到」。
     */
    async function readDaemon(connection) {
      const [health, status, accounts, settings, tasks] = await Promise.all([
        callRead(connection, 'health'), callRead(connection, 'status'), callRead(connection, 'accounts'),
        callRead(connection, 'settings.get'), callRead(connection, 'tasks.list', { limit: 50 })])
      if (!health.ok) return null
      const missing = []
      if (!status.ok) missing.push('status')
      if (!accounts.ok) missing.push('accounts')
      if (!settings.ok) missing.push('settings')
      if (!tasks.ok) missing.push('tasks')
      let batch = null
      const batchId = tasks.ok ? newestBatchId(tasks.value) : null
      if (batchId !== null) {
        const reply = await callRead(connection, 'batches.get', { id: batchId })
        const value = reply.value
        if (reply.ok && value !== null && typeof value === 'object') {
          batch = { batchId: String(value.batchId ?? batchId), total: Number(value.total ?? 0), counts: value.counts }
        }
      }
      return {
        health: health.value,
        status: status.ok ? status.value : null,
        accounts: accounts.ok ? accounts.value : [],
        settings: settings.ok ? settings.value : null,
        batch,
        missing,
      }
    }
    /**
     * 3 秒轮询：卸载时清定时器并阻止在途响应 setState；依赖只放 connection（句柄稳定）。
     *
     * 两个约束来自「面板会长时间开着」这个事实：
     * ①上一轮没回来就跳过这一轮——`accounts.verify`、`batches.get` 这类端点慢起来
     *   能拖到几十秒，硬按固定节奏发只会让在途请求一层层叠上去，越卡越慢；
     * ②连续失败要退避——daemon 挂了或宿主重启时，面板还以 3 秒一次的节奏继续敲，
     *   除了刷日志没有用处。失败 n 次就改成每 (n+1) 个 tick 才真打一次（上限 8 个 tick），
     *   一旦拿到成功结果立刻回到正常节奏。节奏仍是一个固定的 3 秒 interval：
     *   退避靠「跳过」而不是重设定时器，卸载与测试里的时钟语义都不变。
     */
    const MAX_POLL_BACKOFF_SKIPS = 7
    function useDaemonSnapshot(connection) {
      const [snapshot, setSnapshot] = React.useState({ phase: 'loading', data: null })
      React.useEffect(() => {
        let alive = true
        let inFlight = false
        let failures = 0
        let skip = 0
        const tick = () => {
          if (!alive || inFlight) return
          // 退避期间先空转：失败 n 次就跳过 n-1 个 tick（上限 7），拿到成功再归零。
          if (skip > 0) { skip -= 1; return }
          inFlight = true
          readDaemon(connection)
            .then(data => {
              if (!alive) return
              failures = data === null ? failures + 1 : 0
              skip = failures === 0 ? 0 : Math.min(failures - 1, MAX_POLL_BACKOFF_SKIPS)
              setSnapshot({ phase: data === null ? 'offline' : 'ok', data })
            })
            .catch(() => {
              if (!alive) return
              failures += 1
              skip = Math.min(failures - 1, MAX_POLL_BACKOFF_SKIPS)
              setSnapshot({ phase: 'offline', data: null })
            })
            .finally(() => { inFlight = false })
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
          h('div', { style: S.sectionTitle }, '品类'),
          h('div', { style: S.chipRow }, ...template.data.categories.map(category => h('button', {
            key: category.id, type: 'button', 'data-role': 'copy-category', 'data-category': category.id,
            'aria-pressed': category.id === form.categoryId,
            onClick: () => props.onCategory(category.id),
            style: category.id === form.categoryId ? { ...S.chip, ...S.chipActive } : S.chip,
          }, category.label))),
          template.phase === 'offline'
            ? h('div', { style: S.warnText }, '品类模板没拉到：先用通用字段。')
            : h('div', { style: S.sectionHint }, '已选 ' + String(pickedSpecs) + '/' + String(specFields.length) + ' 项规格')),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '写进文案的信息'),
          h('div', { style: S.fieldRow }, ...rows(commonFields)),
          specFields.length === 0 ? null : h('div', { style: S.fieldRow }, ...rows(specFields)),
          h('div', { style: S.buttonRow },
            h('button', { type: 'button', 'data-role': 'copy-pick-all', onClick: () => props.onPickAll(), style: S.button }, '全选'),
            h('button', { type: 'button', 'data-role': 'copy-clear', onClick: () => props.onClear(), style: S.button }, '清空'))),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '文案风格'),
          h(StylePicker, { styleId: form.styleId, onStyle: props.onStyle })),
        h('div', { style: S.section },
          h('div', { style: S.buttonRow },
            h('button', {
              type: 'button', 'data-role': 'copy-submit', disabled: !ready,
              title: ready ? '按当前品类/勾选/风格组装 xy_copy_plan 参数' : '先填商品名与价格（元）',
              onClick: () => props.onSubmit(), style: ready ? S.primary : S.offButton,
            }, '生成文案请求'),
            h('span', { style: S.sectionHint }, ready ? '产出的是工具参数，不是文案' : '填商品名与价格后可生成')),
          submitted ? h(CopyPlanPreview, { request }) : null))
    }
    /** 面板 tab 与内容区的 DOM id：tabpanel 与 tab 用 aria-labelledby / aria-controls 双向关联。 */
    const tabDomId = id => 'bigfish-tab-' + id
    const tabPanelId = id => 'bigfish-panel-' + id
    /** tab 栏：按 PANEL_TABS 的 group 分段，组名以小字前置（侧边栏窄时整条换行，不裁切）。 */
    function TabBar({ active, onSelect }) {
      const groups = []
      for (const tab of PANEL_TABS) {
        const last = groups[groups.length - 1]
        if (last === undefined || last.group !== tab.group) groups.push({ group: tab.group, tabs: [tab] })
        else last.tabs.push(tab)
      }
      return h('div', { role: 'tablist', 'aria-label': 'BigFish 面板分区', style: S.tabBar },
        ...groups.map(entry => h('div', { key: entry.group, style: S.tabGroup, 'data-role': 'panel-tab-group', 'data-group': entry.group },
          h('span', { style: S.tabGroupLabel, 'aria-hidden': 'true' }, entry.group),
          ...entry.tabs.map(tab => h('button', {
            key: tab.id, type: 'button', role: 'tab', id: tabDomId(tab.id), 'aria-controls': tabPanelId(tab.id),
            'data-role': 'panel-tab', 'data-tab': tab.id,
            'aria-selected': tab.id === active, onClick: () => onSelect(tab.id),
            style: tab.id === active ? { ...S.tab, ...S.tabActive } : S.tab,
          }, tab.label)))))
    }

    /**
     * 片段 06：「采集」tab（贴链接 → 解析 → 两次确认入库 → 已入库快照）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 采集口径与红线（面板不联网、不下载图片；落库只留结构化元数据）。 */
    const REFERENCE_NOTES = [
      '贴商家主页或商品链接 → 解析商家 → 采其在售商品；落库只存标题 / 价格 / 类目 / 浏览·想要·收藏 / 图数 / 发布时间。',
      '不下载图片、不存描述全文、不照抄文案；他人店铺勾「看行情」才放开采集。',
      '单件失败不影响整批（进 skipped）；AUTH_EXPIRED / RISK_CONTROL 会中止整批。',
    ]
    /** 采集商品表列；价格按整数分渲染（÷100 用整数运算，不做浮点乘）。 */
    const REFERENCE_COLUMNS = ['标题', '价格', '类目', '浏览', '想要', '收藏', '图', '发布', '结构']
    const REFERENCE_GRID = 'minmax(120px, 1fr) 82px 92px 48px 48px 48px 40px 88px 132px'
    function formatCentsText(cents) {
      const value = Number(cents)
      if (!Number.isFinite(value) || value < 0) return '—'
      const yuan = Math.trunc(value / 100)
      const fen = value % 100
      return fen === 0 ? String(yuan) + ' 元' : String(yuan) + '.' + String(fen).padStart(2, '0') + ' 元'
    }
    function countText(value) { const num = Number(value); return Number.isFinite(num) && num >= 0 ? String(num) : '—' }
    /** 主图比例 → 中文标签；daemon 没给特征（老数据）就显示 —。 */
    function aspectText(image) {
      const aspect = image !== null && typeof image === 'object' ? String(image.aspect ?? '') : ''
      if (aspect === 'square') return '方图'
      if (aspect === 'portrait') return '竖图'
      if (aspect === 'landscape') return '横图'
      if (aspect === 'mixed') return '混排'
      return '—'
    }
    /** 结构列：主图比例 · 标题段数 · 描述句数（只有数字，不含原文）。 */
    function structureText(row) {
      const copy = row.copyFeatures !== null && typeof row.copyFeatures === 'object' ? row.copyFeatures : null
      const image = row.imageFeatures !== null && typeof row.imageFeatures === 'object' ? row.imageFeatures : null
      const segments = copy !== null && Number.isFinite(Number(copy.titleSegments)) ? String(Number(copy.titleSegments)) + ' 段' : '—'
      const sentences = copy !== null && Number(copy.descSentences) > 0 ? String(Number(copy.descSentences)) + ' 句' : '无描述'
      return aspectText(image) + ' · ' + segments + ' · ' + sentences
    }
    /** 采集模块：贴链接 → 解析 → 采集入库（两次确认）→ 看已入库快照。 */
    function ReferenceView({ connection }) {
      const writes = useWrite(connection)
      const [board, setBoard] = React.useState({
        link: '', accountId: '', accounts: [], maxItems: '20', acknowledge: false,
        parsed: null, notice: null, sellers: [], sellerId: '', condition: 'like-new',
        items: { phase: 'idle', total: 0, rows: [] },
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
          hint: '再点一次「确认采集」：翻页读商品并写入本地库',
          busy: '正在采集…',
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
        ? h('div', { style: S.sectionHint, 'data-role': 'reference-empty' }, '还没有采集记录：解析链接后点两次「采集并入库」')
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
        h('span', { style: S.small }, row.publishedAt === undefined ? '—' : formatAgo(row.publishedAt)),
        h('span', { style: S.small, 'data-role': 'reference-structure' }, structureText(row)))
      const itemsBlock = board.items.phase === 'idle'
        ? null
        : board.items.phase === 'loading'
          ? h('div', { style: S.small }, '读取中…')
          : board.items.phase === 'offline'
            ? h('div', { style: S.badText }, '读不到已入库商品（daemon 离线或旧版）')
            : h('div', { 'data-role': 'reference-items' },
              h('div', { style: S.sectionHint }, '商家 ' + board.sellerId + ' · 共 ' + String(board.items.total) + ' 件（最多 200）'),
              h('div', { style: gridRow(REFERENCE_GRID, true) }, ...REFERENCE_COLUMNS.map(label => h('span', { key: label }, label))),
              ...board.items.rows.map(rowOf),
              board.items.rows.length === 0 ? h('div', { style: S.small }, '还没有商品（可能被截断或失败）') : null)
      return h('div', null,
        h('div', { style: S.section, 'data-role': 'reference-panel' },
          h('div', { style: S.sectionTitle }, '链接 → 商家商品入库'),
          h('div', { style: S.fieldRow },
            h(Field, { label: '闲鱼链接', control: h('input', {
              type: 'text', maxLength: 2048, value: board.link, 'data-role': 'reference-link',
              placeholder: 'https://www.goofish.com/personal?userId=…', onChange: event => update({ link: event.target.value, parsed: null }), style: S.input,
            }) }),
            h('div', { style: S.buttonRow },
              h('button', { type: 'button', 'data-role': 'reference-parse', onClick: parse, style: S.button }, '解析链接'))),
          parsed === null ? null : h('div', { style: S.small, 'data-role': 'reference-parsed' },
            parsed.kind === 'seller' ? '商家 id：' + String(parsed.sellerId) : '商品 id：' + String(parsed.itemId) + (parsed.categoryId === undefined ? '' : ' · 类目 ' + String(parsed.categoryId))),
          parsed !== null && parsed.kind === 'item'
            ? h('div', { style: S.warnText, 'data-role': 'reference-item-hint' }, '商品链接：采全店请改贴商家主页；单件统计用 xy_reference_collect')
            : null,
          h('div', { style: S.fieldRow },
            h(Field, { label: '账号', control: board.accounts.length === 0
              ? h('div', { style: S.small }, '还没有导入账号（去「账号」tab）')
              : h('select', { value: board.accountId, 'data-role': 'reference-account', onChange: event => update({ accountId: event.target.value }), style: S.input },
                ...board.accounts.map(id => h('option', { key: id, value: id }, id))) }),
            h(Field, { label: '件数（1–60）', control: h('input', {
              type: 'number', min: 1, max: 60, value: board.maxItems, 'data-role': 'reference-max-items',
              onChange: event => update({ maxItems: event.target.value }), style: S.input,
            }) })),
          h(Field, { label: '他人店铺（仅看行情）', control: h('input', {
            type: 'checkbox', checked: board.acknowledge, 'data-role': 'reference-acknowledge',
            onChange: event => update({ acknowledge: event.target.checked }),
          }) }),
          h('div', { style: S.buttonRow },
            h('button', {
              type: 'button', 'data-role': 'reference-collect', disabled: !collectValid, onClick: collect,
              title: collectValid ? '写入本地库（点两次确认）' : '先解析出商家 id 并选一个账号',
              style: collectValid ? (writes.state.armed === 'collect' ? S.armedButton : S.primary) : S.offButton,
            }, writes.state.armed === 'collect' ? '确认采集' : busy ? '采集中…' : '采集并入库')),
          resultLine(board.notice ?? writes.state.result, 'reference-notice')),
        h('div', { style: S.section, 'data-role': 'reference-sellers' },
          h('div', { style: S.sectionTitle }, '已采集的商家'),
          sellerList,
          itemsBlock),
        h(MarketBriefBlock, { connection, sellerId: board.sellerId, condition: board.condition, onCondition: condition => update({ condition }) }),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '口径'),
          ...REFERENCE_NOTES.map((note, index) => h('div', { key: String(index), style: S.sectionHint }, '· ' + note))))
    }
    /**
     * 行情简报：按商家把已入库商品折成价格带与结构参考（daemon POST /market/brief 的只读聚合）。
     * 建议在「成色」上取档：建议价由中位价 × 成色系数算出，依据原样回显，面板不自己估价。
     */
    function MarketBriefBlock({ connection, sellerId, condition, onCondition }) {
      const [brief, setBrief] = React.useState({ phase: 'idle', value: null })
      // 选中商家或改了成色就重算；输入是纯读聚合，不触网也不写库，可以放心跟着选择走。
      React.useEffect(() => {
        if (sellerId === '') return
        let alive = true
        setBrief({ phase: 'loading', value: null })
        void callRead(connection, 'market.brief', { sellerId, limit: 200, condition }).then(reply => {
          if (!alive) return
          setBrief({ phase: reply.ok ? 'ok' : 'offline', value: reply.ok ? reply.value : null })
        })
        return () => { alive = false }
      }, [connection, sellerId, condition])
      const value = brief.value ?? null
      const stats = value !== null && value.brief !== null && typeof value.brief === 'object' ? value.brief : null
      const price = value !== null && value.priceSuggestion !== null && typeof value.priceSuggestion === 'object' ? value.priceSuggestion : null
      const keywords = value !== null && Array.isArray(value.keywords) ? value.keywords : []
      const aspect = stats === null ? {} : stats.imageAspect ?? {}
      const row = (label, text) => h('div', { style: S.cmdRow, 'data-role': 'market-row' },
        h('span', { style: S.cmdLabel }, label), h('span', { style: S.small }, text))
      const keywordLine = keywords.length === 0 ? null : h('div', { style: S.cmdRow, 'data-role': 'market-keywords' },
        h('span', { style: S.cmdLabel }, '高频词'),
        h('span', { style: S.small }, keywords.map(entry => String(entry.word ?? '') + '(' + String(entry.count ?? 0) + ')').join(' · ')))
      /** 有样本时的明细；缺字段一律按 0 显示（daemon 已保证形状，这里不再编口径）。 */
      const statsBlock = h('div', null,
        row('样本', String(stats?.sampleSize ?? 0) + ' 件'),
        row('价格', '最低 ' + formatCentsText(stats?.priceCents?.min) + ' · P25 ' + formatCentsText(stats?.priceCents?.p25)
          + ' · 中位 ' + formatCentsText(stats?.priceCents?.p50) + ' · P75 ' + formatCentsText(stats?.priceCents?.p75)
          + ' · 最高 ' + formatCentsText(stats?.priceCents?.max)),
        price === null ? null : row('建议价', formatCentsText(price.lowCents) + ' ~ ' + formatCentsText(price.highCents) + '（建议 ' + formatCentsText(price.suggestedCents) + '）'),
        price === null ? null : h('div', { style: S.sectionHint, 'data-role': 'market-basis' }, '定价依据：' + String(price.basis ?? '—')),
        row('标题', '均 ' + String(Math.round(Number(stats?.titleLength?.avg ?? 0))) + ' 字 · 均 ' + String(Math.round(Number(stats?.titleSegmentsAvg ?? 0))) + ' 段 · 描述均 ' + String(Math.round(Number(stats?.descSentencesAvg ?? 0))) + ' 句'),
        row('图片', '均 ' + String(Math.round(Number(stats?.imageCountAvg ?? 0))) + ' 张 · 方 ' + String(aspect.square ?? 0) + ' / 竖 ' + String(aspect.portrait ?? 0) + ' / 横 ' + String(aspect.landscape ?? 0) + ' / 混 ' + String(aspect.mixed ?? 0)),
        keywordLine)
      const body = sellerId === ''
        ? h('div', { style: S.sectionHint }, '先在上面点一个商家：按该商家已入库商品算价格带、结构与建议价')
        : h('div', null,
          h('div', { style: S.fieldRow },
            h(Field, {
              label: '成色（决定建议价档位）',
              control: h('select', {
                value: condition, 'data-role': 'market-condition',
                onChange: event => onCondition(event.target.value), style: S.input,
              }, ...CONDITION_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.label))),
            })),
          brief.phase === 'loading' ? h('div', { style: S.small }, '正在算行情…')
            : brief.phase === 'offline' ? h('div', { style: S.badText }, '算不出来（daemon 离线，或宿主里还没有 market.brief）')
              : Number(stats?.sampleSize ?? 0) === 0 ? h('div', { style: S.small }, '该商家还没有入库商品：先采集')
                : statsBlock)
      return h('div', { style: S.section, 'data-role': 'market-brief' },
        h('div', { style: S.sectionTitle }, '行情简报'),
        body)
    }

    /**
     * 片段 07：设置表单、daemon 状态卡、工作流树、「诊断」tab。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /**
     * 概览底部提示的工具名：只列高频入口（全量 16 个 `xy_*` 工具在工具面板里搜得到，不在这里复刻全表）。
     * 但「高频」要包含真正干活的发布两件套——只列读类工具会让人以为发布得去别处找。
     */
    const OVERVIEW_TOOL_NAMES = ['xy_status', 'xy_tasks_list', 'xy_items_list', 'xy_publish_draft', 'xy_publish_batch', 'xy_market_brief', 'xy_copy_plan', 'xy_ping']
    /**
     * 概览底部提示的命令：与 package.json scripts 一一对应，改脚本要同步这里。
     *
     * 只用 pnpm（仓库是 pnpm workspace，packageManager 字段写死 pnpm）：混 npm 会走另一份语义。
     * 也不要给 `pnpm daemon`（= `node packages/daemon/src/cli.ts`）——它前台阻塞，贴着跑会卡住会话；
     * 起停一律走 scripts/daemon-service.mjs 的 daemon:start / daemon:stop，看状态用 daemon:status。
     */
    const OVERVIEW_COMMANDS = ['pnpm daemon:start', 'pnpm daemon:status', 'pnpm daemon:logs', 'pnpm daemon:import-account', 'pnpm dsh:dev -- --fresh']
    /**
     * 设置：发布间隔（秒）/ 默认类目 / 文案风格；保存是写类，点两次才发 settings.put，成功后重新拉 settings.get。
     *
     * 默认类目允许留空：核心默认值就是 `''`（packages/core/src/settings.ts:79），留空表示「不预设」，
     * 发布时再按下拉实际点选。以前这里要求类目非空，导致新用户第一次打开概览时「保存设置」永远是灰的——
     * 他必须凭空编一个类目才能保存间隔与风格，而按钮变灰的原因只写在 title 里，看不到。
     */
    /** 夹取文案：daemon 把越界值拉到合法区间会放进 clamped，必须说出口，否则「已保存」是半句谎。 */
    function describeClamped(value) {
      const clamped = value !== null && typeof value === 'object' ? value.clamped : null
      if (clamped === null || typeof clamped !== 'object') return ''
      const parts = []
      if (Number.isFinite(clamped.publishMinIntervalMs)) parts.push('发布间隔被压到 ' + String(Math.round(clamped.publishMinIntervalMs / 1000)) + ' 秒')
      if (Number.isFinite(clamped.keepAliveIntervalMs)) parts.push('保活间隔被压到 ' + String(Math.round(clamped.keepAliveIntervalMs / 1000)) + ' 秒')
      if (Number.isFinite(clamped.maxBatchItems)) parts.push('批量上限被压到 ' + String(clamped.maxBatchItems) + ' 条')
      return parts.length === 0 ? 'daemon 把部分数值夹到了合法区间（' + Object.keys(clamped).join('、') + '），按回读值重新确认' : '已保存，但 ' + parts.join('；')
    }
    function SettingsForm({ connection, settings }) {
      const save = useWrite(connection)
      const [form, setForm] = React.useState(settingsForm(settings))
      const seconds = Number(form.interval)
      const intervalOk = Number.isFinite(seconds) && seconds >= 30 && seconds <= 3600
      const valid = intervalOk
      const category = form.category.trim()
      const patch = { publishMinIntervalMs: Math.round(seconds * 1000), defaultCategory: category, copyStyle: form.style }
      const refresh = () => { void callRead(connection, 'settings.get').then(reply => { if (reply.ok && reply.value !== null && typeof reply.value === 'object') setForm(settingsForm(reply.value)) }) }
      const change = key => event => setForm({ ...form, [key]: event.target.value })
      return h('div', { 'data-role': 'settings-form', style: S.fieldRow },
        h(Field, { label: '发布间隔（秒）', control: h('input', { type: 'number', min: 30, max: 3600, value: form.interval, onChange: change('interval'), style: S.input }) }),
        h(Field, { label: '默认类目（可留空）', control: h('input', { type: 'text', value: form.category, maxLength: 200, placeholder: '留空 = 不预设，发布时再选', onChange: change('category'), style: S.input }) }),
        h(Field, { label: '文案风格', control: h('select', { value: form.style, onChange: change('style'), style: S.input }, ...COPY_STYLE_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.label))) }),
        h('div', { style: S.buttonRow },
          h('button', { type: 'button', 'data-role': 'settings-save', disabled: !valid || save.state.busy, title: valid ? '写盘并回读 settings' : '发布间隔要填 30–3600 秒', onClick: () => save.run('settings', 'settings.put', { patch }, { hint: '再点一次「确认保存」', busy: '正在保存…', done: value => describeClamped(value) === '' ? '设置已保存' : describeClamped(value), after: refresh }), style: valid && !save.state.busy ? (save.state.armed === 'settings' ? S.armedButton : S.primary) : S.offButton }, save.state.armed === 'settings' ? '确认保存' : save.state.busy ? '保存中…' : '保存设置')),
        valid ? null : h('div', { style: S.small, 'data-role': 'settings-hint', role: 'status' }, '发布间隔要填 30–3600 秒（现在填的是「' + form.interval + '」）；默认类目可以留空。'),
        resultLine(save.state.result, 'settings-result'))
    }
    /** worker 计数（daemon 未注入 worker 时不带这一行）：回答「队列到底有没有人在领」。 */
    function workerLine(worker) {
      if (worker === null || typeof worker !== 'object') return null
      const text = '领取 ' + String(worker.leased ?? 0) + ' · 完成 ' + String(worker.done ?? 0)
        + ' · 失败 ' + String(worker.failed ?? 0) + ' · 错误 ' + String(worker.errors ?? 0)
      return h('div', { style: S.cmdRow, 'data-role': 'daemon-worker' },
        h('span', { style: S.cmdLabel }, 'worker'), h('span', null, text))
    }
    /** 一条命令 + 复制按钮：概览里的命令以前只能肉眼看，得手抄到终端。 */
    function CommandChips({ commands }) {
      const [state, setState] = React.useState({ copied: '', failed: '' })
      const onCopy = command => {
        void copyText(command).then(ok => setState(ok ? { copied: command, failed: '' } : { copied: '', failed: command }))
      }
      return h('div', null,
        h('div', { style: S.cmdRow }, ...commands.map(command => h('span', { key: command, style: S.cmdRow },
          h('code', { style: S.cmdCode }, command),
          h('button', { type: 'button', 'data-role': 'overview-command-copy', 'data-command': command, title: '复制 ' + command, onClick: () => onCopy(command), style: S.chipMini }, state.copied === command ? '已复制' : '复制')))),
        state.failed === '' ? null : h('div', { style: S.manualHint, 'data-role': 'overview-command-hint', role: 'status' }, '宿主没给剪贴板权限：手动选中 ' + state.failed + ' 复制'))
    }
    /** daemon 实时状态 + 进程管理；发布页把设置摘要换成可保存的输入。 */
    function DaemonStatus({ connection, snapshot, editable }) {
      const actions = useDaemonAction(connection)
      const online = snapshot.phase === 'ok' && snapshot.data !== null
      const action = actions.state
      // supervisor 的「没起来」不一定抛错：rpc 可能回 ok:true，但 value.status 是 failed / unavailable，
      // 真正的证据在 value.detail（exitCode / daemonLog / tail）。两种都要摊出来，否则只剩一句「没起来」。
      const started = action.value !== null && typeof action.value === 'object' ? action.value : null
      const startStatus = started !== null && typeof started.status === 'string' ? started.status : ''
      const startFailed = action.notice !== null && (action.notice.kind === 'bad' || ['failed', 'unavailable', 'disabled', 'skipped'].includes(startStatus))
      const failure = startFailed ? startFailureDetail(action.value) : { daemonLog: '', exitCode: null, tail: '' }
      const startMessage = started !== null && typeof started.message === 'string' ? started.message : ''
      const noticeText = startFailed && startMessage !== '' ? startMessage : action.notice === null ? '' : action.notice.text
      const noticeKind = startFailed ? 'bad' : action.notice === null ? '' : action.notice.kind
      const failureBlock = failure.daemonLog === '' && failure.tail === '' && failure.exitCode === null ? null : h('div', { 'data-role': 'daemon-failure' },
        failure.exitCode === null ? null : h('div', { style: S.small }, '退出码 ' + String(failure.exitCode)),
        failure.daemonLog === '' ? null : h('div', { style: S.small, 'data-role': 'daemon-logfile' }, '日志：' + failure.daemonLog),
        failure.tail === '' ? null : h('pre', { style: S.pre, 'data-role': 'daemon-logtail' }, failure.tail))
      const manage = h('div', { style: S.section, 'data-role': 'daemon-manage' },
        h('div', { style: S.sectionTitle }, '进程管理'),
        h('div', { style: S.buttonRow },
          h('button', { type: 'button', 'data-role': 'daemon-start', disabled: online || action.busy !== '', title: online ? 'daemon 已在线' : '让宿主拉起本地 daemon', onClick: actions.start, style: !online && action.busy === '' ? S.primary : S.offButton }, action.busy === 'daemon.start' ? '正在启动…' : '启动 daemon'),
          h('button', { type: 'button', 'data-role': 'daemon-stop', disabled: !online || action.busy !== '', title: online ? '停止 daemon（会中断在飞任务）' : 'daemon 未运行', onClick: actions.stop, style: online && action.busy === '' ? (action.stopArmed ? S.armedButton : S.primary) : S.offButton }, action.stopArmed ? '确认停止 daemon' : action.busy === 'daemon.stop' ? '正在停止…' : '停止 daemon')),
        // aria-live：上膛/过期/失败都要被读屏播报，不能只靠颜色。
        noticeText === '' ? null : h('div', { style: noticeKind === 'bad' ? S.badText : noticeKind === 'warn' ? S.warnText : S.okText, 'data-role': 'daemon-manage-notice', role: 'status', 'aria-live': 'polite' }, noticeText),
        failureBlock)
      if (snapshot.phase === 'loading') return h('div', { style: S.sectionHint, 'data-role': 'daemon-state' }, '正在连接 daemon…')
      const data = snapshot.data
      if (snapshot.phase !== 'ok' || data === null) return h('div', { 'data-role': 'daemon-state' }, h('div', { style: S.badText }, OFFLINE_TEXT), manage)
      const health = data.health ?? {}
      const missing = Array.isArray(data.missing) ? data.missing : []
      // 缺哪几项就直说，别拿默认值冒充真值：账号读不到 ≠ 没有账号，队列读不到 ≠ 队列是空的。
      const accounts = Array.isArray(data.accounts) ? data.accounts : []
      const readyCount = accounts.filter(account => account !== null && typeof account === 'object' && account.ready === true).length
      // 缺哪几项就直说，别拿默认值冒充真值：账号读不到 ≠ 没有账号，队列读不到 ≠ 队列是空的。
      const accountText = missing.includes('accounts')
        ? '这轮没读到（不是 0 个，别照着这个以为没账号）'
        : String(accounts.length) + ' 个账号 · ' + String(readyCount) + ' 个可写' + (accounts.length === 0 ? '（先导入登录态）' : '')
      const line = (role, label, value) => h('div', { style: S.cmdRow, 'data-role': role }, h('span', { style: S.cmdLabel }, label), h('span', null, value))
      return h('div', { style: S.section, 'data-role': 'daemon-state' },
        h('div', { style: S.sectionTitle }, 'daemon 状态'),
        missing.length === 0 ? null : h('div', { style: S.warnText, 'data-role': 'daemon-partial', role: 'status' },
          'daemon 在线，但这一轮有 ' + missing.length + ' 项没拉到：' + missing.join('、') + '（下面这些数字是上一轮/默认值，不是实时值）'),
        line('daemon-health', 'daemon', '在线 · v' + String(health.version ?? '?') + ' · 已运行 ' + formatUptime(health.uptimeMs)),
        line('daemon-accounts', '账号就绪', accountText),
        line('daemon-queue', '队列', missing.includes('status') ? '这轮没读到队列计数' : describeQueue(data.status?.queue ?? {})),
        workerLine(data.status?.worker ?? null),
        line('daemon-batch', '最近批次', describeBatch(data.batch)),
        editable ? h(SettingsForm, { connection, settings: data.settings ?? {} }) : null,
        manage)
    }
    /** 工作流树：把 /events 的增量事件渲染成「任务 → 步骤」，只显示最近 6 个任务 × 最近 6 步。 */
    function WorkflowTree({ connection }) {
      const stream = useWorkflowEvents(connection)
      const tasks = groupEventsByTask(stream.events).slice(-6).reverse()
      // UNSUPPORTED 只可能来自「宿主加载的是重启前的旧插件」：该重启 DSH 桌面应用，不是重启 daemon。
      const hint = stream.phase === 'loading' ? '正在读取步骤事件…'
        : stream.phase === 'offline' ? (stream.code === 'UNSUPPORTED' ? '宿主里跑的是重启前的旧代码（没有 events.list）：重启 DSH 桌面应用后自动恢复' : '事件流拉取失败（daemon 离线或旧版）')
          : tasks.length === 0 ? '还没有步骤事件：执行任务时才会写' : '最近 ' + String(tasks.length) + ' 个任务 · 3 秒增量'
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

    /**
     * 待办提醒：只列「需要人动手」的三类——失败/待审任务、凭据不全的账号、熔断中的账号。
     *
     * TODO(metrics)：这里只能报「当前态」（队列计数 + 账号状态 + 熔断表），没有 7 日趋势与失败原因 Top，
     * 因为 daemon 还没有 /metrics 聚合端点。方案见 docs/dashboard-plan.md §「下一步」：
     * 加 GET /metrics（core/stats.ts 纯函数 + daemon/metrics.ts）+ 只读 rpc metrics.get，
     * 概览就能出趋势与失败 Top5；在那之前不要在这里编造趋势数字。
     */
    function alertLines(snapshot) {
      if (snapshot.phase === 'loading') return [h('div', { key: 'loading', style: S.sectionHint }, '正在读取…')]
      if (snapshot.phase !== 'ok' || snapshot.data === null) return [h('div', { key: 'off', style: S.sectionHint }, '连接后台后才会出现提醒')]
      const status = snapshot.data.status ?? {}
      const queue = status.queue ?? {}
      const accounts = Array.isArray(snapshot.data.accounts) ? snapshot.data.accounts : []
      const circuits = status.circuits !== null && typeof status.circuits === 'object' ? status.circuits : {}
      const lines = []
      const failed = Number(queue.failed ?? 0), review = Number(queue.needs_review ?? 0)
      if (failed > 0) lines.push({ kind: 'bad', text: '失败 ' + String(failed) + ' 条：去「发布」tab 按「失败」筛选，可重试或看失败原因' })
      if (review > 0) lines.push({ kind: 'warn', text: '待审 ' + String(review) + ' 条：去「发布」tab 按「待审」筛选，看清原因后点「重试」或「标记完成」' })
      for (const account of accounts) {
        const id = String(account !== null && typeof account === 'object' ? account.accountId ?? '' : '')
        if (id !== '' && account.ready !== true) lines.push({ kind: 'warn', text: '账号 ' + id + ' 凭据不完整：去「账号」tab 重新导入或扫码' })
      }
      // 熔断是 daemon 侧自动冷却的（circuits.json）：等得到，但风控命中后干等 10 分钟很难受。
      // 重置入口就在下面一行按钮（circuits.reset），要人确认两次——解除刹车之后下一次写就真打到闲鱼。
      for (const [accountId, reason] of Object.entries(circuits)) {
        lines.push({ kind: 'bad', text: '账号 ' + accountId + ' 熔断中（' + String(reason) + '）：等冷却自动放行，或确认无风险后点下面的「复位熔断」' })
      }
      if (lines.length === 0) return [h('div', { key: 'clear', style: S.goodText, 'data-role': 'overview-clear' }, '没有待办：队列、账号、熔断都正常')]
      return lines.map((line, index) => h('div', { key: String(index), style: line.kind === 'bad' ? S.badText : S.warnText, 'data-role': 'overview-alert' }, '· ' + line.text))
    }
    /**
     * 熔断复位：没有这个按钮时，「账号被熔断」只能等 daemon 的 10 分钟冷却，
     * 而面板此前还写着「手动重置待 rpc 补 circuits.reset」——把话说死了却没有出口。
     * 复位本身不触达闲鱼，但它解除的是「暂停写」这道刹车，所以仍然点两次。
     */
    function CircuitResetRow({ connection, snapshot }) {
      const reset = useWrite(connection)
      if (snapshot.phase !== 'ok' || snapshot.data === null) return null
      const circuits = snapshot.data.status !== null && typeof snapshot.data.status === 'object' && snapshot.data.status.circuits !== null && typeof snapshot.data.status.circuits === 'object' ? snapshot.data.status.circuits : {}
      const ids = Object.keys(circuits)
      if (ids.length === 0) return null
      return h('div', { style: S.buttonRow, 'data-role': 'circuit-actions' },
        ...ids.map(accountId => h('button', {
          key: accountId, type: 'button', 'data-role': 'circuit-reset', 'data-account-id': accountId,
          disabled: reset.state.busy,
          title: '确认账号 ' + accountId + ' 现在安全（风控冷却够久）后再复位；复位后下一次写会真的打到闲鱼',
          onClick: () => reset.run('circuit:' + accountId, 'circuits.reset', { accountId }, {
            hint: '再点一次确认复位 ' + accountId + '：复位后下一次写会立刻打到闲鱼',
            busy: '正在复位…',
            done: value => value !== null && typeof value === 'object' && value.reset === false
              ? 'daemon 说这个账号其实不在熔断表里（熔断器可能没加载）'
              : '已复位 ' + accountId + '；仍要先想清楚上次为什么被熔断',
          }),
          style: reset.state.armed === 'circuit:' + accountId ? { ...S.chip, ...S.chipActive } : S.chip,
        }, reset.state.armed === 'circuit:' + accountId ? '确认复位 ' + accountId : '复位熔断 ' + accountId)),
        resultLine(reset.state.result, 'circuit-result'))
    }
    /** 概览页 = 驾驶舱（概况 + 待办 + 工作流）+ 系统区（进程管理 / 设置 / 命令）。默认落地页。 */
    function OverviewTab({ connection }) {
      const snapshot = useDaemonSnapshot(connection)
      return h('div', null,
        h(DaemonStatus, { connection, snapshot, editable: true }),
        h('div', { style: S.section, 'data-role': 'overview-todo' },
          h('div', { style: S.sectionTitle }, '待办提醒'),
          ...alertLines(snapshot),
          h(CircuitResetRow, { connection, snapshot })),
        h(WorkflowTree, { connection }),
        h('div', { style: S.section, 'data-role': 'overview-commands' },
          h('div', { style: S.sectionTitle }, '工具与命令'),
          h('div', { style: S.cmdRow }, ...OVERVIEW_TOOL_NAMES.map(name => h('code', { key: name, style: S.cmdCode }, name))),
          h(CommandChips, { commands: OVERVIEW_COMMANDS }),
          h('div', { style: S.sectionHint }, '面板只走 rpc（/bigfish），不直连 daemon；daemon 默认监听 ' + DAEMON_ADDR)))
    }

    /**
     * 片段 08：面板骨架（tab 分发 + 面板级状态，切 tab 不丢输入）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /**
     * 当前 tab 的内容区：只在 `PANEL_TABS` 里查表，**不写 if 链**——
     * 加模块不会再出现「加了 tab 忘了分支」这类半死 tab。未知 id 回落到默认页，不渲染空白。
     */
    function PanelBody({ tab, copyProps, connection }) {
      const entry = PANEL_TABS.find(item => item.id === tab) ?? PANEL_TABS[0]
      return h(entry.component, entry.pickProps === undefined ? { connection } : entry.pickProps({ copyProps, connection }))
    }

    /** 面板骨架：页头 + 固定 tab 栏 + 唯一滚动的内容区。connection 由 apply 注入（模块级单实例）。 */
    function BigFishPanel() {
      const [tab, setTab] = React.useState(DEFAULT_TAB_ID)
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
      return h('div', { style: S.root, 'data-role': 'panel-root' },
        h('div', { style: S.header },
          h('div', { style: S.logo }, '🐟'),
          h('div', null,
            h('div', { style: S.title }, 'BigFish 闲鱼运营'),
            h('div', { style: S.subtitle }, '账号 → 采集 → 文案 → 发布 → 商品'))),
        // tab 栏在滚动区之外：滚到内容底部也能直接切模块。
        h(TabBar, { active: tab, onSelect: setTab }),
        h('div', { style: S.scroll, 'data-role': 'panel-scroll' },
          h('div', {
            style: S.content, role: 'tabpanel', id: tabPanelId(tab), 'aria-labelledby': tabDomId(tab),
          }, h(PanelBody, { tab, copyProps, connection: panelConnection }))))
    }

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
      /** 行内小按钮（复制命令 / 复制 id）：表格里塞 4 个也不撑宽列。 */
      chipMini: { fontSize: '11px', padding: '2px 8px', borderRadius: '999px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)' },
      /** 「上膛」态：虚线边 + 警告色，与普通可用按钮在视觉上拉开距离（点两次才生效的写动作）。 */
      armedButton: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', border: '1px dashed var(--dsw-alias-label-warning, #9a6700)', background: 'var(--dsw-alias-bg-l3)', color: 'var(--dsw-alias-label-warning, #9a6700)', fontWeight: 600 },
      /** 表格行内的操作按钮：比 S.button 小一号，7 列表格放得下 4 个。 */
      rowButton: { fontSize: '12px', padding: '4px 8px', borderRadius: '6px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l2)', color: 'var(--dsw-alias-label-primary)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    }
    /** 置灰态：与可用按钮同形，光标与透明度明确「点不动」（S.button 现在表示可用）。 */
    S.offButton = { ...S.button, cursor: 'not-allowed', opacity: 0.55, color: 'var(--dsw-alias-label-secondary)' }
    /** 行内按钮的两个派生态（禁用 / 上膛），写法同 S.offButton。 */
    S.rowOffButton = { ...S.rowButton, cursor: 'not-allowed', opacity: 0.5, color: 'var(--dsw-alias-label-secondary)' }
    S.rowArmedButton = { ...S.rowButton, border: '1px dashed var(--dsw-alias-label-warning, #9a6700)', color: 'var(--dsw-alias-label-warning, #9a6700)', fontWeight: 600 }
    /** 复制失败时给的手动兜底提示（剪贴板在部分宿主里不可用）。 */
    S.manualHint = { fontSize: '11px', color: 'var(--dsw-alias-label-warning, #9a6700)', marginTop: '6px' }
    /**
     * 片段 11：「账号」tab（多账号表、登录检测缓存、保活开关）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    // —— 账号管理：多账号表（切换 / 退出 / 登录态剩余 / 保活）+ 进入即检测（10 分钟内不重复）——
    const VERIFY_TTL_MS = 600_000
    const ACCOUNT_COLUMNS = ['当前', '账号', '状态', '剩余', '检测', '更新', '操作']
    /**
     * 7 列宽度必须落在内容轴（10-styles 的 S.content.maxWidth = 860px）内，否则表格横向溢出、右侧「操作」被裁。
     * 固定列合计 710px + 6 个 8px 间距 = 758px，剩下的由「账号」列吃掉；行内按钮换成 S.rowButton 后单列也放得下 4 个。
     */
    const ACCOUNT_GRID = '72px minmax(90px, 1fr) 88px 84px 80px 116px 180px'
    const ACCOUNT_CODE_LABELS = { AUTH_EXPIRED: '登录态过期', RISK_CONTROL: '风控拦截', RATE_LIMITED: '被限流', NETWORK: '网络异常', VALIDATION: '参数不合法', INTERNAL: '后台错误' }
    /** 10 分钟缓存：自动检测真调 mtop head（风控敏感），行内「检测」强制刷新。 */
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
    /** 托管浏览器文案：窗口在不在决定下一步；旧 daemon 没有 /browser 时如实说未知。 */
    function browserText(browser) {
      if (browser === null) return '托管浏览器：状态未知'
      if (browser.enabled !== true) return '托管浏览器：daemon 未接入'
      const port = String(browser.port ?? '?')
      if (browser.running === true) {
        const who = browser.owned === true ? '运行中（daemon 拉起）' : '复用已开的外部调试浏览器'
        return '托管浏览器：' + who + ' · 端口 ' + port
      }
      return '托管浏览器：未启动 · 端口 ' + port + '（点扫码自动拉起）'
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
      const [board, setBoard] = React.useState({ phase: 'loading', accounts: [], verifies: {}, keep: null, browser: null, addId: '', addPort: '9222', result: null })
      const writes = useWrite(connection)
      const [switching, setSwitching] = React.useState('')
      const update = patch => setBoard(previous => ({ ...previous, ...patch }))
      /** 页级：有写操作在飞（添加账户 / 保活这类整页唯一的入口才用它）。 */
      const busy = writes.state.busy || switching !== ''
      /**
       * 行级锁：一次写操作只该锁住它所在的那一行。以前用一个布尔 busy 把整张表 7 列 × N 行的
       * 按钮全部置灰——多账号时想给另一行点「检测」也被拦，只能干等。
       */
      const rowWriting = accountId => writes.state.busyKey === 'import:' + accountId
        || writes.state.busyKey === 'login:' + accountId
        || writes.state.busyKey === 'logout:' + accountId
      const rowLocked = accountId => switching === accountId || rowWriting(accountId)
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
      /** 拉账号摘要 + 托管浏览器状态；auto=true 时对缓存过期的账号自动检测（新导入的账号也会补一次）。 */
      const pull = async (auto, alive = () => true) => {
        const [reply, browserReply] = await Promise.all([callRead(connection, 'accounts'), callRead(connection, 'browser.status')])
        if (!alive()) return
        const list = reply.ok && Array.isArray(reply.value) ? reply.value : []
        // 旧版 daemon 没有 /browser：保持 null，面板显示「状态未知」而不是假装没启动。
        const browser = browserReply.ok && browserReply.value !== null && typeof browserReply.value === 'object' ? browserReply.value : null
        setBoard(previous => ({ ...previous, phase: reply.ok ? 'ok' : 'offline', accounts: list, browser }))
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
        // 只拦「正在切另一个号 / 本行有写在跑」：别的行有写操作时切换当前账号是安全的（读侧设置）。
        if (switching !== '' || rowWriting(accountId)) return
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
      /** 端口只对「导入」有意义：扫码走 daemon 的托管浏览器（端口由 daemon 决定，面板不该猜）。 */
      const runAdd = kind => {
        const payload = {}, accountId = board.addId.trim()
        if (kind === 'import') {
          const port = Number(board.addPort)
          if (!Number.isInteger(port) || port < 1 || port > 65535) return update({ result: { kind: 'bad', text: 'Chrome 端口必须是 1..65535 的整数' } })
          payload.port = port
        }
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
      const actionButton = (role, label, onClick, disabled, armed) => h('button', { key: role, type: 'button', 'data-role': role, disabled, onClick, style: disabled ? S.rowOffButton : armed ? S.rowArmedButton : S.rowButton }, label)
      /** 只锁本行：别的行仍然可以点（以前 busy 是页级布尔，锁整表）。 */
      const rowActions = (accountId, checking) => {
        const locked = rowLocked(accountId), running = rowWriting(accountId)
        const armedFor = kind => writes.state.armed === kind + ':' + accountId
        return [
          actionButton('account-verify', checking ? '检测中…' : '检测', () => void verifyOne(accountId, 'manual'), checking || locked),
          actionButton('account-import', armedFor('import') ? '确认导入' : running && writes.state.busyKey === 'import:' + accountId ? '导入中…' : '导入', () => runRowWrite('import', accountId), locked, armedFor('import')),
          actionButton('account-login', armedFor('login') ? '确认扫码' : running && writes.state.busyKey === 'login:' + accountId ? '等待扫码…' : '扫码', () => runRowWrite('login', accountId), locked, armedFor('login')),
          actionButton('account-logout', armedFor('logout') ? '确认退出登录' : running && writes.state.busyKey === 'logout:' + accountId ? '退出中…' : '退出', () => runRowWrite('logout', accountId), locked, armedFor('logout')),
        ]
      }
      const rowOf = account => {
        const accountId = String(account.accountId ?? ''), entry = board.verifies[accountId] ?? storedEntry(account), badge = accountBadge(entry)
        const checking = entry !== undefined && entry.phase === 'checking'
        return h('div', { key: accountId, style: gridRow(ACCOUNT_GRID, false), 'data-role': 'account-row', 'data-account-id': accountId },
          h('div', { style: S.actions },
            account.active === true ? h('span', { key: 'active', style: S.goodText, 'data-role': 'account-active' }, '当前') : null,
            h('button', { key: 'switch', type: 'button', 'data-role': 'account-switch', disabled: switching !== '' || rowWriting(accountId), title: '把当前账号切到 ' + accountId, onClick: () => switchAccount(accountId), style: switching !== '' || rowWriting(accountId) ? { ...S.chip, ...S.chipOff } : S.chip }, switching === accountId ? '切换中…' : '切换')),
          h('span', null, accountId),
          h('span', { style: badge[1], 'data-role': 'account-status' }, badge[0]),
          h('span', { style: S.small, 'data-role': 'account-lifetime' }, formatLifetime(account.loginExpiresAt, account.loginExpiresSource)),
          h('span', { style: S.small, 'data-role': 'account-checked' }, entry === undefined ? '—' : formatClock(entry.checkedAt) + '（' + (entry.source === 'manual' ? '人工' : '自动') + '）'),
          h('span', null,
            h('span', { style: S.small, 'data-role': 'account-updated' }, formatAgo(account.updatedAt) + ' · ' + (account.ready === true ? '字段齐备' : '字段不齐')),
            h('span', { style: S.small, 'data-role': 'account-fields' }, ' · ' + String(account.savedFieldCount ?? '?') + ' 项')),
          h('div', { style: S.actions }, ...rowActions(accountId, checking)))
      }
      const addButton = (role, kind, label) => actionButton(role, writes.state.armed === 'add:' + kind ? (kind === 'import' ? '确认导入' : '确认扫码') : label, () => runAdd(kind), busy, writes.state.armed === 'add:' + kind)
      const addSection = h('div', { style: S.section, 'data-role': 'account-add' },
        h('div', { style: S.sectionTitle }, '添加账户'),
        h('div', { style: S.fieldRow },
          h(Field, { label: '账号 id（留空 = 从 Chrome 读 unb）', control: h('input', { type: 'text', maxLength: 64, value: board.addId, placeholder: '2206569289277', 'data-role': 'account-add-id', onChange: event => update({ addId: event.target.value }), style: S.input }) }),
          h(Field, { label: 'Chrome 调试端口', control: h('input', { type: 'number', min: 1, max: 65535, value: board.addPort, 'data-role': 'account-add-port', onChange: event => update({ addPort: event.target.value }), style: S.input }) })),
        // 状态行放在按钮上面：用户要先知道「窗口在不在」才谈得上点哪个按钮。
        h('div', { style: S.small, 'data-role': 'account-browser' }, browserText(board.browser)),
        // 两个入口前置条件不同：导入要用户先开调试端口，扫码由 daemon 拉起托管浏览器。
        h('div', { style: S.small, 'data-role': 'account-add-hint' }, '从 Chrome 导入：先用 --remote-debugging-port=' + String(board.addPort) + ' 启动并登录闲鱼；扫码：daemon 自开托管窗口。'),
        h('div', { style: S.buttonRow }, addButton('account-add-import', 'import', 'Chrome 导入'), addButton('account-add-login', 'login', '扫码登录')))
      const keepButtonLabel = writes.state.armed === 'keepalive-toggle'
        ? (keep.enabled ? '确认关闭' : '确认开启')
        : busy ? '请稍候…' : (keep.enabled ? '关闭保活' : '开启保活')
      const keepaliveSection = h('div', { style: S.section, 'data-role': 'account-keepalive' },
        h('div', { style: S.sectionTitle }, '登录保活'),
        h('div', { style: S.fieldRow },
          h('div', { style: { ...S.buttonRow, marginTop: '0', alignSelf: 'flex-end' } }, actionButton('keepalive-toggle', keepButtonLabel, toggleKeepAlive, !keepValid || busy, writes.state.armed === 'keepalive-toggle')),
          h(Field, { label: '间隔（秒）', control: h('input', { type: 'number', min: 60, max: 3600, value: keep.seconds, 'data-role': 'keepalive-interval', onChange: event => update({ keep: { ...keep, seconds: event.target.value } }), style: S.input }) }),
          h('div', { style: { ...S.buttonRow, marginTop: '0', alignSelf: 'flex-end' } }, actionButton('keepalive-save', writes.state.armed === 'keepalive-interval' ? '确认保存' : busy ? '保存中…' : '保存间隔', saveKeepInterval, !keepValid || busy, writes.state.armed === 'keepalive-interval'))),
        h('div', { style: { ...S.small, marginTop: '10px' }, 'data-role': 'keepalive-state' }, keep.enabled ? '已开启：每 ' + keep.seconds + ' 秒校验登录态' : '未开启'))
      const emptyRow = h('div', { style: gridRow(ACCOUNT_GRID, false), 'data-role': 'account-empty' }, h('span', { style: { ...S.small, gridColumn: 'span 7' } }, '还没有导入账号'))
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, '账号管理'),
        addSection,
        keepaliveSection,
        board.phase === 'loading' ? h('div', { style: S.small }, '正在读取账号…') : null,
        board.phase === 'offline' ? h('div', { style: S.badText, 'data-role': 'account-offline' }, '连不上 daemon') : null,
        h('div', { 'data-role': 'account-table' },
          h('div', { style: gridRow(ACCOUNT_GRID, true) }, ...ACCOUNT_COLUMNS.map(label => h('span', { key: label }, label))),
          ...board.accounts.map(rowOf), board.phase === 'ok' && board.accounts.length === 0 ? emptyRow : null),
        resultLine(board.result ?? writes.state.result, 'account-result'))
    }
    /**
     * 片段 11b：宿主设置页「BigFish 是否启用」卡片（settings.plugin.item，key=bigfish-ops）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     *
     * 为什么走宿主设置页而不是侧边栏：用户 2026-11-05 拍板「宿主设置页插件卡片」。
     * host 侧（src/settings-host.js）注册同名命名空间 bigfish-ops，client 侧按同 key 注册卡片，
     * 两者交集才显示（DSH ui-settings-plugins 的约束）。settingsScope 是可选服务：旧宿主 / CLI /
     * 测试替身没有它时整段跳过，不影响侧边栏面板。决策见 docs/adr/0007。
     */
    /** 与 host 的 SETTINGS_NAMESPACE 逐字一致；client 物理隔离拿不到 host 常量，只能复制一份。 */
    const SETTINGS_NS = 'bigfish-ops'

    /** 守卫式读 settingsScope 服务：缺失返回 null，绝不因设置页把侧边栏拖垮。 */
    function readSettingsScope(ctx) {
      try {
        const service = ctx === null || ctx === undefined ? undefined : ctx.settingsScope
        if (service === null || service === undefined || typeof service.bind !== 'function') return null
        return service
      } catch { return null }
    }

    /** 取一次快照；坏值按「未就绪」处理，不假装知道开关状态。 */
    function settingsSnapshot(scope) {
      try {
        const snapshot = scope.getSnapshot()
        return snapshot !== null && typeof snapshot === 'object' ? snapshot : {}
      } catch { return {} }
    }

    /** 当前是否启用：value.enabled 明确是 false 才算关，其余（含缺失）按装配层默认开。 */
    function settingsEnabled(snapshot) {
      const value = snapshot.value
      return !(value !== null && typeof value === 'object' && value.enabled === false)
    }

    /**
     * 设置卡片：一个布尔开关，点一下就通过 settingsScope.mutate 写回 ~/.dsh/settings.yaml。
     * 订阅 scope 变化刷新显示；未 ready / 不可写时禁用按钮并说明原因（不静默）。
     */
    function BigFishSettingsCard(props) {
      const scope = props.scope
      const [snapshot, setSnapshot] = React.useState(settingsSnapshot(scope))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        if (typeof scope.subscribe !== 'function') return undefined
        return scope.subscribe(() => setSnapshot(settingsSnapshot(scope)))
      }, [scope])
      const enabled = settingsEnabled(snapshot)
      const ready = snapshot.status === 'ready'
      const writable = ready && snapshot.writable === true
      const toggle = () => {
        if (busy || !writable || typeof scope.mutate !== 'function') return
        const next = !enabled
        const revision = snapshot.revision
        setBusy(true)
        setError('')
        Promise.resolve()
          .then(() => scope.mutate([{ op: 'set', path: ['enabled'], value: next }], revision))
          .then(() => { setBusy(false); setSnapshot(settingsSnapshot(scope)) })
          .catch((failure) => { setBusy(false); setError(failure instanceof Error ? failure.message : String(failure)) })
      }
      return h('li', { 'data-role': 'bigfish-settings-card' },
        h('div', { style: { fontWeight: 600 } }, 'BigFish 闲鱼运营'),
        h('p', { style: { margin: '4px 0', opacity: 0.75 } },
          '关闭后本插件不再注册任何 xy_* 工具与写操作审批门禁，也不再占用每轮会话的工具定义 token；后台 daemon 桥接不受影响。'),
        h('button', {
          type: 'button',
          'data-role': 'bigfish-enabled-toggle',
          disabled: busy || !writable,
          onClick: toggle,
        }, busy ? '保存中…' : (enabled ? '已启用 · 点击停用' : '已停用 · 点击启用')),
        !writable ? h('p', { style: { opacity: 0.7 } }, '设置服务未就绪或不可写，暂时无法切换。') : null,
        error === '' ? null : h('p', { style: { opacity: 0.85 } }, '保存失败：' + error),
      )
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
      // 宿主设置页卡片走 fiber inject 等可选的 settingsScope 服务（与 dshmarket 同款）。
      // 守卫：旧宿主 / CLI / 测试替身没有 ctx.inject 时整段跳过，绝不把侧边栏面板拖垮，
      // 也让 client-bundle.test 的「只注册 sidebar.panellist + main」断言继续成立。
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['settingsScope'], (scoped) => {
            const service = readSettingsScope(scoped)
            if (service === null || scoped.slots === undefined) return
            const scope = service.bind({ namespace: SETTINGS_NS })
            scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
              name: 'settings.plugin.item', key: SETTINGS_NS,
            }, () => h(BigFishSettingsCard, { scope })))
          })
        } catch (error) {
          // 设置页是可选增强：任何异常都只让卡片缺席，不波及侧边栏主面板；但要留痕，不静默吞。
          console.warn('bigfish: 设置卡片注册失败（侧边栏不受影响）', error instanceof Error ? error.message : String(error))
        }
      }
    }
    return { apply, inject: ['slots', 'connection'] }
  },
})