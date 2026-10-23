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

