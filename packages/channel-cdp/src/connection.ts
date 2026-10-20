/**
 * CDP WebSocket 连接：id 匹配、错误与超时统一转成 XianyuError。
 *
 * 零依赖：生产用 Node 24 全局 WebSocket；测试注入假 socket（见 test/harness.ts）。
 * @module @bigfish/channel-cdp/connection
 */
import { XianyuError } from '@bigfish/core'

/** CDP 实际用到的最小 WebSocket 事件面；与全局 MessageEvent 结构对齐。 */
export interface SocketEvent {
  type: string
  data?: unknown
}

/** 只依赖 send/close/监听三件事，便于注入假实现。 */
export interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: SocketEvent) => void): void
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

/** 页面需要的最小连接面；CdpConnection 与测试里脚本化的假连接都满足它。 */
export interface CdpConnectionLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(event: string, listener: (params: unknown) => void): () => void
  close(): Promise<void>
}

export interface CdpConnectionOptions {
  /** 建连超时；默认 10s。 */
  timeoutMs?: number
  /** 单次 send 超时；默认 15s（AGENTS §3 的默认 IO 超时）。 */
  requestTimeoutMs?: number
  /** 注入 WebSocket 工厂（测试用）；默认取全局 WebSocket。 */
  webSocketFactory?: WebSocketFactory
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: XianyuError) => void
  timer: ReturnType<typeof setTimeout>
}

interface CdpMessage {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: { message?: unknown }
}

export class CdpConnection implements CdpConnectionLike {
  /** 建连并等 WebSocket open；失败/超时都是 NETWORK。 */
  static async connect(wsUrl: string, opts: CdpConnectionOptions = {}): Promise<CdpConnection> {
    const factory = opts.webSocketFactory ?? defaultWebSocketFactory
    const socket = factory(wsUrl)
    await waitOpen(socket, wsUrl, opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
    return new CdpConnection(socket, opts)
  }

  readonly #socket: WebSocketLike
  readonly #requestTimeoutMs: number
  #nextId = 0
  #closed = false
  readonly #pending = new Map<number, PendingCall>()
  readonly #listeners = new Map<string, Set<(params: unknown) => void>>()

  constructor(socket: WebSocketLike, opts: CdpConnectionOptions = {}) {
    this.#socket = socket
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    socket.addEventListener('message', (event) => this.#handleMessage(event))
    socket.addEventListener('close', () => this.#shutdown('CDP WebSocket 已关闭'))
    socket.addEventListener('error', () => this.#shutdown('CDP WebSocket 出错'))
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new XianyuError({ code: 'NETWORK', message: 'CDP 连接已关闭，无法发送：' + method }))
    }
    const id = ++this.#nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new XianyuError({
          code: 'NETWORK',
          message: 'CDP 请求超时：' + method + '（' + String(this.#requestTimeoutMs) + 'ms）',
        }))
      }, this.#requestTimeoutMs)
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.#socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new XianyuError({ code: 'NETWORK', message: 'CDP 发送失败：' + method, cause: error }))
      }
    })
  }

  /** 订阅 CDP 事件，返回取消订阅函数。 */
  on(event: string, listener: (params: unknown) => void): () => void {
    const listeners = this.#listeners.get(event) ?? new Set<(params: unknown) => void>()
    listeners.add(listener)
    this.#listeners.set(event, listeners)
    return () => {
      const current = this.#listeners.get(event)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.#listeners.delete(event)
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#shutdown('CDP 连接已关闭')
    try {
      this.#socket.close()
    } catch (error) {
      // 关闭阶段的底层异常没有可恢复动作；连接已经失效，忽略即可。
      void error
    }
  }

  #handleMessage(event: SocketEvent): void {
    if (typeof event.data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch (error) {
      // 非 JSON 帧不是 CDP 协议的一部分，丢弃并继续等后续帧。
      void error
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const message = parsed as CdpMessage
    if (typeof message.id === 'number') {
      this.#settle(message.id, message)
      return
    }
    if (typeof message.method !== 'string') return
    const listeners = this.#listeners.get(message.method)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener(message.params)
  }

  #settle(id: number, message: CdpMessage): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    const error = message.error
    if (error !== undefined) {
      const detail = typeof error.message === 'string' ? error.message : '未知错误'
      pending.reject(new XianyuError({ code: 'NETWORK', message: 'CDP 错误：' + detail }))
      return
    }
    pending.resolve(message.result)
  }

  #shutdown(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new XianyuError({ code: 'NETWORK', message: reason }))
    }
    this.#pending.clear()
  }
}

function waitOpen(socket: WebSocketLike, wsUrl: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: XianyuError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onOpen = (): void => finish()
    const onError = (): void => finish(new XianyuError({ code: 'NETWORK', message: 'CDP WebSocket 连接失败：' + wsUrl }))
    const onClose = (): void => finish(new XianyuError({ code: 'NETWORK', message: 'CDP WebSocket 握手前关闭：' + wsUrl }))
    const timer = setTimeout(() => {
      finish(new XianyuError({ code: 'NETWORK', message: 'CDP 建连超时（' + String(timeoutMs) + 'ms）：' + wsUrl }))
    }, timeoutMs)
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
}

type WebSocketCtor = new (url: string) => unknown

function defaultWebSocketFactory(url: string): WebSocketLike {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (ctor === undefined) {
    throw new XianyuError({ code: 'UNSUPPORTED', message: '当前 Node 没有全局 WebSocket（需要 Node ≥ 22）' })
  }
  return new ctor(url) as WebSocketLike
}
