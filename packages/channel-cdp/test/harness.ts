/**
 * 测试替身：假 WebSocket、脚本化连接、假 fetch / spawn。
 *
 * 本包测试不真起 Chrome、不发网络：全部通过注入实现（见 docs §4.2 测试要求）。
 * @module @bigfish/channel-cdp/test/harness
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CdpConnectionLike, SocketEvent, WebSocketLike } from '../src/connection.ts'
import type { FetchLike, FetchResponseLike, SpawnLike } from '../src/launch.ts'

/** 假 WebSocket：记录发出的帧，测试手动派发 open/message/close。 */
export class FakeSocket implements WebSocketLike {
  readonly sent: string[] = []
  closed = false
  readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit({ type: 'close' })
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: SocketEvent) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(event: SocketEvent): void {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event)
  }

  /** 模拟握手完成。 */
  open(): void {
    this.emit({ type: 'open' })
  }

  /** 取出最近一次请求帧（方便断言 id/method/params）。 */
  lastRequest(): { id: number; method: string; params: Record<string, unknown> } {
    const raw = this.sent.at(-1)
    if (raw === undefined) throw new Error('假 socket 还没有发出任何帧')
    return JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }
  }

  /** 按 id 回一个成功响应。 */
  reply(id: number, result: unknown): void {
    this.emit({ type: 'message', data: JSON.stringify({ id, result }) })
  }

  /** 按 id 回一个 CDP 错误响应。 */
  replyError(id: number, message: string): void {
    this.emit({ type: 'message', data: JSON.stringify({ id, error: { message } }) })
  }

  /** 派发一个 CDP 事件。 */
  emitEvent(method: string, params: unknown): void {
    this.emit({ type: 'message', data: JSON.stringify({ method, params }) })
  }
}

export type FakeResponder = (method: string, params: Record<string, unknown>) => unknown

/** 脚本化连接：记录调用、按 responder 回结果、可手动 emit 事件。 */
export class FakeConnection implements CdpConnectionLike {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  responder: FakeResponder = () => undefined
  closed = false
  readonly #handlers = new Map<string, Set<(params: unknown) => void>>()

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    return await this.responder(method, params) as T
  }

  on(event: string, listener: (params: unknown) => void): () => void {
    const handlers = this.#handlers.get(event) ?? new Set<(params: unknown) => void>()
    handlers.add(listener)
    this.#handlers.set(event, handlers)
    return () => {
      handlers.delete(listener)
    }
  }

  emit(event: string, params: unknown): void {
    for (const listener of [...(this.#handlers.get(event) ?? [])]) listener(params)
  }

  methods(): string[] {
    return this.calls.map((call) => call.method)
  }

  handlerCount(event: string): number {
    return this.#handlers.get(event)?.size ?? 0
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/** 假 fetch：记录请求 URL，按 handler 返回预设响应。 */
export function makeFakeFetch(
  handler: (url: string, index: number) => Promise<FetchResponseLike> | FetchResponseLike,
): { fetcher: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetcher: FetchLike = async (url) => {
    const index = urls.length
    urls.push(url)
    return await handler(url, index)
  }
  return { fetcher, urls }
}

/** 构造一个 JSON 响应替身。 */
export function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/** 假 spawn：记录命令与参数，返回可 kill 的假子进程。 */
export function makeFakeSpawn(): {
  spawnImpl: SpawnLike
  spawns: Array<{ command: string; args: readonly string[] }>
  killCount: () => number
} {
  const spawns: Array<{ command: string; args: readonly string[] }> = []
  let killed = 0
  const spawnImpl: SpawnLike = (command, args) => {
    spawns.push({ command, args })
    return { kill: () => { killed += 1; return true } }
  }
  return { spawnImpl, spawns, killCount: () => killed }
}

/** 临时文件路径（统一放 .scratch/channel-cdp 下，已 gitignore）。 */
export function scratchPath(name: string): string {
  return resolve(process.cwd(), '.scratch', 'channel-cdp', name)
}

/** 写一个临时文件（自动建父目录），返回路径。 */
export async function writeScratch(name: string, content: string): Promise<string> {
  const filePath = scratchPath(name)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
  return filePath
}

/** 等若干毫秒，让内部 async 流程推进（测试里只用于短等待）。 */
export function tick(ms = 0): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
