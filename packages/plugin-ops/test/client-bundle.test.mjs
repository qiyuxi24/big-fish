import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { COPY_STYLES } from '../src/copy.js'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/**
 * 假 React：createElement 只保留 type / props / children，够做结构断言。
 * useState **按组件身份分槽**（真实 React 里每个组件各有 hook 链表）：面板里嵌了
 * 发布/账号等多个子组件，全局扁平槽位会让它们的 state 互相覆盖。
 * 遍历函数组件时用 __enter/__exit 切换「当前组件」，游标在每次进入时归零。
 */
function createFakeReact() {
  const stores = new Map()
  const state = { current: null }
  const storeOf = (type) => {
    if (!stores.has(type)) stores.set(type, { slots: [], index: 0, effects: [], effectIndex: 0 })
    return stores.get(type)
  }
  const sameDeps = (left, right) => left !== undefined && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]))
  return {
    __enter(type) {
      const previous = state.current
      state.current = type
      const store = storeOf(type)
      store.index = 0
      store.effectIndex = 0
      return previous
    },
    __exit(previous) {
      state.current = previous
    },
    /** 跑一轮挂起的 effect：React 在提交后执行，这里由测试显式触发（只跑 deps 变过的）。 */
    __flush() {
      for (const store of stores.values()) {
        for (const effect of store.effects) {
          if (!effect.dirty) continue
          effect.dirty = false
          if (effect.active && typeof effect.cleanup === 'function') effect.cleanup()
          const cleanup = effect.fn()
          effect.cleanup = typeof cleanup === 'function' ? cleanup : null
          effect.active = true
        }
      }
    },
    /** 卸载全部组件：执行 cleanup（对应 React 卸载时清定时器）。 */
    __unmount() {
      for (const store of stores.values()) {
        for (const effect of store.effects) {
          if (effect.active && typeof effect.cleanup === 'function') effect.cleanup()
          effect.active = false
          effect.dirty = true
        }
      }
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      if (state.current === null) throw new Error('useState 必须在组件内调用')
      const store = storeOf(state.current)
      const index = store.index
      store.index += 1
      if (!(index in store.slots)) store.slots[index] = initial
      const set = (value) => {
        store.slots[index] = typeof value === 'function' ? value(store.slots[index]) : value
      }
      return [store.slots[index], set]
    },
    useEffect(fn, deps) {
      if (state.current === null) throw new Error('useEffect 必须在组件内调用')
      const store = storeOf(state.current)
      const index = store.effectIndex
      store.effectIndex += 1
      const previous = store.effects[index]
      if (previous === undefined) {
        store.effects[index] = { fn, deps, cleanup: null, active: false, dirty: true }
        return
      }
      previous.fn = fn
      if (!sameDeps(previous.deps, deps)) {
        previous.deps = deps
        previous.dirty = true
      }
    },
  }
}

/** 当前 bundle 的假 React（遍历函数组件时用它切 hook 归属）。 */
let activeReact = null

/** 在 vm 沙箱里执行 client bundle，返回捕获到的 loader 注册与可复用 require。 */
function loadBundle() {
  const registrations = []
  const requested = []
  const timers = new Map()
  let seq = 0
  // 假时钟：client 侧只用 setInterval/clearInterval（3 秒轮询），由测试手动推进。
  const clock = {
    setInterval(fn, ms) {
      seq += 1
      timers.set(seq, { fn, ms })
      return seq
    },
    clearInterval(id) {
      timers.delete(id)
    },
    get size() {
      return timers.size
    },
    get period() {
      const first = [...timers.values()][0]
      return first === undefined ? null : first.ms
    },
    advance() {
      for (const timer of [...timers.values()]) timer.fn()
    },
  }
  let react
  const require = (id) => {
    requested.push(id)
    if (id !== 'react') throw new Error('client bundle 只允许 require react，实际请求了 ' + id)
    if (react === undefined) {
      react = createFakeReact()
      activeReact = react
    }
    return react
  }
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  vm.runInNewContext(source, {
    window,
    console,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  }, { filename: bundlePath })
  return { registrations, require, requested, clock, get react() { return react } }
}

/** 排空微任务：rpc 的 Promise 链在下一轮微任务里落定，不依赖真实定时器。 */
async function settle() {
  for (let index = 0; index < 50; index += 1) await Promise.resolve()
}

/** 调用一个函数组件：把 hook 归属切到该组件，离开时还原。 */
function callComponent(node) {
  const previous = activeReact.__enter(node.type)
  try {
    return node.type(node.props)
  } finally {
    activeReact.__exit(previous)
  }
}

/** 把假 React 元素树拍平成文本，便于断言面板文案。 */
function toText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toText).join('')
  // 函数组件在 React 里由宿主调用；这里手动渲染以取文本。
  if (typeof node.type === 'function') return toText(callComponent(node))
  return toText(node.children ?? [])
}

/** 收集指定类型的元素（按钮、输入框等），用于结构断言。 */
function collectByType(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  if (typeof node.type === 'function') collectByType(callComponent(node), type, out)
  else collectByType(node.children ?? [], type, out)
  return out
}

/** 假 ctx：inject 立即执行回调，register 记录定义与组件；connection 由用例注入。 */
function createFakeCtx(connection) {
  const registered = []
  const injected = []
  return {
    registered,
    injected,
    ctx: {
      connection,
      slots: {
        inject(slotName, callback) {
          injected.push(slotName)
          callback()
        },
        register(definition, component) {
          registered.push({ definition, component })
          return () => {}
        },
      },
    },
  }
}

/**
 * 装好插件并返回面板渲染器。
 * render() 每次重置 hook 游标，模拟 React 的一次重渲染（状态槽保留）。
 */
function mountPanel(options = {}) {
  const loaded = loadBundle()
  const exports = loaded.registrations[0].factory(loaded.require)
  const { ctx, registered } = createFakeCtx(options.connection)
  exports.apply(ctx)
  const Panel = registered[1].component
  /** 渲染一次面板（组件游标归零 = React 的一次重渲染，状态槽保留）。 */
  const render = () => {
    const previous = loaded.react.__enter(Panel)
    try {
      return Panel()
    } finally {
      loaded.react.__exit(previous)
    }
  }
  /** 点面板内某个 tab（按可见文字），返回切换后的树。 */
  const openTab = (label) => {
    const tab = roleElements(render(), 'panel-tab').find((node) => toText(node) === label)
    if (tab === undefined) throw new Error('面板里找不到 tab：' + label)
    tab.props.onClick()
    return render()
  }
  const flush = () => loaded.react.__flush()
  const unmount = () => loaded.react.__unmount()
  return { loaded, Panel, render, openTab, flush, unmount }
}

/** 渲染 → 走到子组件 → 跑 effect → 等 rpc 落定 → 再渲染取文本。 */
async function snapshotText(mounted, tree) {
  toText(tree ?? mounted.render())
  mounted.flush()
  await settle()
  return toText(mounted.render())
}

/** 假 connection：记录每次 rpc 调用；按 endpoint 取回放数据（值或函数）。 */
function createFakeConnection(replies) {
  const calls = []
  const connection = {
    rpc: {
      call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        const reply = replies[endpoint]
        if (reply === undefined) return Promise.resolve({ ok: false, error: { code: 'UNSUPPORTED', message: 'no fixture: ' + endpoint } })
        return Promise.resolve(typeof reply === 'function' ? reply(payload) : reply)
      },
    },
  }
  return { connection, calls }
}

