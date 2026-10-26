/**
 * IM 的 ws 适配器：把 Node 的 WebSocket 包成 channel-im 需要的 ImTransport（send / onMessage / close）。
 *
 * 为什么只做「文本帧 + 生命周期」这一件事：帧格式、状态机、心跳全在 channel-im 的纯函数/状态机里，
 * 这一层薄到换任何 ws 实现都不影响上层。握手头（cookie / UA / Origin）由调用方给，见 docs/im-protocol.md §1.1。
 * 注意 Node 内置 WebSocket 不能设 ping_interval：只能靠应用层 15s 心跳（channel-im 实现）。
 * 不做「收包静默判死」——服务端空闲时不一定回包，误判会杀掉健康连接；半开连接只能等下次
 * 发送失败（send 抛错）或 close 事件，再由 im-client 的退避重连兜底。
 * @module @bigfish/daemon/im-transport
 */

import { XianyuError, fail } from '@bigfish/core'
import type { ImTransport } from '@bigfish/channel-im'

/** 适配器只需要 WebSocket 的这四件事；测试注入假实现，不碰网络。 */
export interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike

export interface ImTransportOptions {
  url: string
  /** 握手头：cookie + UA + Origin（见 §1.1）。 */
  headers?: Record<string, string>
  /** 注入 ws 实现；默认用全局 WebSocket（Node 22+）。 */
  factory?: WebSocketFactory
  /** 连接关闭/失败回调；参数是给人看的原因。只在第一次关闭时触发。 */
  onClose?: (reason: string) => void
  /** ws open 之后的回调（用于 start/confirmRegistered）。 */
  onOpen?: () => void
}

export interface ImConnection {
  transport: ImTransport
  /** ws 打开后 resolve；打开前失败则 reject（NETWORK）。 */
  opened: Promise<void>
  close(): void
}

function defaultFactory(url: string, headers: Record<string, string>): WebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string, init?: unknown) => WebSocketLike }).WebSocket
  if (ctor === undefined) fail('UNSUPPORTED', '当前运行时没有全局 WebSocket（需要 Node 22+）')
  // undici 的 WebSocket 接受非标准 init.headers；没有它就发不出 cookie，服务端一律 401。
  return new ctor(url, { headers })
}

/** 下行帧统一转成字符串；二进制帧不在协议里，遇到按非法帧丢弃（由上层记 error）。 */
function readIncoming(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return undefined
}

export function createImTransport(options: ImTransportOptions): ImConnection {
  if (options === null || typeof options !== 'object' || typeof options.url !== 'string' || options.url === '') {
    fail('VALIDATION', 'createImTransport 需要非空 url')
  }
  const factory = options.factory ?? defaultFactory
  const headers = options.headers ?? {}
  let socket: WebSocketLike
  try {
    socket = factory(options.url, headers)
  } catch (error) {
    return failedConnection(error, options)
  }

  let state: 'connecting' | 'open' | 'closed' = 'connecting'
  let listener: ((text: string) => void) | undefined
  let closeReason: string | undefined
  let resolveOpen: () => void = () => undefined
  let rejectOpen: (error: unknown) => void = () => undefined
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  // 调用方未必 await opened：避免「没人接的 rejection」把进程带崩（真实错误仍会写进 lastError/onClose）。
  opened.catch(() => undefined)

  const notifyClose = (reason: string): void => {
    if (state === 'closed') return
    state = 'closed'
    closeReason = reason
    options.onClose?.(reason)
  }

  socket.addEventListener('open', () => {
    if (state !== 'connecting') return
    state = 'open'
    resolveOpen()
    options.onOpen?.()
  })
  socket.addEventListener('message', (event) => {
    if (state !== 'open') return
    const data = (event as { data?: unknown }).data
    const text = readIncoming(data)
    if (text === undefined) {
      // 非文本帧说明这条连接已不可信：按断链处理（置 closed + 只通知一次），让上层重建。
      notifyClose('收到非文本帧')
      return
    }
    listener?.(text)
  })
  socket.addEventListener('close', (event) => {
    const code = (event as { code?: unknown }).code
    const reason = 'ws 已关闭' + (typeof code === 'number' ? '（code ' + String(code) + '）' : '')
    if (state === 'connecting') rejectOpen(new XianyuError({ code: 'NETWORK', message: 'IM 连接未建立：' + reason }))
    notifyClose(reason)
  })
  socket.addEventListener('error', () => {
    if (state === 'connecting') rejectOpen(new XianyuError({ code: 'NETWORK', message: 'IM 连接失败（ws error）' }))
    notifyClose('ws error')
  })

  const transport: ImTransport = {
    send(text: string): void {
      if (state !== 'open') {
        fail('NETWORK', 'IM 连接未就绪（' + (closeReason ?? state) + '），帧未发出')
      }
      try {
        socket.send(text)
      } catch (error) {
        notifyClose('帧发送失败')
        throw new XianyuError({ code: 'NETWORK', message: 'IM 帧发送失败', cause: error })
      }
    },
    onMessage(next: (text: string) => void): void {
      listener = next
    },
    close(): void {
      if (state === 'closed') return
      try {
        socket.close()
      } catch {
        // 关一条已死的连接不算错误；状态由 notifyClose 统一收口。
      }
      notifyClose('调用方主动关闭')
    },
  }

  return {
    transport,
    opened,
    close: () => transport.close(),
  }
}

/** 构造 ws 实例就抛错（如 url 非法）：给出一个「永远打不开」的连接，错误在 opened 上抛。 */
function failedConnection(error: unknown, options: ImTransportOptions): ImConnection {
  const normalized = error instanceof XianyuError ? error : new XianyuError({ code: 'NETWORK', message: 'IM ws 构造失败', cause: error })
  const opened = Promise.reject(normalized)
  opened.catch(() => undefined)
  options.onClose?.('ws 构造失败')
  return {
    transport: {
      send(): void {
        throw normalized
      },
      onMessage(): void {
        // 没有连接就不会有下行帧
      },
      close(): void {
        // 已失败：无事可做
      },
    },
    opened,
    close(): void {
      // 已失败：无事可做
    },
  }
}
