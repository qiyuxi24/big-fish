/**
 * CDP 页面操作：导航、求值、等待、响应体截获（captureJson）、截图。
 *
 * 页面不拥有连接：close() 只摘除本页订阅，连接由调用方负责关闭。
 * @module @bigfish/channel-cdp/page
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { XianyuError } from '@bigfish/core'
import type { CdpConnectionLike } from './connection.ts'

export interface CdpPageOptions {
  /** 页面导航完成后的额外静置时间；默认 1500ms（SPA 首屏渲染）。 */
  settleMs?: number
  /** 导航/等待类操作的默认超时；默认 15s。 */
  timeoutMs?: number
}

export interface WaitForOptions {
  timeoutMs?: number
  intervalMs?: number
  /** 超时消息里的可读标签；默认用表达式本身。 */
  label?: string
}

export interface CaptureJsonOptions {
  /** 响应 URL 必须包含的片段，用来认出目标接口。 */
  urlContains: string
  timeoutMs?: number
  /**
   * 认出请求后等 Network.loadingFinished 的宽限期；默认 1000ms。
   * 到期仍没收到就兜底直接读一次响应体（长连接/中断场景）。
   */
  loadingGraceMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_SETTLE_MS = 1_500
const DEFAULT_POLL_MS = 300
const DEFAULT_LOADING_GRACE_MS = 1_000

interface RuntimeExceptionDetails {
  text?: string
  exception?: { description?: string }
}

interface RuntimeEvaluateResponse {
  result?: { value?: unknown }
  exceptionDetails?: RuntimeExceptionDetails
}

interface CaptureBodyResponse {
  body?: unknown
  base64Encoded?: unknown
}

interface ScreenshotResponse {
  data?: unknown
}

interface ResponseReceivedEvent {
  requestId: string
  url: string
}

export class CdpPage {
  /** 让连接切到页面域、导航到 url，并等 load 事件后再静置 settleMs。 */
  static async open(conn: CdpConnectionLike, url: string, opts: CdpPageOptions = {}): Promise<CdpPage> {
    const page = new CdpPage(conn, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    await conn.send('Page.enable')
    await conn.send('Runtime.enable')
    await page.navigate(url)
    await delay(opts.settleMs ?? DEFAULT_SETTLE_MS)
    return page
  }

  readonly #conn: CdpConnectionLike
  readonly #timeoutMs: number
  readonly #offs = new Set<() => void>()
  #closed = false

  private constructor(conn: CdpConnectionLike, timeoutMs: number) {
    this.#conn = conn
    this.#timeoutMs = timeoutMs
  }

  /** 导航并等 Page.loadEventFired（超时按 NETWORK 失败）。 */
  async navigate(url: string): Promise<void> {
    this.#ensureOpen()
    const loaded = once(this.#conn, 'Page.loadEventFired', this.#timeoutMs, '页面加载完成：' + url)
    try {
      await this.#conn.send('Page.navigate', { url })
      await loaded.promise
    } finally {
      loaded.dispose()
    }
  }

  /** 在页面里求值；页面抛异常时转 XianyuError，避免把 CDP 细节漏给上层。 */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    this.#ensureOpen()
    const response = await this.#conn.send<RuntimeEvaluateResponse>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    const exception = response.exceptionDetails
    if (exception !== undefined) {
      throw new XianyuError({ code: 'INTERNAL', message: '页面求值异常：' + describeException(exception) })
    }
    return response.result?.value as T
  }

  /** 轮询表达式直到返回真值；超时抛 NETWORK（带最后结果，便于定位）。 */
  async waitFor(expression: string, opts: WaitForOptions = {}): Promise<void> {
    this.#ensureOpen()
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs
    const intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS
    const label = opts.label ?? expression
    const deadline = Date.now() + timeoutMs
    let last = '未求值'
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate<unknown>(expression)) return
        last = 'falsy'
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      await delay(intervalMs)
    }
    throw new XianyuError({
      code: 'NETWORK',
      message: '等待超时：' + label + '（' + String(timeoutMs) + 'ms，最后结果：' + last + '）',
    })
  }