/** daemon 在线时 6 个只读端点的回放数据（形状对齐 src/rpc.js）。 */
function daemonReplies() {
  return {
    health: { ok: true, value: { version: '0.3.0', uptimeMs: 125000, pid: 4242 } },
    status: {
      ok: true,
      value: {
        version: '0.3.0', uptimeMs: 125000, pid: 4242,
        queue: { queued: 2, leased: 1, done: 5, failed: 0, needs_review: 1 },
        accounts: ['2206569289277'], circuits: {},
      },
    },
    accounts: { ok: true, value: [{ accountId: '2206569289277', updatedAt: 1, savedFieldCount: 3, ready: true }] },
    'settings.get': {
      ok: true,
      value: { copyStyle: 'warm', defaultCategory: '电子资料', publishMinIntervalMs: 180000 },
    },
    'tasks.list': {
      ok: true,
      value: [
        { id: 't-1', kind: 'publish', dedupeKey: 'k1', payload: {}, state: 'queued', attempts: 0, maxAttempts: 3, availableAt: 0, createdAt: 100, updatedAt: 100, batchId: 'batch-old' },
        { id: 't-2', kind: 'publish', dedupeKey: 'k2', payload: {}, state: 'done', attempts: 1, maxAttempts: 3, availableAt: 0, createdAt: 200, updatedAt: 200, batchId: 'batch-new' },
      ],
    },
    'batches.get': () => ({ ok: true, value: { batchId: 'batch-new', total: 4, counts: { queued: 1, done: 3, failed: 0 } } }),
    // 步骤事件流：一个任务、三步（开始/完成/失败），发布步骤的中文文案就是 daemon 的 step 名。
    'events.list': {
      ok: true,
      value: {
        items: [
          { id: 1, at: 10, taskId: 'task-a', batchId: 'batch-new', kind: 'task.state', state: 'leased' },
          { id: 2, at: 11, taskId: 'task-a', batchId: 'batch-new', kind: 'task.step', step: '填标题', message: '开始', state: 'started' },
          { id: 3, at: 12, taskId: 'task-a', batchId: 'batch-new', kind: 'task.step', step: '填标题', message: '完成', state: 'done' },
          { id: 4, at: 13, taskId: 'task-a', batchId: 'batch-new', kind: 'task.step', step: '选类目', message: '失败：类目不支持', state: 'failed' },
        ],
        nextSince: 4,
      },
    },
  }
}

function roleElements(tree, role) {
  return collectByType(tree, 'button').filter((node) => node.props['data-role'] === role)
}

test('client bundle 只有一个 loader 注册，且 id 与包名一致', () => {
  const { registrations } = loadBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, '@bigfish/plugin-ops')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('factory 懒执行：模块体只登记 factory，不提前 require react', () => {
  const { registrations, require, requested } = loadBundle()
  assert.equal(requested.length, 0)
  const exports = registrations[0].factory(require)
  assert.equal(requested.length, 1)
  assert.equal(requested[0], 'react')
  assert.equal(typeof exports.apply, 'function')
  // 数组来自 vm 沙箱，跨 realm 不能 deepStrictEqual，按槽位断言。
  assert.equal(exports.inject.length, 2)
  assert.equal(exports.inject[0], 'slots')
  assert.equal(exports.inject[1], 'connection')
})

test('apply 只注册侧边栏栏位与主面板，不注册会话顶部 tab', () => {
  const { registrations, require } = loadBundle()
  const exports = registrations[0].factory(require)
  const { ctx, registered, injected } = createFakeCtx()
  exports.apply(ctx)

  // 模块 tab 全部在面板内切换（用户 2026-10-21 纠正：主页面在侧边栏面板里，不要塞会话顶部）。
  assert.deepEqual(injected, ['sidebar.panellist', 'main'])
  assert.equal(registered.length, 2)
  assert.equal(registered.some((entry) => entry.definition.name === 'conversation.view'), false)
  const [panelRow, mainPanel] = registered
  // 注意：对象是在 vm 沙箱里造的，原型不同，不能用 deepStrictEqual 直接比整个对象。
  assert.equal(panelRow.definition.name, 'sidebar.panellist')
  assert.equal(panelRow.definition.id, 'bigfish')
  assert.equal(panelRow.definition.order, 30)
  assert.equal(panelRow.definition.label, 'BigFish 闲鱼运营')
  assert.equal(mainPanel.definition.name, 'main')
  assert.equal(mainPanel.definition.key, 'bigfish')
  assert.equal(typeof panelRow.component, 'function')
  assert.equal(typeof mainPanel.component, 'function')
})

/** 按 data-role 收集元素（任意标签，函数组件会展开后继续找）。 */
function roleNodes(node, role, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) roleNodes(child, role, out)
    return out
  }
  if (node.props !== undefined && node.props['data-role'] === role) out.push(node)
  if (typeof node.type === 'function') roleNodes(callComponent(node), role, out)
  else roleNodes(node.children ?? [], role, out)
  return out
}

/** 切到「账号」tab，等首轮自动检测落定；返回渲染器与 rpc 调用记录。 */
async function openAccountTab(replies) {
  const { connection, calls } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  mounted.openTab('账号')
  const text = await snapshotText(mounted)
  return { mounted, calls, text, tree: () => mounted.render() }
}

test('账号表：进入 tab 自动检测一次，在线徽标「在线」，账号/字段数/更新时间齐全', async () => {
  const replies = daemonReplies()
  replies['accounts.verify'] = (payload) => ({ ok: true, value: { accountId: payload.accountId, online: true, checkedAt: Date.now(), refreshed: false } })
  const { calls, text, tree } = await openAccountTab(replies)

  assert.equal(roleNodes(tree(), 'account-table').length, 1)
  const rows = roleNodes(tree(), 'account-row')
  assert.equal(rows.length, 1)
  assert.match(toText(rows[0]), /2206569289277/)
  assert.equal(toText(roleNodes(tree(), 'account-status')[0]), '在线')
  assert.match(toText(roleNodes(tree(), 'account-checked')[0]), /^[0-9]{2}:[0-9]{2}:[0-9]{2}（自动）$/)
  assert.match(toText(roleNodes(tree(), 'account-updated')[0]), /天前 · 字段齐备/)
  assert.match(toText(roleNodes(tree(), 'account-fields')[0]), /3 项/)
  // 7 列齐全：当前 / 账号 / 登录状态 / 登录态剩余 / 最近检测 / 凭据更新 / 操作。
  assert.equal(roleNodes(tree(), 'account-lifetime').length, 1)
  assert.equal(toText(roleNodes(tree(), 'account-lifetime')[0]), '—')
  for (const role of ['account-verify', 'account-import', 'account-login', 'account-logout', 'account-switch']) {
    assert.equal(roleElements(tree(), role).length, 1, '缺少按钮：' + role)
  }

  const verifies = calls.filter((call) => call.endpoint === 'accounts.verify')
  assert.equal(verifies.length, 1)
  assert.equal(verifies[0].channel, '/bigfish')
  assert.equal(verifies[0].payload.accountId, '2206569289277')
  // 面板不读凭据：不出现 cookie 值。
  assert.equal(/cookie=|unb=[0-9]|_m_h5_tk=/i.test(text), false)
})

test('账号表：在线与过期分列，AUTH_EXPIRED 只把该行标成「已过期」，不整页降级', async () => {
  const replies = daemonReplies()
  replies.accounts = { ok: true, value: [
    { accountId: 'acc-online', updatedAt: Date.now(), savedFieldCount: 3, ready: true },
    { accountId: 'acc-expired', updatedAt: Date.now() - 120000, savedFieldCount: 0, ready: false },
  ] }
  replies['accounts.verify'] = (payload) => payload.accountId === 'acc-online'
    ? { ok: true, value: { online: true, checkedAt: Date.now() } }
    : { ok: true, value: { online: false, code: 'AUTH_EXPIRED', checkedAt: Date.now() } }
  const { text, tree } = await openAccountTab(replies)

  assert.deepEqual(roleNodes(tree(), 'account-status').map((node) => toText(node)), ['在线', '已过期'])
  assert.match(toText(roleNodes(tree(), 'account-updated')[1]), /分钟前 · 字段不齐/)
  assert.equal(roleNodes(tree(), 'account-row').length, 2)
  assert.equal(roleNodes(tree(), 'account-offline').length, 0)
  assert.equal(text.includes('连不上 daemon'), false)
})

test('账号表：verify 回 NETWORK 显示「无法确认」，不会变成「已过期」', async () => {
  const replies = daemonReplies()
  replies['accounts.verify'] = { ok: true, value: { online: false, code: 'NETWORK', checkedAt: Date.now(), message: 'timeout' } }
  const { text, tree } = await openAccountTab(replies)
  assert.equal(toText(roleNodes(tree(), 'account-status')[0]), '无法确认 · 网络异常')
  assert.equal(text.includes('已过期'), false)
  assert.equal(roleNodes(tree(), 'account-offline').length, 0)
})

