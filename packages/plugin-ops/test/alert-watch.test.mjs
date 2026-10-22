import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeClient } from './helpers.mjs'
import {
  ALERT_PAGE_LIMIT,
  MAX_PRIME_PAGES,
  createAlertState,
  pollAlerts,
  primeAlertCursor,
  pushPending,
  resolveRootAgent,
  startAlertWatcher,
} from '../src/alert-watch.js'

/** 假定时器：记录 arm 出去的定时器，可手动触发一次。 */
function createFakeTimers() {
  const queue = []
  return {
    queue,
    setTimeout(fn, ms) {
      const entry = { fn, ms, cleared: false }
      queue.push(entry)
      return { unref() {}, clear: () => { entry.cleared = true } }
    },
    clearTimeout(handle) {
      if (typeof handle?.clear === 'function') handle.clear()
    },
    pending() {
      return queue.filter((entry) => !entry.cleared)
    },
    async runNext() {
      const entry = queue.find((item) => !item.cleared)
      if (entry === undefined) return false
      entry.cleared = true
      await entry.fn()
      return true
    },
  }
}

/** 等异步 tick 落地（tick 是 fire-and-forget，不能直接 await 定时器回调）。 */
async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('等待超时')
}

function createFakeAgent() {
  const calls = []
  return {
    calls,
    followup(message) {
      calls.push(message)
    },
  }
}

function failedEvent(id) {
  return { id, taskId: 'task-' + id, batchId: 'batch-1', kind: 'task.state', state: 'failed', code: 'RISK_CONTROL', message: '风控拦截' }
}

/** 首次拉取用于定基线（空页），之后每次返回给定事件（游标按条数推进）。 */
function createIncrementalClient(events) {
  let fetches = 0
  return createFakeClient({
    listEvents: async ({ since }) => {
      fetches += 1
      if (fetches <= 1) return { items: [], nextSince: since }
      const items = events()
      return { items, nextSince: since + items.length }
    },
  })
}

test('primeAlertCursor 翻页找基线，不把历史事件当新告警', async () => {
  const pages = [
    { items: Array.from({ length: ALERT_PAGE_LIMIT }, (_, index) => ({ id: index + 1 })), nextSince: ALERT_PAGE_LIMIT },
    { items: [{ id: ALERT_PAGE_LIMIT + 1 }], nextSince: ALERT_PAGE_LIMIT + 1 },
  ]
  let page = 0
  const client = createFakeClient({ listEvents: async () => pages[page++] })
  const state = createAlertState()
  await primeAlertCursor(client, state)
  assert.equal(state.cursor, ALERT_PAGE_LIMIT + 1)
  assert.equal(state.primed, true)
  assert.deepEqual(client.calls.map((call) => call.args[0].since), [0, ALERT_PAGE_LIMIT])
})

test('primeAlertCursor 最多翻 MAX_PRIME_PAGES 页（旧库不拖住启动）', async () => {
  const client = createFakeClient({
    listEvents: async ({ since }) => ({
      items: Array.from({ length: ALERT_PAGE_LIMIT }, (_, index) => ({ id: since + index + 1 })),
      nextSince: since + ALERT_PAGE_LIMIT,
    }),
  })
  const state = createAlertState()
  await primeAlertCursor(client, state)
  assert.equal(client.calls.length, MAX_PRIME_PAGES)
  assert.equal(state.cursor, MAX_PRIME_PAGES * ALERT_PAGE_LIMIT)
})

test('pushPending 超过上限丢最早的', () => {
  const state = createAlertState()
  assert.equal(pushPending(state, Array.from({ length: 21 }, (_, index) => ({ id: index }))), 1)
  assert.equal(state.pending.length, 20)
  assert.equal(state.pending[0].id, 1)
})

test('pollAlerts：没有 agent 时不轮询（不推进游标）', async () => {
  const client = createFakeClient({ listEvents: async () => ({ items: [], nextSince: 0 }) })
  const result = await pollAlerts({ client, state: createAlertState(), resolveAgent: () => undefined })
  assert.deepEqual(result, { skipped: 'no-agent' })
  assert.equal(client.calls.length, 0)
})

test('pollAlerts：首轮只定基线，历史失败不推送', async () => {
  const seen = []
  const client = createFakeClient({ listEvents: async () => ({ items: [failedEvent(3)], nextSince: 3 }) })
  const result = await pollAlerts({
    client,
    state: createAlertState(),
    resolveAgent: () => fakeAgent,
    notify: (agent, message) => { seen.push(message) },
  })
  assert.deepEqual(result, { primed: true, fetched: 0, notified: 0 })
  assert.equal(seen.length, 0)
})

const fakeAgent = createFakeAgent()

test('pollAlerts：增量失败推送一条，内容含任务/批次/建议', async () => {
  const client = createIncrementalClient(() => [failedEvent(5)])
  const state = createAlertState()
  const agent = createFakeAgent()
  const resolveAgent = () => agent
  await pollAlerts({ client, state, resolveAgent })
  const result = await pollAlerts({ client, state, resolveAgent })
  assert.deepEqual(result, { fetched: 1, notified: 1 })
  assert.equal(agent.calls.length, 1)
  const message = agent.calls[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.form, 'notice')
  assert.match(message.content[0].text, /任务 task-5/)
  assert.match(message.content[0].text, /批次 batch-1/)
  assert.match(message.content[0].text, /风控信号/)
})

