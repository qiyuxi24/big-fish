/**
 * 单账号 IM 客户端：取 token → 连 ws → 注册 → 收消息落库 / 发文本回复 → 断线退避重连。
 *
 * 分层意图（AGENTS.md 不变量 1「日常动作不经过模型」）：
 * - 这一层只管「连上、活着、把消息放进库、把给定文本发出去」，不做任何判断/生成；
 * - 回复文本从哪来是上层的事（规则引擎或 agent），客户端只保证「发一次且只发一次」。
 * 硬边界：
 * - 风控/登录失效 → 进入 blocked，不自动重试（冷却必须由人工解除，见 docs/im-protocol.md §4、§5）；
 * - 断线 → 指数退避重连，重连必然重新取 token + 重新 /reg（token 一次性，§0）。
 * @module @bigfish/daemon/im-client
 */

import { randomUUID } from 'node:crypto'

import { IM_UA, IM_WS_URL, ImSession, buildSendMessageFrame } from '@bigfish/channel-im'
import type { ImChatMessage, ImClock, ImTransport } from '@bigfish/channel-im'
import type { MtopTransport } from '@bigfish/channel-mtop'
import { XianyuError, fail, toXianyuError } from '@bigfish/core'
import type { ImMessageSink, Logger } from '@bigfish/core'

import type { ReplyRequest } from './executors.ts'
import { fetchImAccessToken, stableImDeviceId } from './im-token.ts'
import type { ImTokenSession } from './im-token.ts'
import { createImTransport } from './im-transport.ts'
import type { ImConnection, WebSocketFactory } from './im-transport.ts'

export type ImClientState = 'idle' | 'connecting' | 'ready' | 'backoff' | 'blocked' | 'closed'

export type ImClientEvent =
  | { type: 'state'; state: ImClientState; previous: ImClientState }
  | { type: 'message'; message: ImChatMessage }
  | { type: 'reconnect'; attempt: number; delayMs: number; reason: string }
  | { type: 'challenge'; code: string; message: string; punishUrl?: string }
  | { type: 'error'; error: XianyuError }

export interface ImClientOptions {
  accountId: string
  /** mtop 传输层（取 token 用）；与队列任务共用同一个实现。 */
  transport: MtopTransport
  sink: ImMessageSink
  /** 每次重连都重新读凭据：缓存一份 cookie 等于用旧令牌握手。 */
  loadSession: () => Promise<ImTokenSession | undefined>
  /** 注入 ws 实现；测试用假实现，生产用全局 WebSocket。 */
  webSocketFactory?: WebSocketFactory
  /** 注入时钟；测试用假时钟推进退避，不 sleep。 */
  clock?: ImClock
  now?: () => number
  logger?: Logger
  onEvent?: (event: ImClientEvent) => void
  /** 退避基数/上限，默认 60s / 1800s（docs/im-protocol.md §4.3）。 */
  backoffBaseMs?: number
  backoffMaxMs?: number
}

const DEFAULT_BACKOFF_BASE_MS = 60_000
const DEFAULT_BACKOFF_MAX_MS = 1_800_000

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => name + '=' + value)
    .join('; ')
}

/** 单账号 IM 客户端；start/stop 幂等，sendReply 只在 ready 时可用。 */
export class ImClient {
  readonly #options: ImClientOptions
  #state: ImClientState = 'idle'
  #lastError: XianyuError | undefined
  #session: ImSession | undefined
  #connection: ImConnection | undefined
  #generation = 0
  #attempt = 0
  #timer: unknown
  #stopped = false
  #readyWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []

  constructor(options: ImClientOptions) {
    if (options === null || typeof options !== 'object' || typeof options.accountId !== 'string' || options.accountId === '') {
      fail('VALIDATION', 'ImClient 需要非空 accountId')
    }
    this.#options = options
  }

  get state(): ImClientState {
    return this.#state
  }

  get lastError(): XianyuError | undefined {
    return this.#lastError
  }

