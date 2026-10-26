/**
 * IM 客户端测试：握手/落库/回复/风控/断线重连。
 * 全部假件（fake mtop + fake ws + fake clock + 内存消息库），不触网、不 sleep。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { IM_UA } from '@bigfish/channel-im'
import { XianyuError } from '@bigfish/core'

import { ImClient } from '../src/im-client.ts'
import type { ImClientEvent } from '../src/im-client.ts'
import type { ImTokenSession } from '../src/im-token.ts'
import { stableImDeviceId } from '../src/im-token.ts'
import {
  FakeClock,
  FakeSink,
  mtopQueue,
  okResponse,
  socketFactory,
  textPushFrame,
} from './im-harness.ts'
import type { MtopRecorder, SocketRecorder } from './im-harness.ts'
import type { MtopHttpResponse } from '@bigfish/channel-mtop'

const NOW = 1_700_000_000_000

const SESSION: ImTokenSession = {
  accountId: 'acc1',
  cookies: { unb: '2200000000001', _m_h5_tk: 'tk_1700000000000' },
}

interface Setup {
  client: ImClient
  clock: FakeClock
  mtop: MtopRecorder
  sockets: SocketRecorder
  sink: FakeSink
  events: ImClientEvent[]
}

function makeClient(
  responses: ReadonlyArray<MtopHttpResponse | Error>,
  options: { session?: ImTokenSession | undefined } = {},
): Setup {
  const clock = new FakeClock(NOW)
  const mtop = mtopQueue(responses)
  const sockets = socketFactory()
  const sink = new FakeSink()
  const events: ImClientEvent[] = []
  const session = 'session' in options ? options.session : SESSION
  const client = new ImClient({
    accountId: 'acc1',
    transport: mtop.transport,
    sink,
    loadSession: async () => session,
    webSocketFactory: sockets.factory,
    clock,
    now: () => clock.now(),
    onEvent: (event) => events.push(event),
  })
  return { client, clock, mtop, sockets, sink, events }
}

async function waitFor(predicate: () => boolean, label = '条件'): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('超时等待：' + label)
}

async function readyClient(responses: ReadonlyArray<MtopHttpResponse | Error>): Promise<Setup> {
  const setup = makeClient(responses)
  setup.client.start()
  await waitFor(() => setup.client.state === 'ready', '客户端进入 ready')
  return setup
}

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof XianyuError && error.code === code
}

describe('ImClient 握手', () => {
  it('取 token → 建 ws（带 cookie/UA/Origin）→ 发 /reg → ready', async () => {
    const setup = await readyClient([okResponse({ accessToken: 'tok-1' })])

    assert.equal(setup.mtop.calls.length, 1)
    assert.equal(setup.sockets.sockets.length, 1)
    const socket = setup.sockets.sockets[0]
    assert.ok(socket !== undefined)
    assert.match(socket.headers['cookie'] ?? '', /unb=2200000000001/)
    assert.equal(socket.headers['user-agent'], IM_UA)
    assert.equal(socket.headers['origin'], 'https://www.goofish.com')

    const reg = setup.sockets.sockets[0]?.sent[0]
    assert.ok(reg !== undefined, 'ws open 后必须先发 /reg')
    const parsed: unknown = JSON.parse(reg)
    assert.equal((parsed as Record<string, unknown>)['lwp'], '/reg')

    // deviceId 必须和 token 请求里的一致
    const tokenCall = setup.mtop.calls[0]
    assert.ok(tokenCall !== undefined)
    const tokenData = JSON.parse(decodeURIComponent(tokenCall.body.slice('data='.length))) as Record<string, unknown>
    assert.equal(tokenData['deviceId'], stableImDeviceId('acc1'))
    setup.client.stop()
  })

  it('没有凭据 → blocked（AUTH_EXPIRED 等人工重新导入，不重试）', async () => {
    const setup = makeClient([], { session: undefined })
    setup.client.start()
    await waitFor(() => setup.client.state === 'blocked', '客户端进入 blocked')
    assert.equal(setup.mtop.calls.length, 0, '没有凭据就不该发取 token 请求')
    await assert.rejects(setup.client.ensureReady(), isCode('AUTH_EXPIRED'))
    setup.client.stop()
  })
})

describe('ImClient 收消息', () => {
  it('买家消息落库，fromSelf=false，且发 message 事件', async () => {
    const setup = await readyClient([okResponse({ accessToken: 'tok-1' })])
    const socket = setup.sockets.sockets[0]
    assert.ok(socket !== undefined)

    socket.emitMessage(textPushFrame({ cid: 'cid-1', messageId: 'msg-1', sender: 'buyer-1', text: '还有货吗' }))
    await waitFor(() => setup.sink.records.length === 1, '消息落库')

    const record = setup.sink.records[0]
    assert.ok(record !== undefined)
    assert.equal(record.cid, 'cid-1')
    assert.equal(record.senderId, 'buyer-1')
    assert.equal(record.text, '还有货吗')
    assert.equal(record.fromSelf, false)
    assert.equal(record.kind, 'text')
    assert.equal(setup.events.filter((event) => event.type === 'message').length, 1)
    setup.client.stop()
  })

  it('同 messageId 重推（重连补历史）只落一次，事件仍上报', async () => {
    const setup = await readyClient([okResponse({ accessToken: 'tok-1' })])
    const socket = setup.sockets.sockets[0]
    assert.ok(socket !== undefined)
    const frame = textPushFrame({ cid: 'cid-1', messageId: 'msg-1' })

    socket.emitMessage(frame)
    socket.emitMessage(frame)
    await waitFor(() => setup.events.filter((event) => event.type === 'message').length === 2, '两条事件')

    assert.equal(setup.sink.records.length, 1, '同一个服务端 messageId 不能落两条')
    setup.client.stop()
  })
})

describe('ImClient 发回复', () => {
  it('会话里没有对方消息 → VALIDATION（取不到收件人，不瞎发）', async () => {
    const setup = await readyClient([okResponse({ accessToken: 'tok-1' })])
    await assert.rejects(
      setup.client.sendReply({ cid: 'cid-1', text: '在的' }),
      (error: unknown) => error instanceof XianyuError && error.code === 'VALIDATION' && /收件人/.test(error.message),
    )
    setup.client.stop()
  })

  it('有对方消息后回复：帧带 cid/收件人/文本，并记一条出站消息', async () => {
    const setup = await readyClient([okResponse({ accessToken: 'tok-1' })])
    const socket = setup.sockets.sockets[0]
    assert.ok(socket !== undefined)
    socket.emitMessage(textPushFrame({ cid: 'cid-1', messageId: 'msg-1', sender: 'buyer-1' }))
    await waitFor(() => setup.sink.records.length === 1, '买家消息落库')

    await setup.client.sendReply({ cid: 'cid-1', text: '在的，还有货' })

    const frame = socket.lastFrame()
    assert.equal(frame['lwp'], '/r/MessageSend/sendByReceiverScope')
    const body = frame['body'] as unknown[]
    const message = body[0] as Record<string, unknown>
    const receivers = body[1] as Record<string, unknown>
    assert.equal(message['cid'], 'cid-1@goofish')
    assert.equal(message['conversationType'], 1, '单聊会话')
    assert.deepEqual(receivers['actualReceivers'], ['buyer-1@goofish', 'acc1@goofish'])

    const outbound = setup.sink.records.at(-1)
    assert.ok(outbound !== undefined)
    assert.equal(outbound.fromSelf, true)
    assert.equal(outbound.text, '在的，还有货')
    assert.ok(outbound.messageId.startsWith('out:'), '出站消息用本地 uuid 标记，避免和服务端 id 撞键')
    setup.client.stop()
  })

  it('signal 已中止 → 直接 NETWORK，不产生任何帧', async () => {
    const setup = await readyClient([okResponse({ accessToken: 'tok-1' })])
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(setup.client.sendReply({ cid: 'cid-1', text: 'x' }, controller.signal), isCode('NETWORK'))
    setup.client.stop()
  })
})

describe('ImClient 风控与重连', () => {
  it('取 token 命中风控 → blocked + challenge 事件，不自动重连', async () => {
    const setup = makeClient([okResponse({ url: 'https://example.invalid/punish' })])
    setup.client.start()
    await waitFor(() => setup.client.state === 'blocked', '客户端进入 blocked')

    const challenge = setup.events.find((event) => event.type === 'challenge')
    assert.ok(challenge !== undefined && challenge.type === 'challenge')
    assert.equal(challenge.code, 'RISK_CONTROL')
    assert.equal(challenge.punishUrl, 'https://example.invalid/punish')

    await assert.rejects(
      setup.client.ensureReady(),
      (error: unknown) => error instanceof XianyuError && error.code === 'RISK_CONTROL' && error.retryable === false,
    )
    setup.clock.advance(10 * 60_000)
    assert.equal(setup.mtop.calls.length, 1, '风控必须等人工，不能退避重试')
    assert.equal(setup.sockets.sockets.length, 0)
    setup.client.stop()
  })

  it('连接断开 → 退避 60s 后重新取 token 并重建连接', async () => {
    const setup = await readyClient([
      okResponse({ accessToken: 'tok-1' }),
      okResponse({ accessToken: 'tok-2' }),
    ])
    const first = setup.sockets.sockets[0]
    assert.ok(first !== undefined)

    first.emitClose(1006)
    await waitFor(() => setup.client.state === 'backoff', '进入 backoff')
    const reconnect = setup.events.filter((event) => event.type === 'reconnect').at(-1)
    assert.ok(reconnect !== undefined && reconnect.type === 'reconnect')
    assert.equal(reconnect.attempt, 1)
    assert.equal(reconnect.delayMs, 60_000)

    setup.clock.advance(60_000)
    await waitFor(() => setup.client.state === 'ready', '重连后回到 ready')
    assert.equal(setup.mtop.calls.length, 2, '重连必须重新取 token（token 一次性）')
    assert.equal(setup.sockets.sockets.length, 2, '每次重连都新建 ws，不复活旧的')
    setup.client.stop()
  })

  it('stop 后 ensureReady 立刻 NETWORK，且不再新建连接', async () => {
    const setup = await readyClient([okResponse({ accessToken: 'tok-1' })])
    setup.client.stop()
    assert.equal(setup.client.state, 'closed')
    await assert.rejects(setup.client.ensureReady(), isCode('NETWORK'))
    setup.clock.advance(600_000)
    assert.equal(setup.mtop.calls.length, 1)
    setup.client.stop()
  })
})
