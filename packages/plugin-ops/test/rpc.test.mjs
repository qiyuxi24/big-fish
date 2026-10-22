import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { DaemonError } from '../src/client.js'
import { RPC_CHANNEL, createRpcBridge } from '../src/rpc.js'
import { createFakeClient, createFakeCtx } from './helpers.mjs'

/** 用假的 daemon 客户端建桥；所有 client 调用都会记进 client.calls。 */
function bridgeWith(overrides = {}, options = {}) {
  const client = createFakeClient(overrides)
  return { client, bridge: createRpcBridge({ client, ...options }) }
}

/** 断言失败信封的形状：code 稳定、message 中文、不含 stack。 */
function assertError(result, code, pattern) {
  assert.equal(result.ok, false)
  assert.equal(result.error.code, code)
  assert.equal(typeof result.error.message, 'string')
  if (pattern !== undefined) assert.match(result.error.message, pattern)
}

test('只读端点透传：health/status/accounts/items.list 各调一次客户端', async () => {
  const { client, bridge } = bridgeWith({ health: { ok: 1 }, status: { queue: {} }, listAccounts: [], listItems: [] })
  assert.deepEqual(await bridge.handle('health', {}), { ok: true, value: { ok: 1 } })
  assert.deepEqual(await bridge.handle('status'), { ok: true, value: { queue: {} } })
  assert.deepEqual(await bridge.handle('accounts', null), { ok: true, value: [] })
  assert.deepEqual(await bridge.handle('items.list', {}), { ok: true, value: [] })
  assert.deepEqual(client.calls.map((call) => call.method), ['health', 'status', 'listAccounts', 'listItems'])
})

test('tasks.list 只转发白名单字段（未知字段不落到 daemon）', async () => {
  const { client, bridge } = bridgeWith({ listTasks: [] })
  const result = await bridge.handle('tasks.list', { state: 'failed', kind: 'publish', limit: 5, accountId: 'a1', evil: true })
  assert.deepEqual(result, { ok: true, value: [] })
  assert.deepEqual(client.calls[0].args[0], { state: 'failed', kind: 'publish', limit: 5 })
})

test('tasks.list 参数非法时返回 VALIDATION，且不调 daemon', async () => {
  const { client, bridge } = bridgeWith({ listTasks: [] })
  assertError(await bridge.handle('tasks.list', { state: 'nope' }), 'VALIDATION', /state 非法/)
  assertError(await bridge.handle('tasks.list', { limit: 0 }), 'VALIDATION', /limit 必须/)
  assert.equal(client.calls.length, 0)
})

test('未知 endpoint 返回 UNSUPPORTED，不触发任何 daemon 调用', async () => {
  const { client, bridge } = bridgeWith({ status: { ok: 1 } })
  assertError(await bridge.handle('admin.dropDb', {}), 'UNSUPPORTED', /不支持的 rpc endpoint/)
  assertError(await bridge.handle('__proto__', {}), 'UNSUPPORTED')
  assert.equal(client.calls.length, 0)
})

test('写类端点缺 confirm 一律拒绝（面板误触/模型幻觉的第一道闸）', async () => {
  const { client, bridge } = bridgeWith({ request: { task: { id: 't1' } }, enqueue: { id: 't1' } })
  for (const endpoint of ['tasks.retry', 'accounts.import', 'accounts.login', 'batch.enqueue', 'settings.put']) {
    assertError(await bridge.handle(endpoint, {}), 'VALIDATION', /需要 confirm:true/)
  }
  assert.equal(client.calls.length, 0)
})

test('tasks.retry 带 confirm 后走客户端缺失方法时的通用 request（POST /tasks/:id/retry）', async () => {
  const { client, bridge } = bridgeWith({ request: { id: 't1', state: 'queued' } })
  const result = await bridge.handle('tasks.retry', { id: 't1', confirm: true })
  assert.deepEqual(result, { ok: true, value: { id: 't1', state: 'queued' } })
  assert.equal(client.calls[0].method, 'request')
  assert.deepEqual(client.calls[0].args, ['/tasks/t1/retry', { method: 'POST' }])
})