test('账号表：verify 请求本身失败只影响该行徽标', async () => {
  const replies = daemonReplies()
  replies['accounts.verify'] = { ok: false, error: { code: 'INTERNAL', message: 'boom' } }
  const { text, tree } = await openAccountTab(replies)
  assert.equal(toText(roleNodes(tree(), 'account-status')[0]), '无法确认 · 后台错误')
  assert.equal(text.includes('连不上 daemon'), false)
})

test('账号表：点「检测」强制重打 accounts.verify', async () => {
  const replies = daemonReplies()
  replies['accounts.verify'] = (payload) => ({ ok: true, value: { accountId: payload.accountId, online: true, checkedAt: Date.now(), refreshed: true } })
  const { calls, tree } = await openAccountTab(replies)
  const count = () => calls.filter((call) => call.endpoint === 'accounts.verify').length
  assert.equal(count(), 1)

  roleElements(tree(), 'account-verify')[0].props.onClick()
  assert.equal(roleElements(tree(), 'account-verify')[0].props.disabled, true)
  await settle()
  assert.equal(count(), 2)
  assert.equal(toText(roleNodes(tree(), 'account-status')[0]), '在线')
})

test('账号表：重新导入要点两次，第二次才带 confirm:true 发 accounts.import', async () => {
  const replies = daemonReplies()
  replies['accounts.verify'] = { ok: true, value: { online: true, checkedAt: Date.now() } }
  replies['accounts.import'] = (payload) => ({ ok: true, value: { accountId: payload.accountId } })
  const { calls, tree } = await openAccountTab(replies)
  const imports = () => calls.filter((call) => call.endpoint === 'accounts.import')

  roleElements(tree(), 'account-import')[0].props.onClick()
  assert.equal(imports().length, 0)
  assert.match(toText(tree()), /确认导入/)
  assert.match(toText(tree()), /再点一次「确认导入」/)

  roleElements(tree(), 'account-import')[0].props.onClick()
  await settle()
  assert.equal(imports().length, 1)
  assert.equal(imports()[0].channel, '/bigfish')
  assert.equal(imports()[0].payload.confirm, true)
  assert.equal(imports()[0].payload.accountId, '2206569289277')
  assert.match(toText(tree()), /登录态已导入/)
})

test('账号表：扫码登录也要点两次，第二次带 confirm:true 发 accounts.login', async () => {
  const replies = daemonReplies()
  replies['accounts.verify'] = { ok: true, value: { online: true, checkedAt: Date.now() } }
  replies['accounts.login'] = (payload) => ({ ok: true, value: { accountId: payload.accountId } })
  const { calls, tree } = await openAccountTab(replies)
  const logins = () => calls.filter((call) => call.endpoint === 'accounts.login')

  roleElements(tree(), 'account-login')[0].props.onClick()
  assert.equal(logins().length, 0)
  assert.match(toText(tree()), /确认扫码/)
  roleElements(tree(), 'account-login')[0].props.onClick()
  assert.match(toText(tree()), /等待扫码…（最长 180s）/)
  await settle()
  assert.equal(logins().length, 1)
  assert.equal(logins()[0].payload.confirm, true)
  assert.equal(logins()[0].payload.accountId, '2206569289277')
  assert.match(toText(tree()), /扫码登录成功/)
})

test('账号表：空列表显示「还没有导入账号」+ 顶部添加账户入口', async () => {
  const replies = daemonReplies()
  replies.accounts = { ok: true, value: [] }
  const { calls, text, tree } = await openAccountTab(replies)

  assert.match(text, /还没有导入账号/)
  assert.equal(roleNodes(tree(), 'account-empty').length, 1)
  assert.equal(roleElements(tree(), 'account-import').length, 0)
  assert.equal(roleElements(tree(), 'account-login').length, 0)
  assert.equal(roleElements(tree(), 'account-add-import').length, 1)
  assert.equal(roleElements(tree(), 'account-add-login').length, 1)
  assert.equal(calls.filter((call) => call.endpoint === 'accounts.verify').length, 0)
})

test('账号表：来回切 tab 不重复自动检测（10 分钟缓存）', async () => {
  const replies = daemonReplies()
  replies['accounts.verify'] = { ok: true, value: { online: true, checkedAt: Date.now() } }
  const { mounted, calls } = await openAccountTab(replies)
  const count = () => calls.filter((call) => call.endpoint === 'accounts.verify').length
  assert.equal(count(), 1)

  mounted.openTab('概览')
  mounted.flush()
  await settle()
  mounted.openTab('账号')
  mounted.flush()
  await settle()
  assert.equal(count(), 1)
})

test('账号表：多账号点「切换」调 accounts.activate（本地状态，不需 confirm），当前徽标跟着换', async () => {
  const replies = daemonReplies()
  let accountsList = [
    { accountId: 'acc-1', updatedAt: Date.now(), savedFieldCount: 3, ready: true, active: true },
    { accountId: 'acc-2', updatedAt: Date.now(), savedFieldCount: 3, ready: true, active: false },
  ]
  replies.accounts = () => ({ ok: true, value: accountsList })
  replies['accounts.verify'] = (payload) => ({ ok: true, value: { accountId: payload.accountId, online: true, checkedAt: Date.now() } })
  replies['accounts.activate'] = (payload) => {
    if (payload.accountId !== 'acc-2') return { ok: false, error: { code: 'VALIDATION', message: '账号不存在' } }
    accountsList = accountsList.map((account) => ({ ...account, active: account.accountId === 'acc-2' }))
    return { ok: true, value: { activeAccountId: 'acc-2' } }
  }
  const { calls, tree } = await openAccountTab(replies)

  const switches = roleElements(tree(), 'account-switch')
  assert.equal(switches.length, 2)
  assert.equal(toText(roleNodes(tree(), 'account-active')[0]), '当前')
  switches[1].props.onClick()
  await settle()

  const activates = calls.filter((call) => call.endpoint === 'accounts.activate')
  assert.equal(activates.length, 1)
  assert.equal(activates[0].payload.accountId, 'acc-2')
  // activate 只改本地设置，不能带 confirm（它不是 WRITE_ENDPOINTS）。
  assert.equal('confirm' in activates[0].payload, false)
  assert.match(toText(tree()), /已切换到 acc-2/)
  const rows = roleNodes(tree(), 'account-row')
  assert.equal(toText(rows[1]).includes('当前'), true)
  assert.equal(toText(rows[0]).includes('当前'), false)
  assert.equal(toText(roleNodes(tree(), 'account-status')[0]), '在线')
})

test('账号表：登录态剩余倒计时（estimated 加「（估算）」、过期显示「已过期」、缺失显示「—」）', async () => {
  const replies = daemonReplies()
  const lifetime = Date.now() + 2 * 3600_000 + 13 * 60_000 + 30_000
  replies.accounts = { ok: true, value: [
    { accountId: 'acc-browser', updatedAt: Date.now(), savedFieldCount: 3, ready: true, loginExpiresAt: lifetime, loginExpiresSource: 'browser' },
    { accountId: 'acc-est', updatedAt: Date.now(), savedFieldCount: 3, ready: true, loginExpiresAt: lifetime, loginExpiresSource: 'estimated' },
    { accountId: 'acc-old', updatedAt: Date.now(), savedFieldCount: 3, ready: true, loginExpiresAt: Date.now() - 60_000 },
    { accountId: 'acc-unknown', updatedAt: Date.now(), savedFieldCount: 3, ready: true },
  ] }
  replies['accounts.verify'] = (payload) => ({ ok: true, value: { accountId: payload.accountId, online: true, checkedAt: Date.now() } })
  const { tree } = await openAccountTab(replies)
  const lifetimes = roleNodes(tree(), 'account-lifetime').map((node) => toText(node))
  assert.equal(lifetimes[0], '2 小时 13 分')
  assert.equal(lifetimes[1], '2 小时 13 分（估算）')
  assert.equal(lifetimes[2], '已过期')
  assert.equal(lifetimes[3], '—')
})

