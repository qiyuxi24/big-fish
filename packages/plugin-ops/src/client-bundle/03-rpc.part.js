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