  /**
   * 等某个 URL 片段的 JSON 响应并解析；这是免签名读 mtop 的主要手段。
   *
   * 顺序：Network.responseReceived 认出目标请求 → 等同一 requestId 的
   * Network.loadingFinished（响应体收完，Network.getResponseBody 才一定有数据）→ 解析 JSON。
   * 若没等到 loadingFinished（长连接、请求被中断、无 body 的响应），宽限到期后仍兜底读一次，
   * 避免死等；两种情况都失败才按 NETWORK/VALIDATION 报错。
   */
  async captureJson(opts: CaptureJsonOptions): Promise<unknown> {
    this.#ensureOpen()
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs
    const graceMs = Math.min(opts.loadingGraceMs ?? DEFAULT_LOADING_GRACE_MS, timeoutMs)
    await this.#conn.send('Network.enable')
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      let drained = false
      let requestId: string | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      let grace: ReturnType<typeof setTimeout> | undefined
      let offResponse: () => void = () => {}
      let offFinished: () => void = () => {}
      const cleanup = (): void => {
        if (deadline !== undefined) clearTimeout(deadline)
        if (grace !== undefined) clearTimeout(grace)
        offResponse()
        offFinished()
        this.#offs.delete(offResponse)
        this.#offs.delete(offFinished)
      }
      const finish = (error?: XianyuError, value?: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const drain = (): void => {
        if (drained || requestId === undefined) return
        drained = true
        if (grace !== undefined) clearTimeout(grace)
        this.#readBody(requestId).then(
          (body) => finish(undefined, body),
          (error: unknown) => finish(toPageError(error, '读取接口响应体失败')),
        )
      }
      offResponse = this.#conn.on('Network.responseReceived', (params) => {
        const event = narrowResponseReceived(params)
        if (event === undefined || !event.url.includes(opts.urlContains) || requestId !== undefined) return
        requestId = event.requestId
        grace = setTimeout(drain, graceMs)
      })
      offFinished = this.#conn.on('Network.loadingFinished', (params) => {
        const finishedId = narrowLoadingFinished(params)
        if (finishedId === undefined || finishedId !== requestId) return
        drain()
      })
      this.#offs.add(offResponse)
      this.#offs.add(offFinished)
      deadline = setTimeout(() => {
        finish(new XianyuError({
          code: 'NETWORK',
          message: '等待接口响应超时：' + opts.urlContains + '（' + String(timeoutMs) + 'ms）',
        }))
      }, timeoutMs)
    })
  }

  /** 截图到文件（自动建父目录）。 */
  async screenshot(filePath: string): Promise<void> {
    this.#ensureOpen()
    const response = await this.#conn.send<ScreenshotResponse>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    const data = response.data
    if (typeof data !== 'string') {
      throw new XianyuError({ code: 'INTERNAL', message: '截图没有返回 base64 数据' })
    }
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.from(data, 'base64'))
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const off of this.#offs) off()
    this.#offs.clear()
  }

  async #readBody(requestId: string): Promise<unknown> {
    const response = await this.#conn.send<CaptureBodyResponse>('Network.getResponseBody', { requestId })
    const body = response.body
    if (typeof body !== 'string') {
      throw new XianyuError({ code: 'INTERNAL', message: 'Network.getResponseBody 没有返回 body' })
    }
    const text = response.base64Encoded === true ? Buffer.from(body, 'base64').toString('utf8') : body
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new XianyuError({ code: 'VALIDATION', message: '接口响应不是合法 JSON', cause: error })
    }
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new XianyuError({ code: 'NETWORK', message: '页面已关闭' })
    }
  }
}

interface OnceWaiter {
  promise: Promise<unknown>
  dispose: () => void
}

/** 订阅一次事件；超时 reject，dispose 用于调用方提前收尾（避免监听泄漏）。 */
function once(conn: CdpConnectionLike, event: string, timeoutMs: number, label: string): OnceWaiter {
  let dispose = (): void => {}
  const promise = new Promise<unknown>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      off()
      reject(new XianyuError({
        code: 'NETWORK',
        message: '等待 ' + label + ' 超时（' + String(timeoutMs) + 'ms）',
      }))
    }, timeoutMs)
    const off = conn.on(event, (params) => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
      resolve(params)
    })
    dispose = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
    }
  })
  return { promise, dispose: () => dispose() }
}

function describeException(details: RuntimeExceptionDetails): string {
  const description = details.exception?.description
  if (typeof description === 'string' && description !== '') return description
  return details.text ?? '未知异常'
}

function narrowLoadingFinished(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  if (!('requestId' in params)) return undefined
  const requestId = (params as { requestId?: unknown }).requestId
  return typeof requestId === 'string' ? requestId : undefined
}

function narrowResponseReceived(params: unknown): ResponseReceivedEvent | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const record = params as { requestId?: unknown; response?: { url?: unknown } }
  const requestId = record.requestId
  const url = record.response?.url
  if (typeof requestId !== 'string' || typeof url !== 'string') return undefined
  return { requestId, url }
}

function toPageError(error: unknown, fallback: string): XianyuError {
  if (error instanceof XianyuError) return error
  return new XianyuError({ code: 'INTERNAL', message: fallback, cause: error })
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