test('账号表：退出登录点两次才发 accounts.logout（confirm:true），第一次只提示不删凭据', async () => {
  const replies = daemonReplies()
  replies['accounts.verify'] = { ok: true, value: { online: true, checkedAt: Date.now() } }
  replies['accounts.logout'] = (payload) => ({ ok: true, value: { accountId: payload.accountId, activeAccountId: '' } })
  const { calls, tree } = await openAccountTab(replies)
  const logouts = () => calls.filter((call) => call.endpoint === 'accounts.logout')

  roleElements(tree(), 'account-logout')[0].props.onClick()
  assert.equal(logouts().length, 0)
  assert.match(toText(tree()), /确认退出登录/)
  assert.match(toText(tree()), /只删本地凭据/)

  roleElements(tree(), 'account-logout')[0].props.onClick()
  await settle()
  assert.equal(logouts().length, 1)
  assert.equal(logouts()[0].payload.accountId, '2206569289277')
  assert.equal(logouts()[0].payload.confirm, true)
  assert.match(toText(tree()), /已退出 2206569289277/)
})

test('添加账户：输入账号 id 与 Chrome 端口，点两次才带 confirm:true 发 accounts.import', async () => {
  const replies = daemonReplies()
  replies['accounts.import'] = (payload) => ({ ok: true, value: { accountId: payload.accountId } })
  const { calls, tree } = await openAccountTab(replies)
  const imports = () => calls.filter((call) => call.endpoint === 'accounts.import')

  roleNodes(tree(), 'account-add-id')[0].props.onChange({ target: { value: 'acc-new' } })
  roleNodes(tree(), 'account-add-port')[0].props.onChange({ target: { value: '9333' } })
  roleElements(tree(), 'account-add-import')[0].props.onClick()
  assert.equal(imports().length, 0)
  assert.match(toText(tree()), /确认导入/)
  roleElements(tree(), 'account-add-import')[0].props.onClick()
  await settle()
  assert.equal(imports().length, 1)
  assert.equal(imports()[0].payload.confirm, true)
  assert.equal(imports()[0].payload.port, 9333)
  assert.equal(imports()[0].payload.accountId, 'acc-new')
  assert.match(toText(tree()), /登录态已导入/)

  // 非法端口在面板侧就拦下，不发请求。
  roleNodes(tree(), 'account-add-port')[0].props.onChange({ target: { value: '70000' } })
  roleElements(tree(), 'account-add-import')[0].props.onClick()
  await settle()
  assert.equal(imports().length, 1)
  assert.match(toText(tree()), /端口必须是 1..65535 的整数/)
})

test('登录保活：settings.get 回填，保存点两次、秒换算毫秒并带 confirm:true，保存后重新拉设置', async () => {
  const replies = daemonReplies()
  let settings = { copyStyle: 'warm', defaultCategory: '电子资料', publishMinIntervalMs: 180000, keepAliveEnabled: true, keepAliveIntervalMs: 600000 }
  replies['settings.get'] = () => ({ ok: true, value: settings })
  replies['accounts.verify'] = { ok: true, value: { online: true, checkedAt: Date.now() } }
  replies['settings.put'] = (payload) => { settings = { ...settings, ...payload.patch }; return { ok: true, value: settings } }
  const { calls, tree } = await openAccountTab(replies)
  const saves = () => calls.filter((call) => call.endpoint === 'settings.put')
  const settingsReads = () => calls.filter((call) => call.endpoint === 'settings.get').length
  const before = settingsReads()

  assert.equal(roleNodes(tree(), 'keepalive-toggle')[0].props.checked, true)
  assert.equal(roleNodes(tree(), 'keepalive-interval')[0].props.value, '600')
  roleNodes(tree(), 'keepalive-interval')[0].props.onChange({ target: { value: '900' } })
  roleElements(tree(), 'keepalive-save')[0].props.onClick()
  assert.equal(saves().length, 0)
  assert.match(toText(tree()), /确认保存/)
  roleElements(tree(), 'keepalive-save')[0].props.onClick()
  await settle()

  assert.equal(saves().length, 1)
  assert.equal(saves()[0].payload.confirm, true)
  assert.equal(saves()[0].payload.patch.keepAliveEnabled, true)
  assert.equal(saves()[0].payload.patch.keepAliveIntervalMs, 900000)
  assert.match(toText(tree()), /保活设置已保存/)
  // 保存成功后必须重新拉一次 settings.get 回填，而不是复用旧值。
  assert.equal(settingsReads(), before + 1)
})

test('侧边栏图标渲染 🐟，选中态与未选中态透明度不同', () => {
  const { registrations, require } = loadBundle()
  const exports = registrations[0].factory(require)
  const { ctx, registered } = createFakeCtx()
  exports.apply(ctx)
  const Icon = registered[0].component

  const active = Icon({ size: 16, active: true })
  const idle = Icon({ size: 16, active: false })
  assert.equal(toText(active), '🐟')
  assert.equal(active.props.style.opacity, 1)
  assert.equal(idle.props.style.opacity, 0.72)
  assert.equal(active.props.style.fontSize, '16px')
  assert.equal(Icon({ size: 4 }).props.style.fontSize, '12px')
  assert.equal(active.props['aria-hidden'], 'true')
})

test('面板内 tab：6 个分区，默认「自动发布」，点击切换内容', () => {
  const { render, openTab } = mountPanel()
  let tree = render()
  const tabs = roleElements(tree, 'panel-tab')
  assert.deepEqual(tabs.map((node) => toText(node)), ['自动发布', '账号', '文案', '采集', '概览', '诊断'])
  assert.deepEqual(tabs.map((node) => node.props['aria-selected']), [true, false, false, false, false, false])
  // 默认页是发布模块（流水线 + 草稿集）；文案与诊断内容此时不应出现。
  assert.match(toText(tree), /流水线/)
  assert.match(toText(tree), /草稿集/)
  assert.equal(toText(tree).includes('文案风格（skill 注入）'), false)
  assert.equal(toText(tree).includes('127.0.0.1:47001'), false)

  tree = openTab('账号')
  assert.match(toText(tree), /账号管理/)
  assert.equal(roleElements(tree, 'panel-tab')[1].props['aria-selected'], true)
  assert.equal(roleElements(tree, 'panel-tab')[0].props['aria-selected'], false)

  tree = openTab('文案')
  assert.match(toText(tree), /文案风格（skill 注入）/)

  tree = openTab('概览')
  const overview = toText(tree)
  assert.match(overview, /登录态导入/)
  assert.match(overview, /127.0.0.1:47001/)
  assert.match(overview, /npm run daemon:import-account/)

  tree = openTab('诊断')
  assert.match(toText(tree), /xy_status/)
  assert.match(toText(tree), /xy_tasks_list/)
  assert.match(toText(tree), /npm run dsh:dev -- --fresh/)
})

test('面板标题与副标题在任意 tab 都在（tab 栏顶部固定）', () => {
  const { render, openTab } = mountPanel()
  const text = toText(render())
  for (const expected of ['BigFish 闲鱼运营', '发布 / 账号 / 文案 / 采集 · 面板只组参数', '自动发布', '账号', '文案', '采集', '概览', '诊断']) {
    assert.ok(text.includes(expected), '面板文本缺少：' + expected)
  }
  // 切到任意 tab，标题与 tab 栏都在。
  const account = toText(openTab('账号'))
  assert.ok(account.includes('BigFish 闲鱼运营'))
  assert.ok(account.includes('自动发布'))
})

test('概览页只留导入入口与 daemon 命令，不再有 disabled 假按钮', () => {
  const { openTab } = mountPanel()
  const tree = openTab('概览')
  assert.match(toText(tree), /npm run daemon:import-account/)
  assert.equal(collectByType(tree, 'button').filter((node) => node.props.disabled === true).length, 0)
})

test('文案风格区：5 个风格可选，默认闲鱼口语，切换后选中态转移', () => {
  const { render, openTab } = mountPanel()
  openTab('文案')
  const before = roleElements(render(), 'copy-style')
  assert.equal(before.length, 5)
  assert.deepEqual(before.map((node) => toText(node)), COPY_STYLES.map((style) => style.label))
  assert.deepEqual(before.map((node) => node.props['aria-pressed']), [true, false, false, false, false])
  assert.match(toText(render()), /闲鱼口语：短句直给/)

  before[1].props.onClick()
  const after = roleElements(render(), 'copy-style')
  assert.deepEqual(after.map((node) => node.props['aria-pressed']), [false, true, false, false, false])
  assert.match(toText(render()), /亲切安利：带使用感受/)
})