test('pollAlerts：同一事件 id 不重复推送', async () => {
  const client = createIncrementalClient(() => [failedEvent(9)])
  const state = createAlertState()
  const agent = createFakeAgent()
  const resolveAgent = () => agent
  await pollAlerts({ client, state, resolveAgent })
  await pollAlerts({ client, state, resolveAgent })
  await pollAlerts({ client, state, resolveAgent })
  await pollAlerts({ client, state, resolveAgent })
  assert.equal(agent.calls.length, 1)
})

test('pollAlerts：同轮多条合并成一条消息', async () => {
  const client = createIncrementalClient(() => [failedEvent(11), { ...failedEvent(12), state: 'needs_review' }])
  const state = createAlertState()
  const agent = createFakeAgent()
  const resolveAgent = () => agent
  await pollAlerts({ client, state, resolveAgent })
  await pollAlerts({ client, state, resolveAgent })
  assert.equal(agent.calls.length, 1)
  assert.match(agent.calls[0].content[0].text, /出现 2 条异常/)
})

test('pollAlerts：推送失败（agent 消失）时事件留在 pending，恢复后补推', async () => {
  const client = createIncrementalClient(() => [failedEvent(21)])
  const state = createAlertState()
  const agent = createFakeAgent()
  let callCount = 0
  let dropFlush = true
  // 第二轮：抓取前还有 agent，推送前 agent 消失（多会话关掉了那个会话）。
  const resolveAgent = () => {
    callCount += 1
    if (dropFlush && callCount === 2) return undefined
    return agent
  }
  await pollAlerts({ client, state, resolveAgent: () => agent })
  const silent = await pollAlerts({ client, state, resolveAgent })
  assert.deepEqual(silent, { fetched: 1, notified: 0 })
  assert.equal(state.pending.length, 1)
  assert.equal(agent.calls.length, 0)
  dropFlush = false
  callCount = 0
  const flushed = await pollAlerts({ client, state, resolveAgent })
  assert.equal(flushed.notified, 1)
  assert.equal(agent.calls.length, 1)
  assert.match(agent.calls[0].content[0].text, /任务 task-21/)
})

test('resolveRootAgent：取最后创建的顶层 agent，服务缺失/异常返回 undefined', () => {
  const first = createFakeAgent()
  const second = createFakeAgent()
  assert.equal(resolveRootAgent({ get: () => ({ roots: () => [first, second] }) }), second)
  assert.equal(resolveRootAgent({ get: () => ({ roots: () => [] }) }), undefined)
  assert.equal(resolveRootAgent({ get: () => undefined }), undefined)
  assert.equal(resolveRootAgent({ get: () => ({ roots: () => { throw new Error('disposed') } }) }), undefined)
  assert.equal(resolveRootAgent(undefined), undefined)
})

test('startAlertWatcher：没有 agent 时不 arm，agent/created 后开始轮询', () => {
  const timers = createFakeTimers()
  const listeners = new Map()
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    get: () => undefined,
  }
  let agent
  const client = createFakeClient({ listEvents: async () => ({ items: [], nextSince: 0 }) })
  const watcher = startAlertWatcher({ ctx, client, timers, resolveAgent: () => agent, notify: () => {} })
  assert.equal(watcher.active(), false)
  assert.equal(timers.pending().length, 0)
  agent = createFakeAgent()
  listeners.get('agent/created')({ agent })
  assert.equal(watcher.active(), true)
  assert.equal(timers.pending().length, 1)
  assert.equal(timers.pending()[0].ms, 10_000)
  watcher.stop()
  assert.equal(watcher.active(), false)
  assert.equal(timers.pending().length, 0)
  assert.equal(listeners.size, 0)
})

test('startAlertWatcher：轮询异常只记一条 warn，恢复后继续 arm 且不重复推', async () => {
  const timers = createFakeTimers()
  const logs = []
  let fail = true
  const client = createFakeClient({
    listEvents: async () => {
      if (fail) throw new Error('connect ECONNREFUSED')
      return { items: [], nextSince: 0 }
    },
  })
  const agent = createFakeAgent()
  const watcher = startAlertWatcher({
    client,
    timers,
    resolveAgent: () => agent,
    notify: () => {},
    log: (line) => logs.push(line),
  })
  assert.equal(timers.pending().length, 1)
  await timers.runNext()
  await waitFor(() => timers.pending().length >= 1)
  await timers.runNext()
  await waitFor(() => timers.pending().length >= 1)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /异常告警轮询失败/)
  assert.match(logs[0], /ECONNREFUSED/)
  fail = false
  await watcher.pollNow()
  assert.equal(logs.length, 1)
  await waitFor(() => timers.pending().length >= 1)
  watcher.stop()
})
