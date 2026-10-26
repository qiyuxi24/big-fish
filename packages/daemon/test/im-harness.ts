/**
 * IM 测试替身：假时钟 / 假 mtop 传输 / 假 WebSocket / 假消息库。
 * 注意：本文件不是 *.test.ts，不会被 scripts/test-all.mjs 直接加载。
 */
import type { ImClock } from '@bigfish/channel-im'
import type { MtopHttpRequest, MtopHttpResponse, MtopTransport } from '@bigfish/channel-mtop'
import type { ImMessageInput, ImMessageQuery, ImMessageRecord, ImMessageSink } from '@bigfish/core'

import type { WebSocketFactory, WebSocketLike } from '../src/im-transport.ts'

/** 假时钟：advance 按到期时间顺序执行，回调里新排的定时器也会执行。 */
export class FakeClock implements ImClock {
  #now: number
  #sequence = 0
  readonly #timers = new Map<number, { at: number; callback: () => void }>()

  constructor(startMs = 1_700_000_000_000) {
    this.#now = startMs
  }

  now(): number {
    return this.#now
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.#sequence += 1
    const id = this.#sequence
    this.#timers.set(id, { at: this.#now + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.#timers.delete(handle)
  }

  advance(delayMs: number): void {
    const target = this.#now + delayMs
    for (;;) {
      let next: { id: number; at: number; callback: () => void } | undefined
      for (const [id, timer] of this.#timers) {
        if (timer.at > target) continue
        if (next === undefined || timer.at < next.at || (timer.at === next.at && id < next.id)) {
          next = { id, at: timer.at, callback: timer.callback }
        }
      }
      if (next === undefined) break
      this.#timers.delete(next.id)
      this.#now = next.at
      next.callback()
    }
    this.#now = target
  }

  get pendingTimers(): number {
    return this.#timers.size
  }
}

/** 成功响应：ret=SUCCESS，data 原样塞进 mtop 外层。 */
export function okResponse(data: unknown): MtopHttpResponse {
  return { status: 200, headers: {}, text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data }) }
}

export interface MtopRecorder {
  transport: MtopTransport
  calls: MtopHttpRequest[]
}

/** 按调用顺序回放响应；用尽即报错，顺带抓「多发了请求没人发现」。 */
export function mtopQueue(responses: ReadonlyArray<MtopHttpResponse | Error>): MtopRecorder {
  const calls: MtopHttpRequest[] = []
  const transport: MtopTransport = {
    request: async (request) => {
      calls.push(request)
      const next = responses[calls.length - 1]
      if (next === undefined) throw new Error('fake mtop 响应已用尽：调用方多发了请求')
      if (next instanceof Error) throw next
      return next
    },
  }
  return { transport, calls }
}

type Listener = (event: unknown) => void

/** 假 WebSocket：构造后下一拍自动 open（模拟真实握手），可手动制造下行/关闭。 */
export class FakeSocket implements WebSocketLike {
  readonly url: string
  readonly headers: Record<string, string>
  readonly sent: string[] = []
  closed = false
  readonly #listeners = new Map<string, Listener[]>()

  constructor(url: string, headers: Record<string, string>) {
    this.url = url
    this.headers = headers
    setTimeout(() => this.emitOpen(), 0)
  }

  send(data: string): void {
    if (this.closed) throw new Error('socket 已关闭')
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type)
    if (list === undefined) this.#listeners.set(type, [listener])
    else list.push(listener)
  }

  emitOpen(): void {
    this.#emit('open', {})
  }

  emitMessage(data: unknown): void {
    this.#emit('message', { data })
  }

  emitClose(code = 1006): void {
    this.#emit('close', { code })
  }

  emitError(): void {
    this.#emit('error', {})
  }

  /** 已发出的帧按 JSON 解析，取最后一条。 */
  lastFrame(): Record<string, unknown> {
    const last = this.sent.at(-1)
    if (last === undefined) return {}
    const parsed: unknown = JSON.parse(last)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  }

  #emit(type: string, event: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event)
  }
}

export interface SocketRecorder {
  factory: WebSocketFactory
  sockets: FakeSocket[]
}

export function socketFactory(): SocketRecorder {
  const sockets: FakeSocket[] = []
  return {
    sockets,
    factory: (url, headers) => {
      const socket = new FakeSocket(url, headers)
      sockets.push(socket)
      return socket
    },
  }
}

/** 假消息库：内存去重 + 按时间线读，行为对齐 createImMessageRepository。 */
export class FakeSink implements ImMessageSink {
  readonly records: ImMessageRecord[] = []
  readonly #seen = new Set<string>()

  append(input: ImMessageInput): boolean {
    const key = input.accountId + '\u0000' + input.messageId
    if (this.#seen.has(key)) return false
    this.#seen.add(key)
    this.records.push({
      id: this.records.length + 1,
      accountId: input.accountId,
      cid: input.cid,
      messageId: input.messageId,
      senderId: input.senderId,
      kind: input.kind,
      text: input.text,
      chatTimeMs: input.chatTimeMs,
      receivedAt: input.chatTimeMs,
      fromSelf: input.senderId === input.accountId,
      ...(input.tradeStatus === undefined ? {} : { tradeStatus: input.tradeStatus }),
      ...(input.raw === undefined ? {} : { raw: input.raw }),
    })
    return true
  }

  list(query: ImMessageQuery): ImMessageRecord[] {
    const since = query.since ?? 0
    const limit = query.limit ?? 100
    return this.records
      .filter((record) => record.accountId === query.accountId && record.id > since)
      .filter((record) => (query.cid === undefined ? true : record.cid === query.cid))
      .slice(0, limit)
  }

  lastPeer(input: { accountId: string; cid: string }): string | undefined {
    const candidates = this.records.filter(
      (record) => record.accountId === input.accountId && record.cid === input.cid && record.senderId !== input.accountId,
    )
    return candidates.at(-1)?.senderId
  }

  count(accountId: string): number {
    return this.records.filter((record) => record.accountId === accountId).length
  }
}

/** 构造一条标准文本推送帧（形态见 docs/im-protocol.md §3.3）。 */
export function textPushFrame(options: {
  cid?: string
  messageId?: string
  chatTimeMs?: number
  sender?: string
  text?: string
  reminder?: string
} = {}): string {
  const payload = {
    '1': {
      '2': (options.cid ?? 'cid-1') + '@goofish',
      '3': options.messageId ?? 'msg-1',
      '5': options.chatTimeMs ?? 1_700_000_000_000,
      '6': { '3': { '5': JSON.stringify({ text: { text: options.text ?? '还有货吗' } }) } },
      '10': { reminderContent: '买家发来消息', senderUserId: (options.sender ?? 'buyer-1') + '@goofish' },
    },
    '3': options.reminder === undefined ? {} : { redReminder: options.reminder },
  }
  return JSON.stringify({
    lwp: 'sync',
    body: {
      syncPushPackage: {
        data: [{ data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') }],
      },
    },
  })
}