test('填完商品名与价格后才能生成；生成的是 xy_copy_plan 参数，不调模型', () => {
  const { render, openTab } = mountPanel()
  openTab('文案')
  let tree = render()
  const submitButton = () => roleElements(tree, 'copy-submit')[0]

  assert.equal(submitButton().props.disabled, true)
  assert.match(submitButton().props.title, /先填商品名与价格/)

  const inputs = collectByType(tree, 'input')
  assert.equal(inputs.length, 2)
  inputs[0].props.onChange({ target: { value: '索尼 WH-1000XM4' } })
  tree = render()
  collectByType(tree, 'input')[1].props.onChange({ target: { value: '650' } })
  tree = render()

  assert.equal(submitButton().props.disabled, false)
  submitButton().props.onClick()
  tree = render()
  const text = toText(tree)
  assert.match(text, /生成请求已就绪/)
  assert.match(text, /"tool": "xy_copy_plan"/)
  assert.match(text, /"productName": "索尼 WH-1000XM4"/)
  assert.match(text, /"priceYuan": "650"/)

  // 改任一输入都撤销「已就绪」，避免用旧参数生成。
  collectByType(tree, 'input')[1].props.onChange({ target: { value: '651' } })
  assert.equal(toText(render()).includes('生成请求已就绪'), false)
})

test('面板内嵌的风格表与 src/copy.js 权威定义不漂移', () => {
  const start = source.indexOf('const COPY_STYLE_OPTIONS = [')
  const end = source.indexOf('\n    ]', start)
  assert.ok(start > 0 && end > start, 'client.js 里找不到 COPY_STYLE_OPTIONS 区块')
  const block = source.slice(start, end)
  const options = [...block.matchAll(/\{ id: '([^']+)', label: '([^']+)', summary: '([^']+)' \}/g)]
    .map((match) => ({ id: match[1], label: match[2], summary: match[3] }))

  assert.equal(options.length, COPY_STYLES.length)
  assert.deepEqual(options.map((option) => option.id), COPY_STYLES.map((style) => style.id))
  assert.deepEqual(options.map((option) => option.label), COPY_STYLES.map((style) => style.label))
  assert.deepEqual(options.map((option) => option.summary), COPY_STYLES.map((style) => style.summary))
})

/** 文案页的最小模板回放：一个品类一项规格，足够验证勾选语义与组装。 */
function copyTemplatesReply() {
  return {
    ok: true,
    value: {
      common: [
        { id: 'productName', label: '商品名', type: 'text', group: 'base', required: true, maxLength: 120 },
        { id: 'priceYuan', label: '售价（元）', type: 'text', group: 'base', required: true, maxLength: 20 },
        { id: 'condition', label: '成色', type: 'enum', group: 'base', required: true, options: [{ value: 'like-new', label: '几乎全新' }] },
        { id: 'reason', label: '出售原因', type: 'text', group: 'story', maxLength: 200 },
      ],
      categories: [
        { id: 'digital', label: '数码/手机', categoryHint: '数码/手机', specs: [{ id: 'model', label: '型号', type: 'text', group: 'specs', maxLength: 60 }] },
        { id: 'other', label: '其他', categoryHint: '', specs: [] },
      ],
    },
  }
}

test('品类模板：拉到后按品类渲染，勾选/取消决定最终参数（未勾选不出现）', async () => {
  const { connection } = createFakeConnection({ 'copy.templates': copyTemplatesReply() })
  const mounted = mountPanel({ connection })
  // 先渲染一次让 useEffect 注册，再 flush + 等微任务链落地。
  mounted.render()
  mounted.flush()
  await settle()
  let tree = mounted.openTab('文案')
  assert.deepEqual(roleElements(tree, 'copy-category').map(toText), ['数码/手机', '其他'])
  assert.equal(roleElements(tree, 'copy-category')[0].props['aria-pressed'], true)

  const checkbox = field => roleNodes(tree, 'copy-field').find(node => node.props['data-field'] === field)
  const inputOf = field => roleNodes(tree, 'copy-input').find(node => node.props['data-field'] === field)
  // 规格默认选中（选了品类就要把这些说清楚），叙事字段默认不选。
  assert.equal(checkbox('model').props.checked, true)
  assert.equal(checkbox('reason').props.checked, false)

  inputOf('productName').props.onChange({ target: { value: 'iPad Air 5' } })
  tree = mounted.render()
  inputOf('priceYuan').props.onChange({ target: { value: '2200' } })
  tree = mounted.render()
  inputOf('model').props.onChange({ target: { value: 'A2588' } })
  tree = mounted.render()
  checkbox('model').props.onChange({ target: { checked: false } })
  tree = mounted.render()
  checkbox('reason').props.onChange({ target: { checked: true } })
  tree = mounted.render()
  inputOf('reason').props.onChange({ target: { value: '换新后闲置' } })
  tree = mounted.render()

  roleElements(tree, 'copy-submit')[0].props.onClick()
  tree = mounted.render()
  const text = toText(tree)
  assert.match(text, /"reason": "换新后闲置"/)
  // 填了值但取消勾选 → 既不进 specs，也不出现该键；空规格不生成空对象。
  assert.equal(text.includes('"model"'), false)
  assert.equal(text.includes('"specs"'), false)
})

test('全选 / 清空：清空会把规格的默认选中显式取消', () => {
  const { connection } = createFakeConnection({ 'copy.templates': copyTemplatesReply() })
  const mounted = mountPanel({ connection })
  mounted.flush()
  let tree = mounted.openTab('文案')
  roleElements(tree, 'copy-pick-all')[0].props.onClick()
  tree = mounted.render()
  assert.equal(roleNodes(tree, 'copy-field').every(node => node.props.checked === true), true)

  roleElements(tree, 'copy-clear')[0].props.onClick()
  tree = mounted.render()
  assert.equal(roleNodes(tree, 'copy-field').every(node => node.props.checked === false), true)
})

test('品类模板拉不到：显式提示降级，仍能用通用字段生成；模板只拉一次', async () => {
  const { connection, calls } = createFakeConnection({})
  const mounted = mountPanel({ connection })
  mounted.render()
  mounted.flush()
  await settle()
  let tree = mounted.openTab('文案')
  assert.match(toText(tree), /品类模板没拉到/)
  assert.deepEqual(roleElements(tree, 'copy-category').map(toText), ['其他'])

  mounted.openTab('自动发布')
  tree = mounted.openTab('文案')
  assert.match(toText(tree), /品类模板没拉到/)
  assert.equal(calls.filter(call => call.endpoint === 'copy.templates').length, 1)
})

test('「自动发布」模块（默认 tab）：流水线四步、草稿集与类目矩阵都在', () => {
  const { render } = mountPanel()
  const tree = render()
  const text = toText(tree)
  for (const expected of [
    '自动发布',
    '流水线',
    '草稿集',
    '发布前校验',
    '✅ 电子资料 / 学习笔记 / 课业本；❌ 教材教辅 / 语言与兴趣培训 / 学习资料定制 / 文学 / 考研咨询（网页端不支持发布）',
  ]) {
    assert.ok(text.includes(expected), '自动发布视图缺少：' + expected)
  }
  const textarea = collectByType(tree, 'textarea')[0]
  assert.equal(textarea.props['data-role'], 'draft-input')
  assert.match(toText(tree), /price（分）/)
})

test('草稿集逐行解析：非法 JSON、缺字段、非 .json 路径都报出来', () => {
  const { render } = mountPanel()
  collectByType(render(), 'textarea')[0].props.onChange({
    target: {
      value: [
        '{"title":"笔记","price":990,"images":["D:/pics/1.jpg"]}',
        '{bad json}',
        '{"title":"缺图","price":990}',
        'D:/drafts/note.json',
        '随便一行',
      ].join('\n'),
    },
  })
  const tree = render()
  const rows = collectByType(tree, 'div').filter((node) => node.props['data-role'] === 'draft-check')
  assert.equal(rows.length, 5)
  const messages = rows.map((node) => toText(node))
  assert.match(messages[0], /格式通过/)
  assert.match(messages[1], /JSON 不合法/)
  assert.match(messages[2], /缺 images/)
  assert.match(messages[3], /路径条目（host 侧读取，面板不校验内容）/)
  assert.match(messages[4], /既不是内联 JSON 对象，也不是 \.json 路径/)
  assert.deepEqual(rows.map((node) => node.props['data-ok']), [true, false, false, true, false])
})

test('至少 2 条合法草稿才启用「生成批量发布请求」，产出 xy_publish_batch 参数', () => {
  const { render } = mountPanel()
  let tree = render()
  const submit = () => collectByType(tree, 'button').find((node) => node.props['data-role'] === 'publish-batch-submit')
  const typeDrafts = (value) => {
    collectByType(tree, 'textarea')[0].props.onChange({ target: { value } })
    tree = render()
  }

  assert.equal(submit().props.disabled, true)
  assert.match(submit().props.title, /先粘贴至少 2 条合法草稿/)

  typeDrafts('{"title":"A","price":100,"images":["D:/a.jpg"]}')
  assert.equal(submit().props.disabled, true)
  assert.match(submit().props.title, /至少 2 条合法草稿才能生成（现在 1 条）/)

  typeDrafts([
    '{"title":"A","price":100,"images":["D:/a.jpg"]}',
    '{"title":"B","price":200,"images":["D:/b.jpg"]}',
    'D:/drafts/C.json',
  ].join('\n'))
  assert.equal(submit().props.disabled, false)
  submit().props.onClick()
  tree = render()
  const request = JSON.parse(toText(collectByType(tree, 'pre')[0]))
  assert.equal(request.mode, 'dry-run')
  assert.deepEqual(request.draftPaths, ['D:/drafts/C.json'])
  assert.deepEqual(request.drafts.map((draft) => draft.title), ['A', 'B'])
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'accountId'), false)

  // 任何输入变化都撤销已生成的 JSON，避免拿着旧参数去执行。
  collectByType(tree, 'button').find((node) => node.props['data-role'] === 'publish-mode' && toText(node) === 'enqueue（入队，走审批）').props.onClick()
  tree = render()
  assert.equal(collectByType(tree, 'pre').length, 0)
  assert.equal(submit().props.disabled, false)

  collectByType(tree, 'input').find((node) => node.props.placeholder === 'daemon 账号 id，默认唯一账号').props.onChange({ target: { value: 'acc-1' } })
  tree = render()
  submit().props.onClick()
  tree = render()
  const enqueued = JSON.parse(toText(collectByType(tree, 'pre')[0]))
  assert.equal(enqueued.mode, 'enqueue')
  assert.equal(enqueued.accountId, 'acc-1')
})

