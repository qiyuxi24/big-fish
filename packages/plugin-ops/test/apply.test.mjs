import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'
import { createFakeCtx } from './helpers.mjs'

test('插件元信息与 DSH 约定一致', () => {
  assert.equal(name, 'bigfish-ops')
  assert.deepEqual(inject, ['tools'])
})

test('apply 注册全部工具与写操作门禁', () => {
  const { ctx, tools, listeners } = createFakeCtx()
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(ctx, { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }
  assert.equal(tools.length, 16)
  assert.ok(tools.every((tool) => tool.name.startsWith('xy_')))
  assert.equal(listeners.has('tools/pre-execute'), true)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /bigfish-ops 已加载/)
})

test('加载日志带 alerts 状态；没有活着的 agent 时不 arm（不空转定时器）', () => {
  const { ctx, listeners } = createFakeCtx()
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(ctx, { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }
  assert.equal(logs.length, 1)
  assert.match(logs[0], /"alerts":"waiting-for-agent"/)
  assert.equal(listeners.has('agent/created'), true)
})

test('enableAlerts=false 时不注册告警监听', () => {
  const { ctx, listeners } = createFakeCtx()
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(ctx, { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token', enableAlerts: false })
  } finally {
    console.log = original
  }
  assert.match(logs[0], /"alerts":"disabled"/)
  assert.equal(listeners.has('agent/created'), false)
})

test('writeGate=false 时不注册门禁', () => {
  const { ctx, tools, listeners } = createFakeCtx()
  const original = console.log
  console.log = () => {}
  try {
    apply(ctx, { tokenPath: '/tmp/daemon.token', writeGate: false })
  } finally {
    console.log = original
  }
  assert.equal(tools.length, 16)
  assert.equal(listeners.has('tools/pre-execute'), false)
})

test('enabled=false 时整插件零副作用（不注册工具/门禁/监听，只留一条禁用日志）', () => {
  const { ctx, tools, listeners } = createFakeCtx()
  const original = console.log
  const logs = []
  console.log = (line) => logs.push(line)
  try {
    apply(ctx, { enabled: false, daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }
  assert.equal(tools.length, 0)
  assert.equal(listeners.size, 0)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /已禁用/)
  assert.match(logs[0], /"enabled":false/)
})

test('配置非法时 apply 直接抛错（fail loud，不留半加载状态）', () => {
  const { ctx, tools } = createFakeCtx()
  assert.throws(() => apply(ctx, { daemonUrl: 'ftp://x' }), /daemonUrl/)
  assert.equal(tools.length, 0)
})

/** 造一个「带 settings 服务、且 inject 立即回调」的 ctx，用来验证运行时软开关。 */
function createSettingsCtx(initialEnabled = true) {
  const base = createFakeCtx()
  const scope = {
    value: { enabled: initialEnabled },
    watchers: [],
    get() { return this.value },
    watch(fn) { this.watchers.push(fn) },
  }
  const settings = {
    register() { return scope },
  }
  base.ctx.inject = (deps, cb) => {
    // 只响应 settings 注入；connection/webServer 注入一律不回调，面板 rpc 保持 deferred。
    if (deps.length === 1 && deps[0] === 'settings') cb({ settings })
  }
  return { ...base, scope }
}

test('设置卡片运行时关掉「是否启用」会真撤销 16 个工具，再打开会重注册', () => {
  const { ctx, tools, listeners, scope } = createSettingsCtx(true)
  const original = console.log
  console.log = () => {}
  try {
    apply(ctx, { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' })
    assert.equal(tools.length, 16)
    assert.equal(listeners.has('tools/pre-execute'), true)

    // 用户在设置页点「停用」→ settings.yaml 写 enabled:false → watch 投影回 setEnabled(false)。
    scope.value = { enabled: false }
    scope.watchers.forEach((fn) => fn())
    assert.equal(tools.length, 0, '停用后工具要从宿主撤下来，才省得掉每轮 schema 固定税')
    assert.equal(listeners.has('tools/pre-execute'), false, '门禁一起撤，不留半个插件')

    // 再点「启用」→ 重新注册，工具与门禁都回来。
    scope.value = { enabled: true }
    scope.watchers.forEach((fn) => fn())
    assert.equal(tools.length, 16)
    assert.ok(tools.every((tool) => tool.name.startsWith('xy_')))
    assert.equal(listeners.has('tools/pre-execute'), true)
  } finally {
    console.log = original
  }
})

test('settings.yaml 存过 false 时，本次加载首帧就是停用态（零工具）', () => {
  const { ctx, tools, listeners } = createSettingsCtx(false)
  const original = console.log
  console.log = () => {}
  try {
    apply(ctx, { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' })
  } finally {
    console.log = original
  }
  assert.equal(tools.length, 0)
  assert.equal(listeners.has('tools/pre-execute'), false)
})
