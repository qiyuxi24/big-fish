import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALERT_STATES,
  ALERT_SUMMARY_MAX_CHARS,
  MAX_ALERT_LINES,
  alertSummary,
  buildAlertMessage,
  collectAlertEvents,
  formatAlertLine,
  formatAlertText,
  hintForEvents,
  isAlertEvent,
  shortTaskId,
  takeNewEvents,
} from '../src/alerts.js'

const failedEvent = {
  id: 7,
  taskId: 'task-abcdefghijkl',
  batchId: 'batch-1',
  kind: 'task.state',
  state: 'failed',
  code: 'RISK_CONTROL',
  message: '风控拦截',
}

test('只有 task.state 落到 failed / needs_review 才算告警', () => {
  assert.deepEqual(ALERT_STATES, ['failed', 'needs_review'])
  assert.equal(isAlertEvent(failedEvent), true)
  assert.equal(isAlertEvent({ ...failedEvent, state: 'needs_review' }), true)
  assert.equal(isAlertEvent({ ...failedEvent, state: 'done' }), false)
  assert.equal(isAlertEvent({ ...failedEvent, state: 'leased' }), false)
  assert.equal(isAlertEvent({ ...failedEvent, kind: 'task.step' }), false)
  assert.equal(isAlertEvent(null), false)
  assert.equal(isAlertEvent('failed'), false)
})

test('collectAlertEvents 保持顺序、过滤非告警、非数组安全', () => {
  const items = [
    { id: 1, taskId: 't1', kind: 'task.step', state: 'failed' },
    { id: 2, taskId: 't2', kind: 'task.state', state: 'leased' },
    { id: 3, taskId: 't3', kind: 'task.state', state: 'failed' },
    { id: 4, taskId: 't4', kind: 'task.state', state: 'needs_review' },
  ]
  assert.deepEqual(collectAlertEvents(items).map((event) => event.id), [3, 4])
  assert.deepEqual(collectAlertEvents(undefined), [])
  assert.deepEqual(collectAlertEvents({}), [])
})

test('takeNewEvents 按 id 去重', () => {
  const seen = new Set()
  assert.deepEqual(takeNewEvents([failedEvent, { ...failedEvent, id: 8 }], seen).map((event) => event.id), [7, 8])
  assert.deepEqual(takeNewEvents([failedEvent], seen), [])
  assert.equal(seen.size, 2)
})

test('takeNewEvents 跳过没有 id 的事件，并按上限丢最早的', () => {
  const seen = new Set()
  assert.deepEqual(takeNewEvents([{ taskId: 'x' }], seen), [])
  const events = [1, 2, 3].map((id) => ({ id }))
  takeNewEvents(events, seen, 2)
  assert.deepEqual([...seen], [2, 3])
})

test('shortTaskId 只留前 12 位，非字符串也能渲染', () => {
  assert.equal(shortTaskId('task-abcdefghijkl'), 'task-abcdefg')
  assert.equal(shortTaskId('short'), 'short')
  assert.equal(shortTaskId(undefined), '')
})

test('formatAlertLine：任务/批次/状态/错误码/消息', () => {
  assert.equal(
    formatAlertLine(failedEvent),
    '- 任务 task-abcdefg · 批次 batch-1 · 状态 失败 · RISK_CONTROL · 风控拦截',
  )
  assert.equal(
    formatAlertLine({ id: 1, taskId: 't-1', kind: 'task.state', state: 'needs_review' }),
    '- 任务 t-1 · 状态 待复核',
  )
})

test('hintForEvents：风控优先于登录态，其次待复核，最后默认', () => {
  assert.match(hintForEvents([failedEvent]), /风控信号/)
  assert.match(
    hintForEvents([{ ...failedEvent, code: 'AUTH_EXPIRED' }, { ...failedEvent, id: 2, code: 'INTERNAL' }]),
    /daemon:import-account/,
  )
  assert.match(hintForEvents([{ ...failedEvent, state: 'needs_review', code: 'INTERNAL' }]), /人工复核/)
  assert.match(hintForEvents([{ ...failedEvent, code: 'INTERNAL' }]), /查看任务详情/)
})

test('formatAlertText：标题带条数、明细最多 5 条、其余折叠', () => {
  const one = formatAlertText([failedEvent])
  assert.match(one, /^⚠️ 闲鱼自动发布出现 1 条异常：/)
  assert.ok(one.includes('- 任务 task-abcdefg · 批次 batch-1'))
  assert.ok(one.includes('下一步：'))

  const many = Array.from({ length: MAX_ALERT_LINES + 2 }, (_, index) => ({ ...failedEvent, id: index + 1, taskId: 't-' + index }))
  const text = formatAlertText(many)
  assert.match(text, /出现 7 条异常：/)
  assert.equal(text.split('\n').filter((line) => line.startsWith('- 任务 ')).length, MAX_ALERT_LINES)
  assert.match(text, /另有 2 条/)
})

test('alertSummary 折叠成一行且不超过 120 字符', () => {
  assert.equal(alertSummary([failedEvent]), '闲鱼自动发布 1 条异常（RISK_CONTROL）：任务 task-abcdefg')
  const long = Array.from({ length: 40 }, (_, index) => ({ ...failedEvent, id: index, taskId: 'x'.repeat(80) }))
  const summary = alertSummary(long)
  assert.ok(summary.length <= ALERT_SUMMARY_MAX_CHARS)
})

test('buildAlertMessage 产出宿主 followup 需要的 user message 形状', () => {
  let seq = 0
  const message = buildAlertMessage([failedEvent], { plugin: 'bigfish-ops', idFactory: () => 'id-' + ++seq })
  assert.equal(message.id, 'id-1')
  assert.equal(message.role, 'user')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  assert.match(message.content[0].text, /闲鱼自动发布出现 1 条异常/)
  assert.deepEqual(message.source, {
    kind: 'plugin',
    plugin: 'bigfish-ops',
    form: 'notice',
    summary: '闲鱼自动发布 1 条异常（RISK_CONTROL）：任务 task-abcdefg',
  })
})

test('buildAlertMessage 默认 plugin 名与真实 id', () => {
  const message = buildAlertMessage([failedEvent])
  assert.equal(message.source.plugin, 'bigfish-ops')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length >= 16)
})