test('有校验不通过的行时按钮保持禁用，不静默丢草稿', () => {
  const { render } = mountPanel()
  collectByType(render(), 'textarea')[0].props.onChange({
    target: {
      value: [
        '{"title":"A","price":100,"images":["D:/a.jpg"]}',
        '{"title":"B","price":200,"images":["D:/b.jpg"]}',
        '随便一行',
      ].join('\n'),
    },
  })
  const tree = render()
  const submit = collectByType(tree, 'button').find((node) => node.props['data-role'] === 'publish-batch-submit')
  assert.equal(submit.props.disabled, true)
  assert.match(submit.props.title, /有 1 行校验不通过，先修好再生成/)
})

test('「采集」模块只读：讲清统计口径与红线，不出现图片直链与可发布草稿', () => {
  const { openTab } = mountPanel()
  const text = toText(openTab('采集'))
  for (const expected of [
    'xy_reference_collect',
    '价格带 / 标题长度 / 类目 / 卖点词',
    '不下载他人图片',
    '不照抄文案',
    '单件失败不影响整批',
  ]) {
    assert.ok(text.includes(expected), '采集视图缺少：' + expected)
  }
  // 只读：不出现 daemon 地址、不出图片直链、不出入队参数
  assert.equal(/https?:\/\//.test(text), false)
  assert.equal(text.includes('enqueue'), false)
  assert.equal(text.includes('xy_publish_batch'), false)
})

test('rpc 在线：health / 账号就绪 / 队列计数 / 最近批次 / 设置摘要渲染到「自动发布」页', async () => {
  const { connection, calls } = createFakeConnection(daemonReplies())
  const mounted = mountPanel({ connection })
  const text = await snapshotText(mounted)

  assert.match(text, /daemon 状态/)
  assert.match(text, /在线 · v0\.3\.0 · 已运行 2 分钟/)
  assert.match(text, /1 个账号 · 1 个可写/)
  assert.match(text, /排队 2 · 执行中 1 · 完成 5 · 失败 0 · 待审 1/)
  assert.match(text, /batch-new · 共 4 · 排队 1 · 完成 3/)
  assert.equal(text.includes('未连接后台（daemon 未启动）'), false)
  // 设置摘要换成三个可保存的输入：间隔按秒、类目与风格来自 settings.get。
  const tree = mounted.render()
  assert.equal(roleNodes(tree, 'settings-form').length, 1)
  const inputs = collectByType(tree, 'input')
  assert.ok(inputs.some((node) => node.props.type === 'number' && node.props.value === '180'))
  assert.ok(inputs.some((node) => node.props.value === '电子资料'))
  assert.equal(collectByType(tree, 'select')[0].props.value, 'warm')

  // 发布页有三个消费者：任务表（limit 20）、daemon 快照（6 个端点）、步骤事件流与批次明细。
  // 乱序断言：effect 的 flush 顺序由假 React 的注册顺序决定，这里只认「都发了、payload 对」。
  assert.deepEqual(calls.filter((call) => call.endpoint === 'tasks.list').map((call) => call.payload.limit).sort(), [20, 50])
  assert.deepEqual(
    calls.map((call) => call.endpoint).filter((endpoint) => endpoint !== 'tasks.list').sort(),
    ['accounts', 'batches.get', 'copy.templates', 'events.list', 'health', 'settings.get', 'status'],
  )
  assert.equal(calls.every((call) => call.channel === '/bigfish'), true)
  assert.equal(calls.filter((call) => call.endpoint === 'events.list')[0].payload.since, 0)
  assert.equal(calls.filter((call) => call.endpoint === 'batches.get')[0].payload.id, 'batch-new')
})

test('rpc 返回 error 信封：整块降级成一行，不发批次查询', async () => {
  const replies = daemonReplies()
  replies.status = { ok: false, error: { code: 'INTERNAL', message: 'boom' } }
  const { connection, calls } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  const text = await snapshotText(mounted)

  assert.match(text, /未连接后台（daemon 未启动）/)
  assert.equal(text.includes('daemon 实时状态'), false)
  assert.equal(calls.some((call) => call.endpoint === 'batches.get'), false)
})

test('rpc 抛异常（同步 throw / reject）也不冒泡，只降级成一行', async () => {
  const syncThrow = daemonReplies()
  syncThrow.health = () => { throw new Error('transport down') }
  const first = mountPanel({ connection: createFakeConnection(syncThrow).connection })
  const firstText = await snapshotText(first)
  assert.match(firstText, /未连接后台（daemon 未启动）/)

  const rejected = daemonReplies()
  rejected.accounts = () => Promise.reject(new Error('rpc timeout'))
  const second = mountPanel({ connection: createFakeConnection(rejected).connection })
  const secondText = await snapshotText(second)
  assert.match(secondText, /未连接后台（daemon 未启动）/)
  assert.equal(secondText.includes('在线 ·'), false)
})

test('宿主没有 connection 服务：渲染不抛错，同样显示降级文案', async () => {
  const mounted = mountPanel()
  const text = await snapshotText(mounted)
  assert.match(text, /未连接后台（daemon 未启动）/)
})

test('轮询周期 3 秒；卸载时清定时器，之后不再发起 rpc', async () => {
  const { connection, calls } = createFakeConnection(daemonReplies())
  const mounted = mountPanel({ connection })
  await snapshotText(mounted)

  // 三个定时器：daemon 快照 + 工作流事件流 + 任务表，周期都是 3 秒。
  assert.equal(mounted.loaded.clock.size, 3)
  assert.equal(mounted.loaded.clock.period, 3000)
  const firstRound = calls.length
  const firstTasks = calls.filter((call) => call.endpoint === 'tasks.list').length
  mounted.loaded.clock.advance()
  await settle()
  assert.ok(calls.length > firstRound)
  // 任务状态由 daemon 异步推进，任务表必须跟着轮询而不是只拉一次。
  assert.ok(calls.filter((call) => call.endpoint === 'tasks.list').length > firstTasks)

  mounted.unmount()
  assert.equal(mounted.loaded.clock.size, 0)
  const afterUnmount = calls.length
  mounted.loaded.clock.advance()
  await settle()
  assert.equal(calls.length, afterUnmount)
})

test('工作流树：事件流按任务聚成「任务 → 步骤」，失败步骤用红字', async () => {
  const { connection } = createFakeConnection(daemonReplies())
  const mounted = mountPanel({ connection })
  const text = await snapshotText(mounted)

  assert.match(text, /工作流（现在在干嘛）/)
  assert.match(text, /任务 task-a · 批次 batch-new/)
  assert.match(text, /状态 执行中/)
  assert.match(text, /填标题 · 开始/)
  assert.match(text, /填标题 · 完成/)
  assert.match(text, /选类目 · 失败 · 失败：类目不支持/)

  // 结构断言：一个任务块、三步；失败步骤走 badText（红色）。
  const tree = mounted.render()
  const tasks = collectByType(tree, 'div').filter((node) => node.props['data-role'] === 'workflow-task')
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].props['data-task-id'], 'task-a')
  const steps = collectByType(tree, 'div').filter((node) => node.props['data-role'] === 'workflow-step')
  assert.deepEqual(steps.map((node) => node.props['data-step-state']), ['started', 'done', 'failed'])
})

