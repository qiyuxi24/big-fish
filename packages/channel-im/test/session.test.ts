import test from 'node:test'
import assert from 'node:assert/strict'
import { XianyuError } from '@bigfish/core'
import {
  ACK_DIFF_LWP,
  HEARTBEAT_LWP,
  REG_LWP,
  buildAckDiffFrame,
  readPath,
} from '../src/frames.ts'
import { ImSession } from '../src/session.ts'
import type { ImSessionOptions, ImSessionState } from '../src/session.ts'
import { FakeClock, FakeTransport } from './harness.ts'
import type { ImChatMessage } from '../src/messages.ts'
import type { ImFrame } from '../src/frames.ts'

interface Harness {
  session: ImSession
  clock: FakeClock
  transport: FakeTransport
  messages: ImChatMessage[]
  errors: XianyuError[]
  states: ImSessionState[]
  unknown: ImFrame[]
  sentAtMessage: number[]
}

function createSession(options: Omit<ImSessionOptions, 'transport' | 'clock'> = {}): Harness {
  const clock = new FakeClock()
  const transport = new FakeTransport()
  const messages: ImChatMessage[] = []
  const errors: XianyuError[] = []
  const states: ImSessionState[] = []
  const unknown: ImFrame[] = []
  const sentAtMessage: number[] = []
  const session = new ImSession({
    ...options,
    transport,
    clock,
    onMessage: (message) => {
      sentAtMessage.push(transport.sent.length)
      messages.push(message)
    },
    onUnknownFrame: (frame) => {
      unknown.push(frame)
    },
    onError: (error) => {
      errors.push(error)
    },
    onStateChange: (state) => {
      states.push(state)
    },
  })
  return { session, clock, transport, messages, errors, states, unknown, sentAtMessage }
}

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, code)
    return true
  })
}

/** 一条可被识别为标准聊天消息的下行推送帧文本。 */
function inboundText(mid = 'down-1', sid = 'sid-1'): string {
  const message = {
    '1': {
      '2': 'cid-1@goofish',
      '3': 'msg-1',
      '5': 1_700_000_000_123,
      '6': { '3': { '5': JSON.stringify({ text: { text: '在吗' } }) } },
      '10': { reminderContent: '买家发来消息', senderUserId: 'buyer-1@goofish' },
    },
    '3': {},
  }
  const frame = {
    lwp: 'sync',
    headers: { mid, sid },
    body: {
      syncPushPackage: {
        data: [{ data: Buffer.from(JSON.stringify(message), 'utf8').toString('base64') }],
      },
    },
  }
  return JSON.stringify(frame)
}

test('start 发 /reg 并进入 handshaking', () => {
  const h = createSession()
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  assert.equal(h.session.state, 'handshaking')
  assert.deepEqual(h.states, ['handshaking'])
  assert.equal(h.transport.sent.length, 1)
  const reg = h.transport.framesOfLwp(REG_LWP)[0]
  assert.ok(reg !== undefined)
  assert.equal(readPath(reg, ['headers', 'token']), 'token-1')
  assert.equal(readPath(reg, ['headers', 'did']), 'device-1')
})

test('confirmRegistered：registered 后 1s 发 ackDiff，pts 用当前时钟', () => {
  const h = createSession()
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  h.session.confirmRegistered()
  assert.equal(h.session.state, 'registered')
  assert.deepEqual(h.states, ['handshaking', 'registered'])
  assert.equal(h.transport.framesOfLwp(ACK_DIFF_LWP).length, 0, '1s 内不应提前提交游标')
  h.clock.advance(999)
  assert.equal(h.transport.framesOfLwp(ACK_DIFF_LWP).length, 0)
  h.clock.advance(1)
  const frames = h.transport.framesOfLwp(ACK_DIFF_LWP)
  assert.equal(frames.length, 1)
  const expected = buildAckDiffFrame({ nowMs: h.clock.now() })
  const first = frames[0]
  assert.ok(first !== undefined)
  assert.deepEqual(first.body, expected.body)
})

test('注册后心跳按 15s 间隔触发，ackDiff 之后才开始', () => {
  const h = createSession()
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  h.session.confirmRegistered()
  h.clock.advance(1_000)
  assert.equal(h.transport.framesOfLwp(ACK_DIFF_LWP).length, 1)
  h.clock.advance(14_999)
  assert.equal(h.transport.framesOfLwp(HEARTBEAT_LWP).length, 0)
  h.clock.advance(1)
  assert.equal(h.transport.framesOfLwp(HEARTBEAT_LWP).length, 1)
  h.clock.advance(15_000)
  assert.equal(h.transport.framesOfLwp(HEARTBEAT_LWP).length, 2)
  assert.deepEqual(h.states, ['handshaking', 'registered'])
})

