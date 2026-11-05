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
