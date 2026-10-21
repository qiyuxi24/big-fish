/**
 * IM 会话状态机：未连接 → 握手 → 已注册（心跳循环）→ 断开/重连。
 *
 * 传输、时钟、消息回调全部注入，测试用假实现推进时间，不 sleep、不连网络。
 * 协议事实见 docs/im-protocol.md；ws 适配器由 daemon 负责，本类只发文本帧。
 * @module @bigfish/channel-im/session
 */
import { XianyuError, fail, toXianyuError } from '@bigfish/core'
import {
  ACK_DIFF_DELAY_MS,
  HEARTBEAT_INTERVAL_MS,
  buildAckDiffFrame,
  buildAckFrame,
  buildHeartbeatFrame,
  buildRegFrame,
  encodeFrame,
  generateMid,
  isRecord,
  parseFrameText,
} from './frames.ts'
import type { ImFrame } from './frames.ts'
import { parsePushMessages } from './messages.ts'
import type { ImChatMessage } from './messages.ts'

/** 会话状态：idle(未连接) → handshaking(已发 /reg) → registered(已注册，心跳运行)；disconnected 可重连，closed 终态。 */
export type ImSessionState = 'idle' | 'handshaking' | 'registered' | 'disconnected' | 'closed'

/** 可注入传输：ws 适配器实现 send/onMessage/close，测试用假实现。 */
export interface ImTransport {
  /** 发一个文本帧；连接已死应抛错，会话据此判断线。 */
  send(text: string): void
  /** 注册下行回调；一个连接只注册一次。 */
  onMessage(listener: (text: string) => void): void
  /** 关闭连接；关闭阶段的异常由适配器决定是否吞掉。 */
  close(): void
}

/** 可注入时钟：测试用假时钟推进，不依赖真实 setTimeout。 */
export interface ImClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

/** 默认时钟（真实毫秒 + setTimeout）。 */
export const SYSTEM_CLOCK: ImClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/** 启动参数：IM accessToken 来自 mtop 取 token 接口，deviceId 必须账号维度稳定。 */
export interface ImStartOptions {
  accessToken: string
  deviceId: string
}

export interface ImSessionOptions {
  transport: ImTransport
  /** 测试注入假时钟；默认 SYSTEM_CLOCK。 */
  clock?: ImClock
  heartbeatIntervalMs?: number
  ackDiffDelayMs?: number
  /** 业务消息回调；异常直接冒泡（不吞）。 */
  onMessage?: (message: ImChatMessage) => void
  /** 非业务帧（响应/心跳回显/未知 lwp）；用于观测，不影响状态。 */
  onUnknownFrame?: (frame: ImFrame) => void
  /** 可恢复错误上报：非法帧、ACK/心跳发送失败等；不填则只记 lastError。 */
  onError?: (error: XianyuError) => void
  /** 状态迁移通知；回调异常直接冒泡。 */
  onStateChange?: (state: ImSessionState, previous: ImSessionState) => void
}

export class ImSession {
  readonly #transport: ImTransport
  readonly #clock: ImClock
  readonly #heartbeatIntervalMs: number
  readonly #ackDiffDelayMs: number
  readonly #onMessage: ((message: ImChatMessage) => void) | undefined
  readonly #onUnknownFrame: ((frame: ImFrame) => void) | undefined
  readonly #onError: ((error: XianyuError) => void) | undefined
  readonly #onStateChange: ((state: ImSessionState, previous: ImSessionState) => void) | undefined
  #state: ImSessionState = 'idle'
  #lastError: XianyuError | undefined
  #listening = false
  #timers: unknown[] = []

  constructor(options: ImSessionOptions) {
    if (options === null || typeof options !== 'object' || options.transport === undefined) {
      fail('VALIDATION', 'ImSession 需要注入 transport（send / onMessage / close）')
    }
    this.#transport = options.transport
    this.#clock = options.clock ?? SYSTEM_CLOCK
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this.#ackDiffDelayMs = options.ackDiffDelayMs ?? ACK_DIFF_DELAY_MS
    this.#onMessage = options.onMessage
    this.#onUnknownFrame = options.onUnknownFrame
    this.#onError = options.onError
    this.#onStateChange = options.onStateChange
  }

  get state(): ImSessionState {
    return this.#state
  }

  /** 最近一次上报的错误；没有则为 undefined。 */
  get lastError(): XianyuError | undefined {
    return this.#lastError
  }