test('下行先回 ACK 再回调业务消息', () => {
  const h = createSession()
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  h.transport.receive(inboundText())
  assert.equal(h.messages.length, 1)
  assert.equal(h.messages[0]?.text, '在吗')
  const sent = h.transport.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
  assert.equal(sent.length, 2, '一条 /reg + 一条 ACK')
  assert.deepEqual(sent[1], { code: 200, headers: { mid: 'down-1', sid: 'sid-1' } })
  assert.equal(h.sentAtMessage[0], 2, '回调时 ACK 已经发出')
})

test('未知帧：回 ACK、走 onUnknownFrame、不迁移状态、不报错', () => {
  const h = createSession()
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  h.transport.receive(JSON.stringify({ lwp: '/r/SomethingElse', headers: { mid: 'other-1' } }))
  assert.equal(h.unknown.length, 1)
  assert.equal(h.unknown[0]?.lwp, '/r/SomethingElse')
  assert.equal(h.errors.length, 0)
  assert.equal(h.session.state, 'handshaking')
  assert.equal(h.transport.sent.length, 2)
})

test('非法 JSON 上行只上报 VALIDATION，连接状态不变', () => {
  const h = createSession()
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  h.transport.receive('not-json')
  assert.equal(h.errors.length, 1)
  assert.equal(h.errors[0]?.code, 'VALIDATION')
  assert.equal(h.session.lastError?.code, 'VALIDATION')
  assert.equal(h.session.state, 'handshaking')
})

test('状态机非法操作一律 VALIDATION', () => {
  const h = createSession()
  expectCode(() => h.session.confirmRegistered(), 'VALIDATION')
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  expectCode(() => h.session.start({ accessToken: 'token-1', deviceId: 'device-1' }), 'VALIDATION')
  expectCode(() => h.session.start(null), 'VALIDATION')
})

test('disconnect 进入 disconnected 且可重新 start（新传输）', () => {
  const h = createSession()
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  h.session.disconnect('网络抖动')
  assert.equal(h.session.state, 'disconnected')
  assert.equal(h.session.lastError?.code, 'NETWORK')
  assert.equal(h.transport.closed, true)
  // 模拟适配器重连：真实实现会新建 ws，这里把假传输复位。
  h.transport.closed = false
  h.session.start({ accessToken: 'token-2', deviceId: 'device-1' })
  assert.equal(h.session.state, 'handshaking')
  assert.equal(h.transport.framesOfLwp(REG_LWP).length, 2)
  assert.deepEqual(h.states, ['handshaking', 'disconnected', 'handshaking'])
})

test('心跳发送失败 → disconnected + NETWORK，定时器不再续', () => {
  const h = createSession()
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  h.session.confirmRegistered()
  h.clock.advance(1_000)
  assert.equal(h.transport.framesOfLwp(ACK_DIFF_LWP).length, 1)
  h.transport.failNextSend = 'socket closed'
  h.clock.advance(15_000)
  assert.equal(h.session.state, 'disconnected')
  assert.equal(h.session.lastError?.code, 'NETWORK')
  assert.equal(h.clock.pendingTimers, 0)
})

test('start 发送失败抛 NETWORK 并落到 disconnected', () => {
  const h = createSession()
  h.transport.failNextSend = 'ws connect failed'
  expectCode(() => h.session.start({ accessToken: 'token-1', deviceId: 'device-1' }), 'NETWORK')
  assert.equal(h.session.state, 'disconnected')
})

test('close 是终态：清定时器、关传输、之后下行帧不再处理', () => {
  const h = createSession()
  h.session.start({ accessToken: 'token-1', deviceId: 'device-1' })
  h.session.confirmRegistered()
  h.clock.advance(1_000)
  const sentBefore = h.transport.sent.length
  h.session.close()
  assert.equal(h.session.state, 'closed')
  assert.equal(h.transport.closed, true)
  assert.equal(h.clock.pendingTimers, 0)
  h.transport.receive(inboundText())
  h.clock.advance(100_000)
  assert.equal(h.transport.sent.length, sentBefore, '关闭后不再发任何帧')
  assert.equal(h.messages.length, 0)
  h.session.close()
  assert.equal(h.session.state, 'closed')
})