  /** 启动（幂等）：未连上就重试，直到 stop() 或进入 blocked。 */
  start(): void {
    if (this.#stopped || this.#state !== 'idle') return
    this.#stopped = false
    void this.#run(0)
  }

  /** 关闭（幂等）：停重连、关会话与 ws；终态。 */
  stop(): void {
    if (this.#state === 'closed') return
    this.#stopped = true
    this.#generation += 1
    this.#clearTimer()
    try {
      this.#session?.close()
    } catch {
      // 关闭阶段异常不改变「已停止」事实
    }
    this.#connection?.close()
    this.#session = undefined
    this.#connection = undefined
    this.#settleWaiters(new XianyuError({ code: 'NETWORK', message: 'IM 客户端已停止' }))
    this.#setState('closed')
  }

  /** 等就绪（发回复前用）；blocked 立即抛，超时抛 NETWORK。 */
  async ensureReady(timeoutMs = 10_000): Promise<void> {
    if (this.#state === 'ready') return
    if (this.#state === 'blocked') throw this.#blockedError()
    if (this.#state === 'closed') fail('NETWORK', 'IM 客户端已停止')
    const clock = this.#options.clock
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject }
      this.#readyWaiters.push(waiter)
      const finish = (error?: unknown): void => {
        const index = this.#readyWaiters.indexOf(waiter)
        if (index < 0) return
        this.#readyWaiters.splice(index, 1)
        if (error === undefined) resolve()
        else reject(error)
      }
      const timer = clock === undefined ? setTimeout : (callback: () => void, ms: number) => clock.setTimeout(callback, ms)
      const handle = timer(() => finish(new XianyuError({ code: 'NETWORK', message: '等 IM 就绪超时（' + String(timeoutMs) + 'ms）' })), timeoutMs)
      // 等到结果后清掉定时器，避免假时钟测试里残留 pending timer。
      const clear: (handle: unknown) => void =
        clock === undefined
          ? (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
          : (handle) => clock.clearTimeout(handle)
      const originalResolve = waiter.resolve
      waiter.resolve = () => {
        clear(handle)
        originalResolve()
      }
      const originalReject = waiter.reject
      waiter.reject = (error: unknown) => {
        clear(handle)
        originalReject(error)
      }
    })
  }

  /** 发一条文本回复：收件人取该会话最近一条对方消息的 senderId（回复任务载荷只有 cid）。 */
  async sendReply(reply: ReplyRequest, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) fail('NETWORK', 'IM 回复已取消（signal aborted）')
    await this.ensureReady()
    const session = this.#session
    if (session === undefined || this.#state !== 'ready') throw this.#blockedError()
    const accountId = this.#options.accountId
    const peerId = this.#options.sink.lastPeer({ accountId, cid: reply.cid })
    if (peerId === undefined) {
      fail(
        'VALIDATION',
        '会话 ' + reply.cid + ' 还没有对方发来的消息，取不到收件人；先等买家开口再回复（或走 SingleChatConversation/create 建会话）',
      )
    }
    const now = this.#now()
    const uuid = randomUUID()
    const frame = buildSendMessageFrame({
      cid: reply.cid,
      text: reply.text,
      peerId,
      selfId: accountId,
      uuid,
      nowMs: now,
    })
    // 未注册会抛 VALIDATION；发送失败会让会话转 disconnected，从而触发退避重连。
    session.sendFrame(frame)
    this.#options.sink.append({
      accountId,
      cid: reply.cid,
      messageId: 'out:' + uuid,
      senderId: accountId,
      kind: 'text',
      text: reply.text,
      chatTimeMs: now,
      raw: frame as unknown as Record<string, unknown>,
    })
  }

  async #run(attempt: number): Promise<void> {
    if (this.#stopped) return
    const generation = ++this.#generation
    this.#setState('connecting')
    try {
      await this.#open(generation)
    } catch (error) {
      if (this.#stopped || generation !== this.#generation) return
      this.#fail(error)
    }
    void attempt
  }

  async #open(generation: number): Promise<void> {
    const options = this.#options
    const sessionInput = await options.loadSession()
    if (sessionInput === undefined) {
      fail('AUTH_EXPIRED', '账号 ' + options.accountId + ' 没有可用凭据，IM 无法连接')
    }
    const deviceId = stableImDeviceId(options.accountId, sessionInput.deviceId)
    const token = await fetchImAccessToken(
      { ...sessionInput, deviceId },
      { transport: options.transport, ...(options.now === undefined ? {} : { now: options.now }) },
    )
    const connection = createImTransport({
      url: IM_WS_URL,
      headers: {
        cookie: cookieHeader(sessionInput.cookies),
        'user-agent': IM_UA,
        origin: 'https://www.goofish.com',
      },
      ...(options.webSocketFactory === undefined ? {} : { factory: options.webSocketFactory }),
      onClose: (reason) => {
        this.#handleDrop(generation, reason)
      },
    })
    this.#connection = connection
    await connection.opened
    if (this.#stopped || generation !== this.#generation) {
      connection.close()
      return
    }
    const imSession = new ImSession({
      transport: connection.transport,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      onMessage: (message) => {
        this.#persist(message)
      },
      onError: (error) => {
        this.#emit({ type: 'error', error })
      },
      onStateChange: (state) => {
        if (state === 'disconnected') this.#handleDrop(generation, '会话状态机断开')
      },
    })
    this.#session = imSession
    imSession.start({ accessToken: token.accessToken, deviceId: token.deviceId })
    imSession.confirmRegistered()
    this.#attempt = 0
    this.#lastError = undefined
    this.#setState('ready')
    this.#settleWaiters()
  }

  #persist(message: ImChatMessage): void {
    const accountId = this.#options.accountId
    try {
      this.#options.sink.append({
        accountId,
        cid: message.cid,
        messageId: message.messageId,
        senderId: message.senderId,
        kind: message.kind,
        text: message.text,
        chatTimeMs: message.chatTimeMs,
        ...(message.tradeStatus === undefined ? {} : { tradeStatus: message.tradeStatus }),
        ...(typeof message.raw === 'object' && message.raw !== null
          ? { raw: message.raw as Record<string, unknown> }
          : {}),
      })
    } catch (error) {
      // 单条消息落库失败不能拖死连接：记事件后继续收下一条。
      this.#emit({ type: 'error', error: toXianyuError(error, 'STORAGE') })
    }
    this.#emit({ type: 'message', message })
  }

  /** 断线：若还有未完成的发送/等待，先失败掉它们，再按退避重连。 */
  #handleDrop(generation: number, reason: string): void {
    if (this.#stopped || generation !== this.#generation) return
    if (this.#state === 'backoff' || this.#state === 'blocked' || this.#state === 'closed') return
    this.#session = undefined
    this.#connection = undefined
    this.#setState('backoff')
    this.#scheduleReconnect(reason)
  }

  #scheduleReconnect(reason: string): void {
    if (this.#stopped) return
    this.#clearTimer()
    const options = this.#options
    const base = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
    const max = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
    this.#attempt += 1
    const delayMs = Math.min(base * 2 ** (this.#attempt - 1), max)
    this.#emit({ type: 'reconnect', attempt: this.#attempt, delayMs, reason })
    const clock = options.clock
    const schedule = clock === undefined ? (cb: () => void, ms: number) => setTimeout(cb, ms) : (cb: () => void, ms: number) => clock.setTimeout(cb, ms)
    this.#timer = schedule(() => {
      this.#timer = undefined
      if (this.#stopped) return
      void this.#run(this.#attempt)
    }, delayMs)
  }

  /** 连接失败：风控/登录失效进入 blocked（等人工），其余按退避重连。 */
  #fail(error: unknown): void {
    const normalized = error instanceof XianyuError ? error : toXianyuError(error, 'NETWORK')
    this.#lastError = normalized
    if (normalized.code === 'RISK_CONTROL' || normalized.code === 'AUTH_EXPIRED') {
      this.#setState('blocked')
      this.#settleWaiters(this.#blockedError())
      const punishUrl = normalized.details?.['punishUrl']
      this.#emit({
        type: 'challenge',
        code: normalized.code,
        message: normalized.message,
        ...(typeof punishUrl === 'string' ? { punishUrl } : {}),
      })
      return
    }
    this.#emit({ type: 'error', error: normalized })
    this.#setState('backoff')
    this.#scheduleReconnect(normalized.message)
  }

  #blockedError(): XianyuError {
    return new XianyuError({
      code: this.#lastError?.code ?? 'NETWORK',
      message: 'IM 当前不可用：' + (this.#lastError?.message ?? '未连接或等待人工处理'),
      retryable: false,
    })
  }

  #settleWaiters(error?: unknown): void {
    const waiters = this.#readyWaiters
    this.#readyWaiters = []
    for (const waiter of waiters) {
      if (error === undefined) waiter.resolve()
      else waiter.reject(error)
    }
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return
    const clock = this.#options.clock
    if (clock === undefined) clearTimeout(this.#timer as ReturnType<typeof setTimeout>)
    else clock.clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #now(): number {
    return this.#options.now === undefined ? Date.now() : this.#options.now()
  }

  #emit(event: ImClientEvent): void {
    if (event.type === 'error') {
      this.#options.logger?.warn('IM 事件：错误', { accountId: this.#options.accountId, error: event.error.message })
    }
    this.#options.onEvent?.(event)
  }

  #setState(next: ImClientState): void {
    if (this.#state === next) return
    const previous = this.#state
    this.#state = next
    this.#emit({ type: 'state', state: next, previous })
    if (next === 'ready') this.#settleWaiters()
  }
}

/** 便于调用方按类型收窄的构造入口。 */
export function createImClient(options: ImClientOptions): ImClient {
  return new ImClient(options)
}