test('accounts.login 长轮询：HTTP 超时比 daemon 的扫码等待宽，参数只保留白名单字段', async () => {
  const { client, bridge } = bridgeWith({ request: { accountId: 'acc' } })
  const result = await bridge.handle('accounts.login', { accountId: 'acc', port: 9222, cookie: 'x', confirm: true })
  assert.equal(result.ok, true)
  const [pathname, init] = client.calls[0].args
  assert.equal(pathname, '/accounts/login')
  assert.equal(init.method, 'POST')
  assert.deepEqual(init.body, { accountId: 'acc', port: 9222 })
  assert.ok(init.timeoutMs > 180_000, '默认等待 180s，HTTP 超时必须更宽，否则客户端先断开')
  // 调用方自己缩短等待时，HTTP 超时也只需比它宽，不必固定 200s。
  await bridge.handle('accounts.login', { timeoutMs: 30_000, confirm: true })
  assert.equal(client.calls[1].args[1].timeoutMs, 50_000)
})

test('accounts.import 只转发 accountId/port，非法端口直接 VALIDATION', async () => {
  const { client, bridge } = bridgeWith({ importAccount: { accountId: 'acc', fields: 3 } })
  const result = await bridge.handle('accounts.import', { accountId: 'acc', confirm: true, extra: 'x' })
  assert.equal(result.ok, true)
  assert.deepEqual(client.calls[0], { method: 'importAccount', args: [{ accountId: 'acc' }] })
  assertError(await bridge.handle('accounts.import', { port: 70_000, confirm: true }), 'VALIDATION', /port 必须在/)
})

test('batch.enqueue 串行入队并带上 batchId，把 {task,created} 归一成任务数组', async () => {
  const { client, bridge } = bridgeWith({
    enqueue: async (input) => ({ task: { id: input.dedupeKey, state: 'queued' }, created: input.dedupeKey !== 'dup' }),
  })
  const items = [
    { kind: 'publish', dedupeKey: 'a', payload: { title: 'A' } },
    { kind: 'publish', dedupeKey: 'dup', payload: { title: 'B' }, availableAt: 1_700_000_000_000 },
  ]
  const result = await bridge.handle('batch.enqueue', { batchId: 'b1', items, confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.value.batchId, 'b1')
  assert.deepEqual(result.value.tasks.map((task) => task.id), ['a', 'dup'])
  assert.deepEqual(result.value.created, [true, false])
  assert.equal(client.calls.length, 2)
  assert.deepEqual(client.calls[0].args[0], { kind: 'publish', dedupeKey: 'a', payload: { title: 'A' }, batchId: 'b1' })
  assert.equal(client.calls[1].args[0].batchId, 'b1')
})

test('batch.enqueue 校验 items 数量与字段（空数组/超上限/缺 dedupeKey）', async () => {
  const { client, bridge } = bridgeWith({ enqueue: () => ({ id: 'x' }) })
  assertError(await bridge.handle('batch.enqueue', { items: [], confirm: true }), 'VALIDATION', /items 必须是非空数组/)
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ kind: 'publish', dedupeKey: 'k' + index, payload: {} }))
  assertError(await bridge.handle('batch.enqueue', { items: tooMany, confirm: true }), 'VALIDATION', /最多 20 条/)
  assertError(await bridge.handle('batch.enqueue', { items: [{ kind: 'publish', payload: {} }], confirm: true }), 'VALIDATION', /dedupeKey/)
  assert.equal(client.calls.length, 0)
})

test('reference.collect 校验 accountId 与 itemIds/sellerId 至少一个', async () => {
  const { client, bridge } = bridgeWith({ collectReferences: { items: [] } })
  assertError(await bridge.handle('reference.collect', {}), 'VALIDATION', /accountId/)
  assertError(await bridge.handle('reference.collect', { accountId: 'acc' }), 'VALIDATION', /itemIds 或 sellerId/)
  assertError(await bridge.handle('reference.collect', { accountId: 'acc', itemIds: ['abc'] }), 'VALIDATION', /纯数字串/)
  const result = await bridge.handle('reference.collect', { accountId: 'acc', itemIds: ['123', '123', '456'], sellerId: '789', extra: 1 })
  assert.equal(result.ok, true)
  assert.deepEqual(client.calls[0].args[0], { accountId: 'acc', itemIds: ['123', '456'], sellerId: '789' })
})

