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