test('工作流树：下一轮带上一次 nextSince 增量拉取，不重复拉旧事件', async () => {
  const { connection, calls } = createFakeConnection(daemonReplies())
  const mounted = mountPanel({ connection })
  await snapshotText(mounted)

  const firstRound = calls.filter((call) => call.endpoint === 'events.list')
  assert.equal(firstRound.length, 1)
  assert.equal(firstRound[0].payload.since, 0)
  assert.equal(firstRound[0].payload.limit, 200)

  mounted.loaded.clock.advance()
  await settle()
  const secondRound = calls.filter((call) => call.endpoint === 'events.list')
  assert.equal(secondRound.length, 2)
  // 回放里 nextSince=4：下一轮从 4 继续，不重拉 1..4。
  assert.equal(secondRound[1].payload.since, 4)
})

test('工作流树降级：events.list 返回 UNSUPPORTED（宿主加载的是重启前旧插件）时提示重启 DSH', async () => {
  const replies = daemonReplies()
  delete replies['events.list']
  const { connection } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  const text = await snapshotText(mounted)

  // 现场根因（2026-10-23）：宿主进程 23:24 启动，T2 才加 events.list，旧 handler 表里没有它。
  assert.match(text, /重启前的旧代码/)
  assert.match(text, /重启 DSH 桌面应用后自动恢复/)
  assert.match(text, /在线 · v0\.3\.0/)
  assert.match(text, /最近批次batch-new · 共 4/)
})

test('工作流树降级：传输层失败（daemon 离线）仍走「启动 daemon 后恢复」文案', async () => {
  const replies = daemonReplies()
  replies['events.list'] = { ok: false, error: { code: 'NETWORK', message: 'connect ECONNREFUSED' } }
  const { connection } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  const text = await snapshotText(mounted)

  assert.match(text, /事件流拉取失败/)
  assert.doesNotMatch(text, /重启 DSH 桌面应用后自动恢复/)
})

test('工作流树为空：daemon 在线但没有事件，给出「执行任务时才会写」的解释', async () => {
  const replies = daemonReplies()
  replies['events.list'] = { ok: true, value: { items: [], nextSince: 0 } }
  const { connection } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  const text = await snapshotText(mounted)
  assert.match(text, /还没有步骤事件/)
})

test('「诊断」页也显示 daemon 实时状态，与发布页共用同一份快照', async () => {
  const { connection, calls } = createFakeConnection(daemonReplies())
  const mounted = mountPanel({ connection })
  const tree = mounted.openTab('诊断')
  const text = await snapshotText(mounted, tree)

  assert.match(text, /daemon 状态/)
  assert.match(text, /在线 · v0\.3\.0/)
  assert.match(text, /排队 2/)
  // 假 React 不卸载未渲染的发布页：发布页的快照 + 事件流 + 任务表，加上诊断页自己的快照 = 4 个定时器。
  assert.equal(mounted.loaded.clock.size, 4)
  assert.equal(mounted.loaded.clock.period, 3000)
  assert.ok(calls.length >= 5)
})

test('bundle 不写死 daemon 地址以外的环境值，也不访问 document/localStorage/fetch', () => {
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('document.'), false)
  assert.equal(source.includes('fetch('), false)
  // 只读状态必须走 host rpc，且 channel 固定为 /bigfish。
  assert.ok(source.includes("RPC_CHANNEL = '/bigfish'"))
  assert.ok(source.includes('connection.rpc.call'))
})
/** 发布页填两条合法内联草稿（desc 是 daemon 入队必填）。 */
function typeDrafts(mounted, value) {
  collectByType(mounted.render(), 'textarea')[0].props.onChange({ target: { value } })
}

const TWO_DRAFTS = [
  '{"title":"笔记 A","desc":"九成新，无划线","price":990,"images":["D:/a.jpg"]}',
  '{"title":"笔记 B","desc":"全新未拆","price":1200,"images":["D:/b.jpg"]}',
].join('\n')

test('校验并入队：两次确认，第二次带 confirm:true 发 batch.enqueue，显示批次与每条初始状态', async () => {
  const replies = daemonReplies()
  replies['batch.enqueue'] = (payload) => ({
    ok: true,
    value: { batchId: payload.batchId, tasks: [{ id: 'q1', state: 'queued' }, { id: 'q2', state: 'queued' }], created: [true, false] },
  })
  const { connection, calls } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  await snapshotText(mounted)
  typeDrafts(mounted, TWO_DRAFTS)

  let tree = mounted.render()
  assert.equal(roleElements(tree, 'batch-enqueue')[0].props.disabled, false)
  roleElements(tree, 'batch-enqueue')[0].props.onClick()
  tree = mounted.render()
  assert.match(toText(tree), /确认入队/)
  assert.equal(calls.some((call) => call.endpoint === 'batch.enqueue'), false)

  roleElements(tree, 'batch-enqueue')[0].props.onClick()
  await settle()
  const enqueues = calls.filter((call) => call.endpoint === 'batch.enqueue')
  assert.equal(enqueues.length, 1)
  assert.equal(enqueues[0].channel, '/bigfish')
  assert.equal(enqueues[0].payload.confirm, true)
  assert.match(enqueues[0].payload.batchId, /^b-/)
  assert.equal(enqueues[0].payload.items.length, 2)
  assert.equal(enqueues[0].payload.items[0].kind, 'publish')
  assert.equal(enqueues[0].payload.items[0].payload.accountId, '2206569289277')
  assert.equal(enqueues[0].payload.items[0].payload.title, '笔记 A')
  assert.equal(enqueues[0].payload.items[0].payload.desc, '九成新，无划线')
  assert.equal(enqueues[0].payload.items[0].payload.priceCents, 990)
  assert.deepEqual(Array.from(enqueues[0].payload.items[0].payload.images), ['D:/a.jpg'])
  assert.match(String(enqueues[0].payload.items[0].dedupeKey), /^publish:/)

  const text = toText(mounted.render())
  assert.match(text, /已入队 b-/)
  const items = roleNodes(mounted.render(), 'batch-item').map((node) => toText(node))
  assert.equal(items.length, 2)
  assert.match(items[0], /排队/)
  assert.match(items[1], /已存在，跳过/)
})

test('校验并入队失败：batch-result 显示 host 错误，任务表与整页不降级', async () => {
  const replies = daemonReplies()
  replies['batch.enqueue'] = { ok: false, error: { code: 'VALIDATION', message: 'items 必须是非空数组' } }
  const { connection } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  await snapshotText(mounted)
  typeDrafts(mounted, TWO_DRAFTS)

  roleElements(mounted.render(), 'batch-enqueue')[0].props.onClick()
  await settle()
  roleElements(mounted.render(), 'batch-enqueue')[0].props.onClick()
  await settle()
  const text = toText(mounted.render())
  assert.match(text, /items 必须是非空数组/)
  assert.equal(roleNodes(mounted.render(), 'batch-result').length, 1)
  assert.equal(roleNodes(mounted.render(), 'tasks-table').length, 1)
  assert.equal(text.includes('未连接后台（daemon 未启动）'), false)
})

