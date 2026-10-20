/**
 * 启动 / 附加本地 Chrome，拿到 DevTools 的 browser WebSocket URL。
 *
 * 零依赖：spawn 用 node:child_process，探测 DevTools 用全局 fetch。
 * 测试不真起 Chrome：通过 opts.fetchImpl / opts.spawnImpl 注入假实现。
 * @module @bigfish/channel-cdp/launch
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { XianyuError } from '@bigfish/core'

/** fetch 返回里只用到的部分；测试的假 fetch 实现它即可。 */
export interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export interface FetchInitLike {
  signal?: AbortSignal
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>

/** 只依赖 kill；测试的假子进程实现它即可。 */
export interface ChildProcessLike {
  kill(): boolean
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore'; detached: boolean },
) => ChildProcessLike

/** 连到 Chrome 后拿到的句柄。 */
export interface ChromeTarget {
  browserWsUrl: string
  close(): Promise<void>
}

export interface LaunchChromeOptions {
  userDataDir?: string
  port?: number
  headless?: boolean
  timeoutMs?: number
  execPath?: string
  /** 注入测试用 fetch（默认全局 fetch）。 */
  fetchImpl?: FetchLike
  /** 注入测试用 spawn（默认 node:child_process.spawn）。 */
  spawnImpl?: SpawnLike
  /** 注入环境变量（默认 process.env），用于 BF_CHROME 与平台候选。 */
  env?: Record<string, string | undefined>
  /** DevTools 就绪轮询间隔；默认 200ms。 */
  pollMs?: number
}

export interface LaunchChromeResult {
  target: ChromeTarget
  port: number
  close(): Promise<void>
}

export interface AttachChromeOptions {
  timeoutMs?: number
  /** 注入测试用 fetch（默认全局 fetch）。 */
  fetchImpl?: FetchLike
}

const DEFAULT_PORT = 9222
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000
const DEFAULT_ATTACH_TIMEOUT_MS = 15_000
const DEFAULT_POLL_MS = 200
const PROBE_TIMEOUT_MS = 1_500

/** 平台候选路径；BF_CHROME 优先级最高（与 scripts/lib/cdp.mjs 行为一致）。 */
const PLATFORM_CANDIDATES: readonly string[] = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

/** 找浏览器可执行文件；找不到抛 UNSUPPORTED（不静默降级）。 */
export function resolveChromePath(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.BF_CHROME
  const candidates = typeof fromEnv === 'string' && fromEnv !== '' ? [fromEnv, ...PLATFORM_CANDIDATES] : PLATFORM_CANDIDATES
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new XianyuError({ code: 'UNSUPPORTED', message: '找不到 Chrome/Edge；用 BF_CHROME 环境变量指定可执行文件' })
}

/** 用随机端口起 headless Chrome，等 DevTools 就绪后返回连接句柄。 */
export async function launchChrome(opts: LaunchChromeOptions = {}): Promise<LaunchChromeResult> {
  const port = opts.port ?? DEFAULT_PORT
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
  const pollMs = Math.max(opts.pollMs ?? DEFAULT_POLL_MS, 1)
  const fetchImpl = opts.fetchImpl ?? defaultFetch
  const spawnImpl = opts.spawnImpl ?? defaultSpawn
  const execPath = opts.execPath ?? resolveChromePath(opts.env ?? process.env)
  const userDataDir = opts.userDataDir
  if (userDataDir !== undefined) mkdirSync(userDataDir, { recursive: true })

  const child = spawnImpl(execPath, buildChromeArgs(port, userDataDir, opts.headless ?? true), {
    stdio: 'ignore',
    detached: false,
  })
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    child.kill()
  }

  let wsUrl: string
  try {
    const version = await waitDevTools(fetchImpl, port, timeoutMs, pollMs)
    wsUrl = readWebSocketUrl(version)
  } catch (error) {
    await close()
    throw error instanceof XianyuError
      ? error
      : new XianyuError({ code: 'NETWORK', message: '启动浏览器失败', cause: error })
  }
  const target: ChromeTarget = { browserWsUrl: wsUrl, close }
  return { target, port, close }
}

/** 附加到已开的 Chrome（用户已用 --remote-debugging-port 启动的登录态）。 */
export async function attachChrome(port: number = DEFAULT_PORT, opts: AttachChromeOptions = {}): Promise<ChromeTarget> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch
  const url = devtoolsUrl(port)
  let response: FetchResponseLike
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS) })
  } catch (error) {
    throw new XianyuError({
      code: 'NETWORK',
      message: '连不上 DevTools（端口 ' + String(port) + '）：先带 --remote-debugging-port 启动 Chrome',
      cause: error,
    })
  }
  if (!response.ok) {
    throw new XianyuError({ code: 'NETWORK', message: 'DevTools 返回 HTTP ' + String(response.status) + '：' + url })
  }
  let version: unknown
  try {
    version = await response.json()
  } catch (error) {
    throw new XianyuError({ code: 'NETWORK', message: 'DevTools 响应不是 JSON：' + url, cause: error })
  }
  return { browserWsUrl: readWebSocketUrl(version), close: async (): Promise<void> => {} }
}

async function waitDevTools(fetchImpl: FetchLike, port: number, timeoutMs: number, pollMs: number): Promise<unknown> {
  const url = devtoolsUrl(port)
  const deadline = Date.now() + timeoutMs
  let lastError = '还没有响应'
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (response.ok) return await response.json()
      lastError = 'HTTP ' + String(response.status)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(pollMs, remaining))
  }
  throw new XianyuError({
    code: 'NETWORK',
    message: '浏览器 ' + String(timeoutMs) + 'ms 内没起来（端口 ' + String(port) + '，最后错误：' + lastError + '）',
  })
}

function readWebSocketUrl(version: unknown): string {
  if (typeof version === 'object' && version !== null) {
    const url = (version as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
    if (typeof url === 'string' && url !== '') return url
  }
  throw new XianyuError({ code: 'UNSUPPORTED', message: 'DevTools 没有返回 webSocketDebuggerUrl' })
}

function buildChromeArgs(port: number, userDataDir: string | undefined, headless: boolean): string[] {
  const args = [
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1280,900',
    '--remote-debugging-port=' + String(port),
  ]
  if (headless) args.push('--headless=new')
  if (userDataDir !== undefined) args.push('--user-data-dir=' + userDataDir)
  args.push('about:blank')
  return args
}

function devtoolsUrl(port: number): string {
  return 'http://127.0.0.1:' + String(port) + '/json/version'
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init?.signal === undefined ? {} : { signal: init.signal })

const defaultSpawn: SpawnLike = (command, args, options) => spawn(command, [...args], options)

export { DEFAULT_PORT }