test('settings.get/put 优先用注入的 settingsStore，字段白名单之外的键被拒绝', async () => {
  const writes = []
  const settingsStore = {
    read: () => ({ copyStyle: '简洁' }),
    write: (patch) => {
      writes.push(patch)
      return { copyStyle: '专业' }
    },
  }
  const { client, bridge } = bridgeWith({}, { settingsStore })
  assert.deepEqual(await bridge.handle('settings.get', {}), { ok: true, value: { copyStyle: '简洁' } })
  assert.deepEqual(await bridge.handle('settings.put', { patch: { copyStyle: '专业', publishMinIntervalMs: 60_000 }, confirm: true }), {
    ok: true,
    value: { copyStyle: '专业' },
  })
  assert.deepEqual(writes, [{ copyStyle: '专业', publishMinIntervalMs: 60_000 }])
  assertError(await bridge.handle('settings.put', { patch: { evil: 1 }, confirm: true }), 'VALIDATION', /不支持字段/)
  assertError(await bridge.handle('settings.put', { patch: { publishMinIntervalMs: 1_000 }, confirm: true }), 'VALIDATION', /30000..3600000/)
  assert.equal(client.calls.length, 0)
})

test('settings.get/put 没有 settingsStore 时退回 daemon 的 GET/PUT /settings', async () => {
  const { client, bridge } = bridgeWith({ request: { copyStyle: '简洁' } })
  await bridge.handle('settings.get', {})
  await bridge.handle('settings.put', { patch: { maxBatchItems: 3 }, confirm: true })
  assert.deepEqual(client.calls[0].args, ['/settings'])
  assert.deepEqual(client.calls[1].args, ['/settings', { method: 'PUT', body: { maxBatchItems: 3 } }])
})

test('daemon 抛错翻译成稳定 code；未知异常收敛为 INTERNAL 且不泄栈', async () => {
  const failing = bridgeWith({ status: new DaemonError('CIRCUIT_OPEN', '账号熔断中') }).bridge
  assertError(await failing.handle('status', {}), 'CIRCUIT_OPEN', /账号熔断中/)
  const leaking = bridgeWith({ status: new Error('boom\n    at secret.ts:1') }).bridge
  const result = await leaking.handle('status', {})
  assertError(result, 'INTERNAL', /boom/)
  assert.equal(result.error.details, undefined)
})

test('非法 payload / endpoint 类型都返回信封而不是抛错（host 侧安全边界）', async () => {
  const { bridge } = bridgeWith({ status: { ok: 1 } })
  assertError(await bridge.handle('status', 'not-an-object'), 'VALIDATION', /payload 必须是对象/)
  assertError(await bridge.handle('status', [1, 2]), 'VALIDATION')
  assertError(await bridge.handle(Symbol('x'), {}), 'UNSUPPORTED')
  assert.deepEqual(await bridge.handle('status'), { ok: true, value: { ok: 1 } })
})

test('createRpcBridge 缺少 client 时 fail loud；endpoints 选项可追加端点', async () => {
  assert.throws(() => createRpcBridge(), /需要 daemon 客户端/)
  const { bridge } = bridgeWith({}, { endpoints: { ping: async () => 'pong' } })
  assert.ok(bridge.endpoints.includes('ping'))
  assert.deepEqual(await bridge.handle('ping', {}), { ok: true, value: 'pong' })
  assert.equal(bridge.channel, RPC_CHANNEL)
  assert.equal(RPC_CHANNEL, '/bigfish')
})

