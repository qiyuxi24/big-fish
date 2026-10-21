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
  // 参考采集只读统计（mtop 详情/主页列表），不写队列、不落文件，属于读类。
  assert.equal(isWriteCall('xy_reference_collect', { accountId: 'acc-1', itemIds: ['1'] }), false)
  assert.equal(WRITE_TOOLS.has('xy_reference_collect'), false)
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

test('批量发布：只有 enqueue 才拦，dry-run 放行', () => {
  assert.equal(isWriteCall('xy_publish_batch', { drafts: [{ title: 'x' }] }), false)
  assert.equal(isWriteCall('xy_publish_batch', { draftPaths: ['a.json'], mode: 'dry-run' }), false)
  assert.equal(isWriteCall('xy_publish_batch', { drafts: [{ title: 'x' }], mode: 'enqueue' }), true)
  // 参数形态无法判断时按最保守处理。
  assert.equal(isWriteCall('xy_publish_batch', null), true)
  assert.equal(WRITE_TOOLS.has('xy_publish_batch'), true)
})

test('任务重试属于写操作：会清零 attempts 并让 daemon 重放发布', () => {
  // 与 ack/fail/release 的「本地队列流转不挂门禁」口径不同：retry 重置重试预算，
  // 真机（BF_PUBLISH_SUBMIT=1）下就是再发一次发布，必须人工确认。
  assert.equal(isWriteCall('xy_task_retry', { taskId: 'x' }), true)
  assert.equal(isWriteCall('xy_task_retry', null), true)
  assert.equal(WRITE_TOOLS.has('xy_task_retry'), true)
  // 只影响本地队列可达性的动作仍然放行。
  assert.equal(isWriteCall('xy_task_action', { id: 'x', action: 'release' }), false)
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

  const batch = gate({ name: 'xy_publish_batch', arguments: { mode: 'enqueue' } }, () => ({ kind: 'allow' }))
  assert.equal(batch.kind, 'ask')
  assert.match(batch.reason, /BF_PUBLISH_SUBMIT=1/)
  const batchDryRun = gate({ name: 'xy_publish_batch', arguments: { mode: 'dry-run' } }, () => ({ kind: 'allow' }))
  assert.equal(batchDryRun.kind, 'allow')

  const retry = gate({ name: 'xy_task_retry', arguments: { taskId: 'x' } }, () => ({ kind: 'allow' }))
  assert.equal(retry.kind, 'ask')
  assert.match(retry.reason, /BF_PUBLISH_SUBMIT=1/)
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
