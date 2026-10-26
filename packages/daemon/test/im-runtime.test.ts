/**
 * IM 运行时测试：开关默认关闭、按账号拉起、回复按 accountId 路由、诊断状态、关闭清理。
 * 全部假件（fake mtop + fake ws + 内存凭据/消息库 + spy logger），不触网、不 sleep。
 * 每个用例都挂 after(stop)：断言失败时连接也必须关掉，否则残留定时器会把测试进程吊死。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'
import type { CredentialStore, Logger } from '@bigfish/core'

import { createImRuntime } from '../src/im-runtime.ts'
import type { ImRuntime } from '../src/im-runtime.ts'
import { createOperationPort } from '../src/operations.ts'
import { FakeSink, mtopQueue, okResponse, socketFactory, textPushFrame } from './im-harness.ts'
import type { MtopRecorder, SocketRecorder } from './im-harness.ts'
import type { MtopHttpResponse } from '@bigfish/channel-mtop'
import type { Session } from '../src/executors.ts'

const NOW = 1_700_000_000_000
const ACCOUNT_COOKIES: Record<string, string> = { unb: '2200000000001', _m_h5_tk: 'tk_1' }

/** 内存凭据库：按 accountId 查表，查不到的账号返回 undefined（等价于「没导入过登录态」）。 */
function fakeCredentials(records: Record<string, Record<string, string>>): CredentialStore {
  return {
    async load(accountId: string): Promise<unknown> {
      const cookies = records[accountId]
      if (cookies === undefined) return undefined
      return { accountId, cookies, updatedAt: NOW, meta: { deviceId: 'dev-1' } }
    },
    async save(): Promise<void> {},
    async list(): Promise<string[]> {
      return Object.keys(records)
    },
    async remove(): Promise<boolean> {
      return true
    },
  } as unknown as CredentialStore
}

interface Setup {
  runtime: ImRuntime
  mtop: MtopRecorder
  sockets: SocketRecorder
  sink: FakeSink
  warnings: Array<{ message: string; detail?: unknown }>
}

function makeRuntime(
  responses: ReadonlyArray<MtopHttpResponse | Error>,
  options: { enabled?: boolean; accounts?: Record<string, Record<string, string>> | undefined } = {},
): Setup {
  const mtop = mtopQueue(responses)
  const sockets = socketFactory()
  const sink = new FakeSink()
  const warnings: Array<{ message: string; detail?: unknown }> = []
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, detail?: unknown) => warnings.push({ message, detail }),
    error: () => undefined,
  } as unknown as Logger
  const accounts = options.accounts ?? { acc1: ACCOUNT_COOKIES }
  const runtime = createImRuntime({
    credentials: fakeCredentials(accounts),
    transport: mtop.transport,
    sink,
    enabled: options.enabled ?? true,
    webSocketFactory: sockets.factory,
    logger,
    now: () => NOW,
  })
  return { runtime, mtop, sockets, sink, warnings }
}

async function waitFor(predicate: () => boolean, label = '条件'): Promise<void> {
  for (let index = 0; index < 300; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('超时等待：' + label)
}

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof XianyuError && error.code === code
}