/** 带 inject/effect 的假 ctx：模拟 Cordis 等服务就绪后回调。 */
function createRpcHostCtx(options = {}) {
  const base = createFakeCtx()
  const injected = []
  const disposers = []
  const registered = []
  const webRoutes = []
  const webDisposers = []
  // 用 getter 动态读：测试可以在 apply 前才把 connection 塞进来。
  const readService = (name) => {
    if (name === 'connection') return base.ctx.connection
    if (name === 'webServer') return options.webServer
    return undefined
  }
  base.ctx.inject = (deps, callback) => {
    injected.push(deps)
    const scope = {
      get: readService,
      effect: (fn) => {
        disposers.push(fn())
      },
    }
    // 只有用例提供 webServer 时才暴露子 inject：默认保持「宿主 bug + 无 webServer」的降级路径。
    if (options.webServer !== undefined) {
      scope.inject = (nestedDeps, nestedCallback) => {
        injected.push(nestedDeps)
        nestedCallback({
          get: readService,
          effect: (fn) => {
            webDisposers.push(fn())
          },
        })
      }
    }
    callback(scope)
  }
  if (options.connection !== undefined) base.ctx.connection = options.connection
  return {
    ...base,
    injected,
    disposers,
    registered,
    webRoutes,
    webDisposers,
    setConnection(connection) {
      base.ctx.connection = connection
    },
  }
}

