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
  assert.equal(tools.length, 14)
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
  assert.equal(tools.length, 14)
  assert.equal(listeners.has('tools/pre-execute'), false)
})

test('配置非法时 apply 直接抛错（fail loud，不留半加载状态）', () => {
  const { ctx, tools } = createFakeCtx()
  assert.throws(() => apply(ctx, { daemonUrl: 'ftp://x' }), /daemonUrl/)
  assert.equal(tools.length, 0)
})
