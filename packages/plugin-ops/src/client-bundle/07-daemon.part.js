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

