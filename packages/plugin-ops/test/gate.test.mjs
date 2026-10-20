import test from 'node:test'
import assert from 'node:assert/strict'
import { isWriteCall, registerWriteGate, WRITE_TOOLS } from '../src/gate.js'
import { createFakeCtx } from './helpers.mjs'

test('写类判定：只有 publish/deliver/polish 入队需要确认', () => {
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'publish' }), true)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'deliver' }), true)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'polish' }), true)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'probe' }), false)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'reply' }), false)
  assert.equal(isWriteCall('xy_tasks_list', {}), false)
  // 参数形态无法判断时按最保守处理：要确认（宁可多问一次，也不静默放行写操作）。
  assert.equal(isWriteCall('xy_task_enqueue', null), true)
  assert.equal(WRITE_TOOLS.has('xy_task_enqueue'), true)
})

test('门禁：写调用返回 ask，读调用走 next()', () => {
  const { ctx, listeners } = createFakeCtx()
  registerWriteGate(ctx, {})
  const gate = listeners.get('tools/pre-execute')
  assert.equal(typeof gate, 'function')

  const asked = gate({ name: 'xy_task_enqueue', arguments: { kind: 'publish' } }, () => ({ kind: 'allow' }))
  assert.equal(asked.kind, 'ask')
  assert.match(asked.reason, /人工确认/)

  const allowed = gate({ name: 'xy_status', arguments: {} }, () => ({ kind: 'allow' }))
  assert.equal(allowed.kind, 'allow')
})

test('disabled 时不注册监听器', () => {
  const { ctx, listeners } = createFakeCtx()
  const dispose = registerWriteGate(ctx, { enabled: false })
  assert.equal(listeners.size, 0)
  assert.equal(typeof dispose, 'function')
})

test('宿主没有 on() 时 fail loud', () => {
  assert.throws(() => registerWriteGate({}, {}), /on\(\)/)
})
