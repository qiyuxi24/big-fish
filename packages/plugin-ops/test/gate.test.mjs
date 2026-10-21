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
  // 文案请求只产出提示词，不写队列/凭据，属于读类。
  assert.equal(isWriteCall('xy_copy_plan', { productName: 'x', condition: 'new', priceYuan: '10' }), false)
  // 参数形态无法判断时按最保守处理：要确认（宁可多问一次，也不静默放行写操作）。
  assert.equal(isWriteCall('xy_task_enqueue', null), true)
  assert.equal(WRITE_TOOLS.has('xy_task_enqueue'), true)
})

test('登录态导入永远是写操作；发布只有 enqueue 才拦', () => {
  assert.equal(isWriteCall('xy_import_account', {}), true)
  assert.equal(isWriteCall('xy_import_account', null), true)
  assert.equal(isWriteCall('xy_publish_draft', { draftPath: 'a.json' }), false)
  assert.equal(isWriteCall('xy_publish_draft', { draftPath: 'a.json', mode: 'dry-run' }), false)
  assert.equal(isWriteCall('xy_publish_draft', { draftPath: 'a.json', mode: 'enqueue' }), true)
  assert.equal(isWriteCall('xy_publish_draft', null), true)
  assert.equal(WRITE_TOOLS.has('xy_import_account'), true)
  assert.equal(WRITE_TOOLS.has('xy_publish_draft'), true)
})

test('门禁为每种写操作给出各自的确认原因', () => {
  const { ctx, listeners } = createFakeCtx()
  registerWriteGate(ctx, {})
  const gate = listeners.get('tools/pre-execute')
  const account = gate({ name: 'xy_import_account', arguments: {} }, () => ({ kind: 'allow' }))
  assert.equal(account.kind, 'ask')
  assert.match(account.reason, /凭据/)
  const publish = gate({ name: 'xy_publish_draft', arguments: { mode: 'enqueue' } }, () => ({ kind: 'allow' }))
  assert.match(publish.reason, /BF_PUBLISH_SUBMIT=1/)
  const dryRun = gate({ name: 'xy_publish_draft', arguments: { mode: 'dry-run' } }, () => ({ kind: 'allow' }))
  assert.equal(dryRun.kind, 'allow')
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
