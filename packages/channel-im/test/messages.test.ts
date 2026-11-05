import test from 'node:test'
import assert from 'node:assert/strict'
import { parseImMessage, parsePushMessages } from '../src/messages.ts'
import { decodePushItems } from '../src/messages.ts'
import { encodeMsgpack } from './msgpack-codec.ts'

const NOW = 1_700_000_000_123

/** 构造一条标准聊天消息的推送对象（形态照抄 docs/im-protocol.md §3.3）。 */
function textPayload(options: {
  cid?: string
  messageId?: string
  chatTimeMs?: number
  sender?: string
  body?: unknown
  channel?: Record<string, unknown>
} = {}): Record<string, unknown> {
  return {
    '1': {
      '2': options.cid ?? 'cid-1@goofish',
      '3': options.messageId ?? 'msg-1',
      '5': options.chatTimeMs ?? NOW,
      '6': { '3': { '5': options.body ?? JSON.stringify({ text: { text: '你好' } }) } },
      '10': { reminderContent: '买家发来消息', senderUserId: (options.sender ?? 'buyer-1') + '@goofish' },
    },
    '3': options.channel ?? {},
  }
}

/** 构造一条卡片消息的推送对象。 */
function cardPayload(): Record<string, unknown> {
  return {
    '1': {
      '1': { '1': 'seller-2' },
      '2': 'cid-2@goofish',
      '3': 'msg-2',
      '5': NOW,
      '6': { '3': { '2': '卡片标题' } },
    },
  }
}

/** 把若干消息对象包成 syncPushPackage 推送帧（每项 data 是 base64(JSON)）。 */
function pushFrame(payloads: unknown[]): Record<string, unknown> {
  return {
    lwp: 'sync',
    body: {
      syncPushPackage: {
        data: payloads.map((payload) => ({
          data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
        })),
      },
    },
  }
}

/** 把若干消息对象包成 syncPushPackage 推送帧（每项 data 是 base64(MessagePack)，真机聊天推送形态）。 */
function msgpackFrame(payloads: unknown[]): Record<string, unknown> {
  return {
    lwp: 'sync',
    body: {
      syncPushPackage: {
        data: payloads.map((payload) => ({ data: Buffer.from(encodeMsgpack(payload)).toString('base64') })),
      },
    },
  }
}

test('标准聊天消息归一化：cid 去后缀、发送者、文本、毫秒时间戳', () => {
  const payload = textPayload()
  const messages = parsePushMessages(pushFrame([payload]))
  assert.equal(messages.length, 1)
  const message = messages[0]
  assert.ok(message !== undefined)
  assert.equal(message.kind, 'text')
  assert.equal(message.cid, 'cid-1')
  assert.equal(message.messageId, 'msg-1')
  assert.equal(message.senderId, 'buyer-1')
  assert.equal(message.text, '你好')
  assert.equal(message.chatTimeMs, NOW)
  assert.deepEqual(message.raw, payload, 'raw 保留原始对象用于落库/排障')
  assert.equal(message.tradeStatus, undefined)
})

test('交易状态只看 redReminder 文案映射，未知文案保持 undefined', () => {
  const cases: Array<[string, string | undefined]> = [
    ['等待买家付款', 'awaiting_payment'],
    ['交易成功', 'awaiting_shipment'],
    ['交易关闭', 'closed'],
    ['其它文案', undefined],
  ]
  for (const [reminder, expected] of cases) {
    const messages = parsePushMessages(pushFrame([textPayload({ channel: { redReminder: reminder } })]))
    assert.equal(messages[0]?.tradeStatus, expected, reminder)
  }
})

test('文本兼容纯文本、明文 JSON、旧 base64(JSON) 三种形态', () => {
  const plain = parsePushMessages(pushFrame([textPayload({ body: '在吗' })]))
  assert.equal(plain[0]?.text, '在吗')
  const legacy = Buffer.from(JSON.stringify({ text: { text: '旧格式' } }), 'utf8').toString('base64')
  const legacyMessages = parsePushMessages(pushFrame([textPayload({ body: legacy })]))
  assert.equal(legacyMessages[0]?.text, '旧格式')
})

test('卡片消息：kind card、文本取 ["6"]["3"]["2"]、发送者取 ["1"]["1"]["1"]', () => {
  const messages = parsePushMessages(pushFrame([cardPayload()]))
  assert.equal(messages.length, 1)
  const message = messages[0]
  assert.ok(message !== undefined)
  assert.equal(message.kind, 'card')
  assert.equal(message.cid, 'cid-2')
  assert.equal(message.messageId, 'msg-2')
  assert.equal(message.senderId, 'seller-2')
  assert.equal(message.text, '卡片标题')
})