test('任务区：tasks.list(limit 20)；failed 行有重试、queued 行没有；重试也要点两次带 confirm', async () => {
  const replies = daemonReplies()
  const now = Date.now()
  replies['tasks.list'] = {
    ok: true,
    value: [
      { id: 't-failed', kind: 'publish', dedupeKey: 'k1', payload: {}, state: 'failed', attempts: 2, maxAttempts: 3, availableAt: 0, createdAt: now - 120000, updatedAt: now - 60000 },
      { id: 't-queued', kind: 'publish', dedupeKey: 'k2', payload: {}, state: 'queued', attempts: 0, maxAttempts: 3, availableAt: 0, createdAt: now - 30000, updatedAt: now - 30000 },
    ],
  }
  replies['tasks.retry'] = { ok: true, value: { id: 't-failed', state: 'queued' } }
  const { connection, calls } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  await snapshotText(mounted)

  const tree = mounted.render()
  assert.equal(roleNodes(tree, 'tasks-table').length, 1)
  assert.equal(roleNodes(tree, 'task-row').length, 2)
  assert.equal(roleElements(tree, 'task-retry').length, 1)
  assert.equal(calls.filter((call) => call.endpoint === 'tasks.list').some((call) => call.payload.limit === 20), true)

  roleElements(tree, 'task-retry')[0].props.onClick()
  assert.equal(calls.some((call) => call.endpoint === 'tasks.retry'), false)
  assert.match(toText(mounted.render()), /确认重试/)
  roleElements(mounted.render(), 'task-retry')[0].props.onClick()
  await settle()

  const retries = calls.filter((call) => call.endpoint === 'tasks.retry')
  assert.equal(retries.length, 1)
  assert.equal(retries[0].payload.confirm, true)
  assert.equal(retries[0].payload.id, 't-failed')
  assert.match(toText(mounted.render()), /已重试 t-failed/)
})

test('设置保存：点两次才带 confirm 发 settings.put，保存后重新拉 settings.get', async () => {
  let stored = { copyStyle: 'warm', defaultCategory: '电子资料', publishMinIntervalMs: 180000 }
  const replies = daemonReplies()
  replies['settings.get'] = () => ({ ok: true, value: stored })
  replies['settings.put'] = (payload) => {
    stored = { ...stored, ...payload.patch }
    return { ok: true, value: stored }
  }
  const { connection, calls } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  await snapshotText(mounted)

  let tree = mounted.render()
  assert.equal(roleNodes(tree, 'settings-form').length, 1)
  collectByType(tree, 'input').find((node) => node.props.type === 'number').props.onChange({ target: { value: '300' } })
  tree = mounted.render()
  const gets = () => calls.filter((call) => call.endpoint === 'settings.get').length
  const before = gets()

  roleElements(tree, 'settings-save')[0].props.onClick()
  assert.match(toText(mounted.render()), /确认保存/)
  assert.equal(calls.some((call) => call.endpoint === 'settings.put'), false)

  roleElements(mounted.render(), 'settings-save')[0].props.onClick()
  await settle()
  const puts = calls.filter((call) => call.endpoint === 'settings.put')
  assert.equal(puts.length, 1)
  assert.equal(puts[0].channel, '/bigfish')
  assert.equal(puts[0].payload.confirm, true)
  assert.equal(puts[0].payload.patch.publishMinIntervalMs, 300000)
  assert.equal(puts[0].payload.patch.defaultCategory, '电子资料')
  assert.equal(puts[0].payload.patch.copyStyle, 'warm')
  assert.ok(gets() > before, '保存成功后应重新拉 settings.get')
  assert.match(toText(mounted.render()), /设置已保存/)
  const interval = collectByType(mounted.render(), 'input').find((node) => node.props.type === 'number')
  assert.equal(interval.props.value, '300')
})

/** 离线回放：status 报错 → 面板整块降级；启停端点仍可按。 */
function offlineManageReplies() {
  const replies = manageReplies()
  replies.status = { ok: false, error: { code: 'NETWORK', message: 'daemon down' } }
  return replies
}

/** 启停端点的回放数据（host 侧返回 {status:'started'} / {stopped:true}）。 */
function manageReplies() {
  const replies = daemonReplies()
  replies['daemon.start'] = { ok: true, value: { status: 'started' } }
  replies['daemon.stop'] = { ok: true, value: { stopped: true, alreadyStopped: false } }
  return replies
}

test('进程管理：离线时「启动」可用、「停止」禁用，并讲清 daemon 是常驻监听进程', async () => {
  const mounted = mountPanel({ connection: createFakeConnection(offlineManageReplies()).connection })
  const text = await snapshotText(mounted)

  assert.match(text, /未连接后台（daemon 未启动）/)
  assert.match(text, /进程管理/)
  const tree = mounted.render()
  assert.equal(roleElements(tree, 'daemon-start').length, 1)
  assert.equal(roleElements(tree, 'daemon-start')[0].props.disabled, false)
  assert.equal(roleElements(tree, 'daemon-stop').length, 1)
  assert.equal(roleElements(tree, 'daemon-stop')[0].props.disabled, true)
})

test('进程管理：在线时「启动」禁用、「停止」可用', async () => {
  const mounted = mountPanel({ connection: createFakeConnection(manageReplies()).connection })
  await snapshotText(mounted)

  const tree = mounted.render()
  assert.equal(roleElements(tree, 'daemon-start')[0].props.disabled, true)
  assert.equal(roleElements(tree, 'daemon-stop')[0].props.disabled, false)
})

test('进程管理：点「启动」发 daemon.start（空 payload），显示进行中与成功提示', async () => {
  const { connection, calls } = createFakeConnection(offlineManageReplies())
  const mounted = mountPanel({ connection })
  await snapshotText(mounted)

  roleElements(mounted.render(), 'daemon-start')[0].props.onClick()
  const busy = mounted.render()
  assert.match(toText(busy), /正在启动…/)
  assert.equal(roleElements(busy, 'daemon-start')[0].props.disabled, true)

  await settle()
  assert.match(toText(mounted.render()), /已请求启动 daemon，等下一次轮询确认在线/)
  const starts = calls.filter((call) => call.endpoint === 'daemon.start')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].channel, '/bigfish')
  assert.deepEqual(Object.keys(starts[0].payload), [])
})

test('进程管理：停 daemon 要点两次，第二次才带 confirm:true 发 daemon.stop', async () => {
  const { connection, calls } = createFakeConnection(manageReplies())
  const mounted = mountPanel({ connection })
  await snapshotText(mounted)

  const first = roleElements(mounted.render(), 'daemon-stop')[0]
  assert.equal(first.props.disabled, false)
  first.props.onClick()
  let armed = mounted.render()
  assert.match(toText(armed), /再点一次「确认停止」才会停 daemon/)
  assert.equal(toText(roleElements(armed, 'daemon-stop')[0]), '确认停止 daemon')
  assert.equal(calls.some((call) => call.endpoint === 'daemon.stop'), false)

  roleElements(mounted.render(), 'daemon-stop')[0].props.onClick()
  assert.match(toText(mounted.render()), /正在停止…/)
  await settle()

  const stops = calls.filter((call) => call.endpoint === 'daemon.stop')
  assert.equal(stops.length, 1)
  assert.equal(stops[0].payload.confirm, true)
  assert.match(toText(mounted.render()), /daemon 已停止；队列暂停执行/)
})

test('进程管理：动作失败时把 host 侧的 error.message 显示出来，而不是只写「失败」', async () => {
  const replies = offlineManageReplies()
  replies['daemon.start'] = { ok: false, error: { code: 'INTERNAL', message: '找不到 node 可执行文件：请配 nodePath' } }
  const mounted = mountPanel({ connection: createFakeConnection(replies).connection })
  await snapshotText(mounted)

  roleElements(mounted.render(), 'daemon-start')[0].props.onClick()
  await settle()
  const text = toText(mounted.render())
  assert.match(text, /找不到 node 可执行文件：请配 nodePath/)
  assert.equal(roleElements(mounted.render(), 'daemon-start')[0].props.disabled, false)
})

test('进程管理：宿主没有 connection 服务时点「启动」给出可执行提示，不抛错', async () => {
  const mounted = mountPanel()
  await snapshotText(mounted)

  roleElements(mounted.render(), 'daemon-start')[0].props.onClick()
  await settle()
  assert.match(toText(mounted.render()), /宿主没有连接服务，无法操作 daemon/)
})
