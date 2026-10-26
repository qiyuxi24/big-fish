/**
 * im-messages.ts 的行为测试：去重、会话时间线、对方 id 提取、参数校验。
 * 走公开出口（data.ts）打开库，不直接写 SQL——v6 迁移的存在由 store.test 的版本断言覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createImMessageRepository, openStore } from '../src/data.ts'
import type { ImMessageSink, Store } from '../src/data.ts'
import { XianyuError } from '../src/errors.ts'

const ACCOUNT = '2206569289277'
const PEER = '111222333'

let clock = 1_700_000_000_000

function makeSink(): { store: Store; sink: ImMessageSink } {
  const store = openStore({ path: ':memory:', now: () => (clock += 1) })
  const sink = createImMessageRepository(store, { now: () => (clock += 10) })
  return { store, sink }
}

function expectCode(code: string, body: () => unknown): void {
  let caught: unknown
  try {
    body()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof XianyuError, `期望抛 XianyuError(${code})，实际：${String(caught)}`)
  assert.equal(caught.code, code)
}

test('append/list：按到达顺序读出，fromSelf 由 senderId 与 accountId 判定', () => {
  const { sink } = makeSink()
  assert.equal(
    sink.append({ accountId: ACCOUNT, cid: 'c1', messageId: 'm1', senderId: PEER, kind: 'text', text: '在吗', chatTimeMs: 1_000 }),
    true,
  )
  assert.equal(
    sink.append({ accountId: ACCOUNT, cid: 'c1', messageId: 'm2', senderId: ACCOUNT, kind: 'text', text: '在的', chatTimeMs: 2_000 }),
    true,
  )
  const records = sink.list({ accountId: ACCOUNT, cid: 'c1' })
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((row) => row.messageId), ['m1', 'm2'])
  assert.deepEqual(records.map((row) => row.fromSelf), [false, true])
  assert.equal(records[0]!.text, '在吗')
  assert.equal(typeof records[0]!.receivedAt, 'number')
  assert.equal(sink.count(ACCOUNT), 2)
  assert.equal(sink.count('nobody'), 0)
})

test('append：同 (accountId, messageId) 重复返回 false，不同账号互不影响', () => {
  const { sink } = makeSink()
  const base = { cid: 'c1', messageId: 'm1', senderId: PEER, kind: 'text' as const, text: 'hi', chatTimeMs: 1_000 }
  assert.equal(sink.append({ accountId: ACCOUNT, ...base }), true)
  assert.equal(sink.append({ accountId: ACCOUNT, ...base }), false)
  assert.equal(sink.append({ accountId: ACCOUNT, ...base, text: '改过的正文也不会覆盖' }), false)
  assert.equal(sink.count(ACCOUNT), 1)
  assert.equal(sink.list({ accountId: ACCOUNT })[0]!.text, 'hi')
  assert.equal(sink.append({ accountId: 'other', ...base }), true)
  assert.equal(sink.count('other'), 1)
})

test('lastPeer：只认对方最近一条，自己的回声不算，按 cid 隔离', () => {
  const { sink } = makeSink()
  const push = (messageId: string, senderId: string, chatTimeMs: number, cid = 'c1'): void => {
    sink.append({ accountId: ACCOUNT, cid, messageId, senderId, kind: 'text', text: 'x', chatTimeMs })
  }
  assert.equal(sink.lastPeer({ accountId: ACCOUNT, cid: 'c1' }), undefined)
  push('m1', ACCOUNT, 1_000)
  assert.equal(sink.lastPeer({ accountId: ACCOUNT, cid: 'c1' }), undefined, '只有自己的消息时没有对方 id')
  push('m2', PEER, 2_000)
  push('m3', ACCOUNT, 3_000)
  assert.equal(sink.lastPeer({ accountId: ACCOUNT, cid: 'c1' }), PEER)
  push('m4', 'buyer-2', 4_000, 'c2')
  assert.equal(sink.lastPeer({ accountId: ACCOUNT, cid: 'c1' }), PEER)
  assert.equal(sink.lastPeer({ accountId: ACCOUNT, cid: 'c2' }), 'buyer-2')
  assert.equal(sink.lastPeer({ accountId: 'other', cid: 'c1' }), undefined)
})

test('list：cid / since / limit 过滤，超出上限拒绝', () => {
  const { sink } = makeSink()
  for (let index = 1; index <= 5; index += 1) {
    sink.append({
      accountId: ACCOUNT,
      cid: index % 2 === 0 ? 'even' : 'odd',
      messageId: 'm' + String(index),
      senderId: PEER,
      kind: 'text',
      text: 'x' + String(index),
      chatTimeMs: index * 1_000,
    })
  }
  assert.deepEqual(sink.list({ accountId: ACCOUNT, cid: 'odd' }).map((row) => row.messageId), ['m1', 'm3', 'm5'])
  const all = sink.list({ accountId: ACCOUNT })
  assert.deepEqual(sink.list({ accountId: ACCOUNT, since: all[2]!.id }).map((row) => row.messageId), ['m4', 'm5'])
  assert.equal(sink.list({ accountId: ACCOUNT, limit: 2 }).length, 2)
  expectCode('VALIDATION', () => sink.list({ accountId: ACCOUNT, limit: 0 }))
  expectCode('VALIDATION', () => sink.list({ accountId: ACCOUNT, limit: 501 }))
  expectCode('VALIDATION', () => sink.list({ accountId: ACCOUNT, since: -1 }))
  expectCode('VALIDATION', () => sink.list({ accountId: '  ' }))
})

test('tradeStatus 与 raw 往返；raw 坏掉不影响整条消息读出', () => {
  const { sink, store } = makeSink()
  sink.append({
    accountId: ACCOUNT,
    cid: 'c1',
    messageId: 'card-1',
    senderId: PEER,
    kind: 'card',
    text: '等待买家付款',
    chatTimeMs: 1_000,
    tradeStatus: 'awaiting_payment',
    raw: { '1': { '2': 'c1@goofish' } },
  })
  const [record] = sink.list({ accountId: ACCOUNT })
  assert.equal(record!.kind, 'card')
  assert.equal(record!.tradeStatus, 'awaiting_payment')
  assert.deepEqual(record!.raw, { '1': { '2': 'c1@goofish' } })

  sink.append({ accountId: ACCOUNT, cid: 'c1', messageId: 'card-2', senderId: PEER, kind: 'text', text: 'x', chatTimeMs: 2_000 })
  store.db.prepare("UPDATE im_messages SET raw = '不是 JSON' WHERE message_id = 'card-2'").run()
  const second = sink.list({ accountId: ACCOUNT })[1]!
  assert.equal(second.messageId, 'card-2')
  assert.equal('raw' in second, false, 'raw 坏掉时只是缺字段，消息本身仍可读')
})

test('参数校验：必填项、kind、时间戳、raw 形态', () => {
  const { sink } = makeSink()
  const valid = { accountId: ACCOUNT, cid: 'c1', messageId: 'm1', senderId: PEER, kind: 'text' as const, text: 'x', chatTimeMs: 1_000 }
  expectCode('VALIDATION', () => sink.append({ ...valid, accountId: '' }))
  expectCode('VALIDATION', () => sink.append({ ...valid, cid: ' ' }))
  expectCode('VALIDATION', () => sink.append({ ...valid, messageId: '' }))
  expectCode('VALIDATION', () => sink.append({ ...valid, senderId: '' }))
  expectCode('VALIDATION', () => sink.append({ ...valid, kind: 'image' as never }))
  expectCode('VALIDATION', () => sink.append({ ...valid, text: undefined as never }))
  expectCode('VALIDATION', () => sink.append({ ...valid, chatTimeMs: 0 }))
  expectCode('VALIDATION', () => sink.append({ ...valid, chatTimeMs: 1.5 }))
  expectCode('VALIDATION', () => sink.append({ ...valid, tradeStatus: 'paid' as never }))
  expectCode('VALIDATION', () => sink.append({ ...valid, raw: [] as never }))
  expectCode('VALIDATION', () => sink.append(null as never))
  expectCode('VALIDATION', () => sink.lastPeer(null as never))
  // 空正文是允许的（图片/卡片消息可能没有文本）
  assert.equal(sink.append({ ...valid, text: '' }), true)
})