  /**
   * 发 /reg 注册帧并进入 handshaking。
   * 传输适配器的 ws open 之后调用；之后由适配器调用 confirmRegistered()。
   */
  start(input: unknown): void {
    if (this.#state === 'handshaking' || this.#state === 'registered') {
      fail('VALIDATION', 'IM 会话已在运行（' + this.#state + '），重连前先 disconnect 或 close')
    }
    if (!isRecord(input)) fail('VALIDATION', 'ImSession.start 参数必须是对象')
    this.#clearTimers()
    this.#listen()
    const frame = buildRegFrame({
      accessToken: input.accessToken,
      deviceId: input.deviceId,
      nowMs: this.#clock.now(),
    })
    this.#setState('handshaking')
    try {
      this.#transport.send(encodeFrame(frame))
    } catch (error) {
      this.#setState('disconnected')
      throw toXianyuError(error, 'NETWORK')
    }
  }

  /**
   * 确认注册完成（参考实现发完 /reg 即视为注册，1s 后才提交同步游标）。
   * 只允许 handshaking → registered；重复调用是调用方 bug，直接 VALIDATION。
   */
  confirmRegistered(): void {
    if (this.#state !== 'handshaking') {
      fail('VALIDATION', '当前状态不可确认注册：' + this.#state)
    }
    this.#setState('registered')
    this.#schedule(() => this.#sendAckDiff(), this.#ackDiffDelayMs)
  }

  /** 下行文本帧入口；ACK 先行，业务消息走 onMessage，未知帧走 onUnknownFrame。 */
  handleText(text: unknown): void {
    if (this.#state === 'closed') return
    const frame = parseFrameText(text)
    if (frame === undefined) {
      this.#report(new XianyuError({ code: 'VALIDATION', message: 'IM 下行帧不是合法 JSON 对象，已丢弃' }))
      return
    }
    const ack = buildAckFrame(frame)
    if (ack !== undefined) this.#safeSend(ack)
    let messages: ImChatMessage[]
    try {
      messages = parsePushMessages(frame)
    } catch (error) {
      this.#report(toXianyuError(error, 'VALIDATION'))
      messages = []
    }
    if (messages.length === 0) {
      this.#onUnknownFrame?.(frame)
      return
    }
    for (const message of messages) this.#onMessage?.(message)
  }

  /** 链路断开：清定时器、关传输、进入 disconnected；之后可再 start() 重连。 */
  disconnect(reason: string): void {
    if (this.#state === 'closed' || this.#state === 'disconnected') return
    this.#clearTimers()
    this.#safeClose()
    this.#setState('disconnected')
    this.#report(new XianyuError({ code: 'NETWORK', message: 'IM 连接已断开：' + reason }))
  }

  /** 主动关闭（终态，不自动重连）；幂等。 */
  close(): void {
    if (this.#state === 'closed') return
    this.#clearTimers()
    this.#safeClose()
    this.#setState('closed')
  }

  #listen(): void {
    if (this.#listening) return
    this.#listening = true
    this.#transport.onMessage((text) => this.handleText(text))
  }

  #schedule(callback: () => void, delayMs: number): void {
    const box: { handle?: unknown } = {}
    box.handle = this.#clock.setTimeout(() => {
      this.#timers = this.#timers.filter((handle) => handle !== box.handle)
      callback()
    }, delayMs)
    this.#timers.push(box.handle)
  }

  #clearTimers(): void {
    for (const handle of this.#timers) this.#clock.clearTimeout(handle)
    this.#timers = []
  }

  #sendAckDiff(): void {
    if (this.#state !== 'registered') return
    const now = this.#clock.now()
    const frame = buildAckDiffFrame({ nowMs: now, mid: generateMid(now) })
    if (!this.#safeSend(frame)) {
      this.disconnect('提交同步游标失败')
      return
    }
    this.#scheduleHeartbeat()
  }

  #scheduleHeartbeat(): void {
    this.#schedule(() => this.#sendHeartbeat(), this.#heartbeatIntervalMs)
  }

  #sendHeartbeat(): void {
    if (this.#state !== 'registered') return
    const now = this.#clock.now()
    if (!this.#safeSend(buildHeartbeatFrame(generateMid(now)))) {
      this.disconnect('心跳发送失败')
      return
    }
    this.#scheduleHeartbeat()
  }

  #safeSend(frame: ImFrame): boolean {
    try {
      this.#transport.send(encodeFrame(frame))
      return true
    } catch (error) {
      this.#report(toXianyuError(error, 'NETWORK'))
      return false
    }
  }

  #safeClose(): void {
    try {
      this.#transport.close()
    } catch (error) {
      this.#report(toXianyuError(error, 'NETWORK'))
    }
  }

  #report(error: unknown): void {
    const normalized = error instanceof XianyuError ? error : toXianyuError(error, 'NETWORK')
    this.#lastError = normalized
    this.#onError?.(normalized)
  }

  #setState(next: ImSessionState): void {
    if (this.#state === next) return
    const previous = this.#state
    this.#state = next
    this.#onStateChange?.(next, previous)
  }
}
