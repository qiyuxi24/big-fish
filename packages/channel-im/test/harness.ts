/**
 * 测试替身：假时钟按注入时间推进，假传输记录发出的帧并可模拟下行。
 * 注意：本文件不是 *.test.ts，不会被 scripts/test-all.mjs 直接加载。
 */
import type { ImClock, ImTransport } from '../src/session.ts'

/** 假时钟：advance 按到期时间顺序执行，回调节点里新排的定时器也会被执行。 */
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

/** 假传输：记录 send 的文本帧，预置下行文本可触发监听器。 */
export class FakeTransport implements ImTransport {
  readonly sent: string[] = []
  closed = false
  /** 下一次 send 抛错（模拟连接已死），抛完自动清除。 */
  failNextSend: string | undefined
  readonly #listeners: Array<(text: string) => void> = []

  send(text: string): void {
    if (this.failNextSend !== undefined) {
      const reason = this.failNextSend
      this.failNextSend = undefined
      throw new Error(reason)
    }
    if (this.closed) throw new Error('连接已关闭')
    this.sent.push(text)
  }

  onMessage(listener: (text: string) => void): void {
    this.#listeners.push(listener)
  }

  close(): void {
    this.closed = true
  }

  /** 模拟服务端下行文本帧。 */
  receive(text: string): void {
    for (const listener of [...this.#listeners]) listener(text)
  }

  lastFrame(): Record<string, unknown> {
    const last = this.sent.at(-1)
    if (last === undefined) return {}
    const parsed: unknown = JSON.parse(last)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  }

  /** 所有 lwp 匹配的帧（保留顺序）。 */
  framesOfLwp(lwp: string): Record<string, unknown>[] {
    const frames: Record<string, unknown>[] = []
    for (const text of this.sent) {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const frame = parsed as Record<string, unknown>
        if (frame.lwp === lwp) frames.push(frame)
      }
    }
    return frames
  }
}
