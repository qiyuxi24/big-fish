    /**
     * 片段 07：设置表单、daemon 状态卡、工作流树、「诊断」tab。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /** 概览底部提示的工具名：只列高频入口（全量 15 个 `xy_*` 工具在工具面板里搜得到，不在这里复刻全表）。 */
    const OVERVIEW_TOOL_NAMES = ['xy_status', 'xy_tasks_list', 'xy_items_list', 'xy_market_brief', 'xy_ping']
    /** 概览底部提示的命令：与 package.json scripts 一一对应，改脚本要同步这里。 */
    const OVERVIEW_COMMANDS = ['npm run daemon', 'npm run daemon:import-account', 'npm run dsh:dev -- --fresh']
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
          h('button', { type: 'button', 'data-role': 'settings-save', disabled: !valid || save.state.busy, title: valid ? '写盘并回读 settings' : '间隔 30–3600 秒，类目不能为空', onClick: () => save.run('settings', 'settings.put', { patch }, { hint: '再点一次「确认保存」', busy: '正在保存…', done: () => '设置已保存', after: refresh }), style: valid && !save.state.busy ? S.primary : S.offButton }, save.state.armed === 'settings' ? '确认保存' : save.state.busy ? '保存中…' : '保存设置')),
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
    /** daemon 实时状态 + 进程管理；发布页把设置摘要换成可保存的输入。 */
    function DaemonStatus({ connection, snapshot, editable }) {
      const actions = useDaemonAction(connection)
      const online = snapshot.phase === 'ok' && snapshot.data !== null
      const action = actions.state
      const manage = h('div', { style: S.section, 'data-role': 'daemon-manage' },
        h('div', { style: S.sectionTitle }, '进程管理'),
        h('div', { style: S.buttonRow },
          h('button', { type: 'button', 'data-role': 'daemon-start', disabled: online || action.busy !== '', title: online ? 'daemon 已在线' : '让宿主拉起本地 daemon', onClick: actions.start, style: !online && action.busy === '' ? S.primary : S.offButton }, action.busy === 'daemon.start' ? '正在启动…' : '启动 daemon'),
          h('button', { type: 'button', 'data-role': 'daemon-stop', disabled: !online || action.busy !== '', title: online ? '停止 daemon（会中断在飞任务）' : 'daemon 未运行', onClick: actions.stop, style: online && action.busy === '' ? S.primary : S.offButton }, action.stopArmed ? '确认停止 daemon' : action.busy === 'daemon.stop' ? '正在停止…' : '停止 daemon')),
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
      if (review > 0) lines.push({ kind: 'warn', text: '待审 ' + String(review) + ' 条：人工确认后重试（rpc 还没暴露 ack/fail/release，先用 xy_task_action）' })
      for (const account of accounts) {
        const id = String(account !== null && typeof account === 'object' ? account.accountId ?? '' : '')
        if (id !== '' && account.ready !== true) lines.push({ kind: 'warn', text: '账号 ' + id + ' 凭据不完整：去「账号」tab 重新导入或扫码' })
      }
      // 熔断是 daemon 侧自动冷却的（circuits.json），面板只报状态：重置端点还没进 rpc，不去猜。
      for (const [accountId, reason] of Object.entries(circuits)) {
        lines.push({ kind: 'bad', text: '账号 ' + accountId + ' 熔断中（' + String(reason) + '）：等冷却自动放行，手动重置待 rpc 补 circuits.reset' })
      }
      if (lines.length === 0) return [h('div', { key: 'clear', style: S.goodText, 'data-role': 'overview-clear' }, '没有待办：队列、账号、熔断都正常')]
      return lines.map((line, index) => h('div', { key: String(index), style: line.kind === 'bad' ? S.badText : S.warnText, 'data-role': 'overview-alert' }, '· ' + line.text))
    }
    /** 概览页 = 驾驶舱（概况 + 待办 + 工作流）+ 系统区（进程管理 / 设置 / 命令）。默认落地页。 */
    function OverviewTab({ connection }) {
      const snapshot = useDaemonSnapshot(connection)
      return h('div', null,
        h(DaemonStatus, { connection, snapshot, editable: true }),
        h('div', { style: S.section, 'data-role': 'overview-todo' },
          h('div', { style: S.sectionTitle }, '待办提醒'),
          ...alertLines(snapshot)),
        h(WorkflowTree, { connection }),
        h('div', { style: S.section, 'data-role': 'overview-commands' },
          h('div', { style: S.sectionTitle }, '工具与命令'),
          h('div', { style: S.cmdRow }, ...OVERVIEW_TOOL_NAMES.map(name => h('code', { key: name, style: S.cmdCode }, name))),
          h('div', { style: S.cmdRow }, ...OVERVIEW_COMMANDS.map(command => h('code', { key: command, style: S.cmdCode }, command))),
          h('div', { style: S.sectionHint }, '面板只走 rpc（/bigfish），不直连 daemon；daemon 默认监听 ' + DAEMON_ADDR)))
    }