test('系统提示（解出对象含 chatType）直接丢弃', () => {
  const systemTip = { chatType: 'sys', content: '对方已读' }
  assert.deepEqual(parsePushMessages(pushFrame([systemTip])), [])
  assert.deepEqual(decodePushItems(pushFrame([systemTip])), [])
})

test('坏 base64 / 非消息 JSON / 缺信封的消息跳过，不抛', () => {
  const broken = { lwp: 'sync', body: { syncPushPackage: { data: [{ data: '!!!' }, { data: 123 }] } } }
  assert.deepEqual(parsePushMessages(broken), [])
  assert.deepEqual(parsePushMessages(pushFrame([{ foo: 'bar' }])), [])
  const missingEnvelope = textPayload()
  const main = missingEnvelope['1'] as Record<string, unknown>
  delete main['3']
  assert.deepEqual(parsePushMessages(pushFrame([missingEnvelope])), [], '缺 messageId 视为未知帧')
})

test('一帧多消息保持推送顺序，坏数据只跳过自己', () => {
  const messages = parsePushMessages(pushFrame([textPayload(), { foo: 'bar' }, cardPayload()]))
  assert.equal(messages.length, 2)
  assert.deepEqual(messages.map((message) => message.kind), ['text', 'card'])
})

test('非推送帧返回空列表，parseImMessage 面对垃圾输入返回 undefined', () => {
  assert.deepEqual(parsePushMessages(undefined), [])
  assert.deepEqual(parsePushMessages({}), [])
  assert.deepEqual(parsePushMessages({ body: {} }), [])
  for (const bad of [undefined, null, 123, 'text', [], {}]) {
    assert.equal(parseImMessage(bad), undefined)
  }
  assert.equal(parseImMessage({ '1': { '2': 'cid' } }), undefined, '缺 messageId/时间戳视为未知帧')
})
test('真机形态的 MessagePack 卡片消息：kind card、摘要文本、tradeStatus 取 main["10"].redReminder', () => {
  const payload = {
    '1': {
      '1': { '1': '3149637063@goofish' },
      '2': '47983389096@goofish',
      '3': '3416565274542.PNM',
      '5': 1_742_458_817_389,
      '6': {
        '1': 101,
        '3': { '1': '', '2': '[我已拍下，待付款]', '3': '', '4': 26, '5': JSON.stringify({ contentType: 26, dxCard: {} }) },
      },
      '10': { senderUserId: '3149637063', redReminder: '等待买家付款', reminderContent: '[我已拍下，待付款]' },
    },
    '3': { needPush: 'true' },
  }
  const messages = parsePushMessages(msgpackFrame([payload]))
  assert.equal(messages.length, 1)
  const message = messages[0]
  assert.ok(message !== undefined)
  assert.equal(message.kind, 'card')
  assert.equal(message.cid, '47983389096')
  assert.equal(message.messageId, '3416565274542.PNM')
  assert.equal(message.senderId, '3149637063')
  assert.equal(message.text, '[我已拍下，待付款]', '卡片取 ["6"]["3"]["2"] 摘要，不是 dxCard JSON')
  assert.equal(message.chatTimeMs, 1_742_458_817_389)
  assert.equal(message.tradeStatus, 'awaiting_payment')
})

test('MessagePack 文本消息：内层类型 1 → kind text，正文取 ["6"]["3"]["5"]', () => {
  const payload = {
    '1': {
      '2': 'cid-9@goofish',
      '3': 'msg-9',
      '5': NOW,
      '6': { '1': 101, '3': { '4': 1, '5': JSON.stringify({ contentType: 1, text: { text: '在吗，还能便宜点吗' } }) } },
      '10': { senderUserId: 'buyer-9', reminderContent: '在吗，还能便宜点吗' },
    },
  }
  const messages = parsePushMessages(msgpackFrame([payload]))
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.kind, 'text')
  assert.equal(messages[0]?.text, '在吗，还能便宜点吗')
  assert.equal(messages[0]?.senderId, 'buyer-9')
  assert.deepEqual(messages[0]?.raw, payload, 'raw 保留 MessagePack 解出的对象')
})

test('同一帧里 base64(JSON) 与 base64(MessagePack) 混排保持顺序', () => {
  const frame = {
    lwp: 'sync',
    body: {
      syncPushPackage: {
        data: [
          { data: Buffer.from(JSON.stringify(textPayload()), 'utf8').toString('base64') },
          { data: Buffer.from(encodeMsgpack(cardPayload())).toString('base64') },
        ],
      },
    },
  }
  const messages = parsePushMessages(frame)
  assert.deepEqual(messages.map((message) => message.messageId), ['msg-1', 'msg-2'])
})