test('apply 挂载 /bigfish 通道，并在卸载时释放 effect', () => {
  let released = false
  const host = createRpcHostCtx()
  host.setConnection({
    rpc: {
      handle(channel, handler) {
        host.registered.push({ channel, handler })
        return () => { released = true }
      },
    },
  })
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(host.ctx, { tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }
  assert.deepEqual(host.injected[0], ['connection'])
  assert.equal(host.registered.length, 1)
  assert.equal(host.registered[0].channel, '/bigfish')
  assert.equal(typeof host.registered[0].handler, 'function')
  const record = JSON.parse(logs[0])
  assert.equal(record.rpcChannel, 'registered')
  assert.equal(host.disposers.length, 1)
  host.disposers[0]()
  assert.equal(released, true)
})

test('宿主没有 connection 时 apply 不抛错、工具照常注册、日志标记 skipped', () => {
  const { ctx, tools } = createFakeCtx()
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(ctx, { tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }
  assert.equal(tools.length, 14)
  assert.equal(logs.length, 1)
  assert.equal(JSON.parse(logs[0]).rpcChannel, 'skipped')
})

test('connection 存在但 rpc.handle 缺失时降级为 skipped（不阻断插件加载）', () => {
  const host = createRpcHostCtx({ connection: { rpc: {} } })
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(host.ctx, { tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }
  assert.equal(JSON.parse(logs[0]).rpcChannel, 'skipped')
  assert.equal(host.registered.length, 0)
})

test('rpc.handle 注册失败（频道被占）只告警，不影响工具注册', () => {
  const host = createRpcHostCtx({ connection: { rpc: { handle: () => { throw new Error('channel already has an interceptor') } } } })
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(host.ctx, { tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }
  // 失败告警先打，加载汇总日志在后；两者都要有，且工具注册不受影响。
  assert.match(logs[0], /rpc 通道注册失败/)
  assert.equal(JSON.parse(logs[1]).rpcChannel, 'failed')
})

test('命中 DSH 宿主 bug（webServer 未 inject）时告警里带上 ADR 指引', () => {
  const host = createRpcHostCtx({
    connection: { rpc: { handle: () => { throw new Error('cannot get property "webServer" without inject') } } },
  })
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(host.ctx, { tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }
  const record = JSON.parse(logs[0])
  assert.match(record.msg, /DSH 已知宿主 bug/)
  assert.match(record.msg, /adr\/0004-client-host-rpc/)
  assert.match(record.error, /webServer/)
})

test('命中宿主 bug 时改用插件自己的 webServer 兼容路由，面板不降级（不改宿主）', () => {
  let released = false
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        released = true
      }
    },
  }
  const host = createRpcHostCtx({
    webServer,
    connection: {
      // 宿主官方通道：照 0.1.5-rc.2 的行为抛 webServer inject 错误。
      rpc: {
        handle: () => {
          throw new Error('cannot get property "webServer" without inject')
        },
      },
      // 兼容路由的鉴权入口：本用例模拟已登录。
      requestRejection: () => undefined,
    },
  })
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(host.ctx, { tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }

  // 先官方后兼容：官方失败不再单独告警（能绕开时不该出现「面板不可用」的误导信息）。
  assert.deepEqual(host.injected, [['connection'], ['webServer', 'connection']])
  assert.equal(host.registered.length, 0)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/bigfish')
  assert.equal(typeof routes[0].handler, 'function')

  assert.equal(logs.length, 2)
  const active = JSON.parse(logs[0])
  assert.equal(active.level, 'info')
  assert.equal(active.rpcChannel, 'registered-webServer')
  assert.match(active.msg, /webServer 兼容路由/)
  assert.equal(JSON.parse(logs[1]).rpcChannel, 'registered-webServer')
  assert.equal(logs.some((line) => /rpc 通道注册失败/.test(line)), false)
  assert.equal(logs.some((line) => JSON.parse(line).level === 'warn'), false)

  // 卸载时路由随 effect 释放。
  assert.equal(host.webDisposers.length, 1)
  host.webDisposers[0]()
  assert.equal(released, true)
})

test('daemon 掉线的失败信封是 NETWORK 码：宿主自动拉起就靠它触发', async () => {
  const down = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:47001'), { code: 'NETWORK' })
  const { bridge } = bridgeWith({ status: down })
  const result = await bridge.handle('status', {})
  assertError(result, 'NETWORK', /ECONNREFUSED/)

  // 非网络错误仍按原码透出，不会被误判成「daemon 没起」。
  const validation = Object.assign(new Error('bad payload'), { code: 'VALIDATION' })
  const other = bridgeWith({ status: validation })
  assertError(await other.bridge.handle('status', {}), 'VALIDATION', /bad payload/)
})

test('daemon.start：走 supervisor.ensure(force) 跳过冷却，返回拉起结果', async () => {
  const calls = []
  const supervisor = {
    ensure: async (reason, options) => {
      calls.push({ reason, options })
      return { status: 'started', message: 'daemon 已拉起', detail: { pid: 4321 } }
    },
  }
  const { bridge } = bridgeWith({}, { supervisor })
  const result = await bridge.handle('daemon.start', {})
  assert.deepEqual(result, { ok: true, value: { status: 'started', message: 'daemon 已拉起', detail: { pid: 4321 } } })
  assert.deepEqual(calls, [{ reason: 'panel', options: { force: true } }])
})

test('daemon.start 没有 supervisor → UNSUPPORTED（不伪装成启动成功）', async () => {
  const { bridge } = bridgeWith({})
  assertError(await bridge.handle('daemon.start', {}), 'UNSUPPORTED', /daemon 管理能力/)
})

test('daemon.stop 缺 confirm → VALIDATION，且不向 daemon 发任何请求', async () => {
  const { client, bridge } = bridgeWith({ request: { stopping: true } })
  assertError(await bridge.handle('daemon.stop', {}), 'VALIDATION', /需要 confirm:true/)
  assert.equal(client.calls.length, 0)
})

test('daemon.stop：先探测在线 → POST /shutdown → 轮询到不可达后返回 stopped', async () => {
  const calls = []
  let healthCount = 0
  const request = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body })
    if (path === '/shutdown') return { stopping: true }
    healthCount += 1
    if (healthCount === 1) return { version: '0.3.0' }
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'NETWORK' })
  }
  const { bridge } = bridgeWith({ request })
  const result = await bridge.handle('daemon.stop', { confirm: true })
  assert.deepEqual(result, { ok: true, value: { stopped: true, alreadyStopped: false } })
  assert.deepEqual(calls.map((call) => call.path), ['/health', '/shutdown', '/health'])
  assert.equal(calls[1].method, 'POST')
})

test('daemon.stop：daemon 本来就停着 → 幂等成功，不发 /shutdown', async () => {
  const calls = []
  const request = async (path) => {
    calls.push(path)
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'NETWORK' })
  }
  const { bridge } = bridgeWith({ request })
  const result = await bridge.handle('daemon.stop', { confirm: true })
  assert.deepEqual(result, { ok: true, value: { stopped: true, alreadyStopped: true } })
  assert.deepEqual(calls, ['/health'])
})