describe('createImRuntime', () => {
  it('默认关闭：startAll 不建连接，sendReply 抛 UNSUPPORTED 并要求 BF_IM', async (t) => {
    const setup = makeRuntime([okResponse({ accessToken: 'tok-1' })], { enabled: false })
    t.after(() => setup.runtime.stop())

    setup.runtime.startAll(['acc1'])
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(setup.sockets.sockets.length, 0)
    assert.deepEqual(setup.runtime.status(), [])

    await assert.rejects(
      setup.runtime.sendReply({ accountId: 'acc1', reply: { cid: 'cid-1', text: '在的' } }),
      (error: unknown) => error instanceof XianyuError && error.code === 'UNSUPPORTED' && /BF_IM/.test(error.message),
    )
  })

  it('开启后 startAll 拉起连接，status 报告 ready', async (t) => {
    const setup = makeRuntime([okResponse({ accessToken: 'tok-1' })])
    t.after(() => setup.runtime.stop())

    setup.runtime.startAll(['acc1'])
    await waitFor(() => setup.runtime.status()[0]?.state === 'ready', '账号进入 ready')

    assert.deepEqual(setup.runtime.status().map((entry) => entry.accountId), ['acc1'])
    assert.equal(setup.mtop.calls.length, 1)
    assert.equal(setup.sockets.sockets.length, 1)
  })

  it('回复按 accountId 路由：收到的买家消息决定收件人，出站帧发到同一条连接', async (t) => {
    const setup = makeRuntime([okResponse({ accessToken: 'tok-1' })])
    t.after(() => setup.runtime.stop())

    setup.runtime.startAll(['acc1'])
    await waitFor(() => setup.runtime.status()[0]?.state === 'ready', '账号进入 ready')

    const socket = setup.sockets.sockets[0]
    assert.ok(socket !== undefined)
    socket.emitMessage(textPushFrame({ cid: 'cid-1', messageId: 'm-1', sender: 'buyer-1', text: '还有货吗' }))
    await waitFor(() => setup.sink.lastPeer({ accountId: 'acc1', cid: 'cid-1' }) !== undefined, '买家消息落库')

    await setup.runtime.sendReply({ accountId: 'acc1', reply: { cid: 'cid-1', text: '在的，还有货' } })

    const sent = socket.sent.at(-1)
    assert.ok(sent !== undefined)
    const parsed = JSON.parse(sent) as Record<string, unknown>
    assert.equal(parsed['lwp'], '/r/MessageSend/sendByReceiverScope')
    // 出站也落库：messageId 以 out: 开头，sender 是账号自己
    const records = setup.sink.records.filter((record) => record.messageId.startsWith('out:'))
    assert.equal(records.length, 1)
    assert.equal(records[0]?.senderId, 'acc1')
  })

  it('一个账号没凭据：只告警不抛，其它账号照常起', async (t) => {
    const setup = makeRuntime([okResponse({ accessToken: 'tok-1' })], { accounts: { acc1: ACCOUNT_COOKIES } })
    t.after(() => setup.runtime.stop())

    setup.runtime.startAccount('acc1')
    setup.runtime.startAccount('acc-missing')
    await waitFor(
      () => setup.runtime.status().find((entry) => entry.accountId === 'acc-missing')?.state === 'blocked',
      '缺凭据的账号进入 blocked',
    )

    const missing = setup.runtime.status().find((entry) => entry.accountId === 'acc-missing')
    assert.equal(missing?.state, 'blocked')
    assert.match(missing?.lastError ?? '', /登录态|AUTH_EXPIRED|凭据/)
    await waitFor(
      () => setup.runtime.status().find((entry) => entry.accountId === 'acc1')?.state === 'ready',
      '有凭据的账号照常 ready',
    )
  })

  it('风控 blocked 时记录可人工处理的告警，并保持不重试', async (t) => {
    const setup = makeRuntime([okResponse({ url: 'https://www.goofish.com/punish?x=1' })])
    t.after(() => setup.runtime.stop())

    setup.runtime.startAll(['acc1'])
    await waitFor(() => setup.runtime.status()[0]?.state === 'blocked', '账号进入 blocked')

    const warning = setup.warnings.find((entry) => entry.message.includes('人工处理'))
    assert.ok(warning !== undefined)
    assert.match(JSON.stringify(warning.detail), /punish/)
    // 冷却期内不重试：没有建 socket
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(setup.sockets.sockets.length, 0)
  })

  it('stop 清空连接，status 变空，重复 stop 幂等', () => {
    const setup = makeRuntime([okResponse({ accessToken: 'tok-1' })])
    setup.runtime.startAll(['acc1'])
    setup.runtime.stop()
    setup.runtime.stop()
    assert.deepEqual(setup.runtime.status(), [])
  })
})

describe('operations 的 IM 网关接线', () => {
  const session: Session = { accountId: 'acc1', cookies: { unb: '2200000000001' } }

  it('注入网关后 sendReply 委托给它，并带上 accountId', async () => {
    const calls: Array<{ accountId: string; cid: string; text: string }> = []
    const ports = createOperationPort({
      im: {
        async sendReply(input) {
          calls.push({ accountId: input.accountId, cid: input.reply.cid, text: input.reply.text })
        },
      },
    })
    await ports.sendReply({ session, reply: { cid: 'cid-1', text: '在的' }, signal: new AbortController().signal })
    assert.deepEqual(calls, [{ accountId: 'acc1', cid: 'cid-1', text: '在的' }])
  })

  it('没注入网关时仍是 UNSUPPORTED（提 BF_IM），不会假装发送成功', async () => {
    const ports = createOperationPort({})
    await assert.rejects(
      ports.sendReply({ session, reply: { cid: 'cid-1', text: 'x' }, signal: new AbortController().signal }),
      (error: unknown) => error instanceof XianyuError && error.code === 'UNSUPPORTED' && /BF_IM/.test(error.message),
    )
  })
})
