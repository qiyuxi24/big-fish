/**
 * 扫码登录：打开闲鱼登录页，轮询本机 Chrome 的 cookie，读到登录态就导出入库。
 *
 * 为什么不在 importAccountFromChrome 里加等待：那个入口的语义是「已经登录好，现在导出」，
 * 一次失败就该失败；扫码登录是「先开页面 → 用户扫码 → 自动发现 unb」的交互，需要轮询、
 * 超时与进度回调，失败要区分「还没扫完」和「浏览器连不上」。
 *
 * 安全边界与 accounts.ts 一致：cookie 值只在本进程内存里流向 CredentialStore；
 * 返回值、日志、onTick 都不带 cookie 值。
 * @module @bigfish/daemon/login
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { XianyuError, fail, toXianyuError } from '@bigfish/core'
import type { CredentialStore } from '@bigfish/core'
import { CdpConnection, CdpCookieSource, DEFAULT_PORT, attachChrome, launchChrome } from '@bigfish/channel-cdp'
import type { CookieJar } from '@bigfish/channel-cdp'

import { saveImportedAccount } from './accounts.ts'
import type { ImportedAccount } from './accounts.ts'

/** 默认等待扫码时长：扫码加手机确认通常 30s 内，180s 留给切号/输密码的情况。 */
export const DEFAULT_LOGIN_TIMEOUT_MS = 180_000
/** 默认轮询间隔：扫码成功后 cookie 几秒内写入，2s 足够快又不会把 CDP 打满。 */
export const DEFAULT_LOGIN_POLL_MS = 2_000
/** 打开这个地址；未登录时页面自带扫码入口。 */
const LOGIN_URL = 'https://www.goofish.com/'

/** 一轮轮询的进度：调用方据此打印「已等 Ns」。 */
export interface LoginTick {
  /** 第几次检查（从 1 开始）。 */
  attempt: number
  /** 从开始等待扫码到现在的毫秒数。 */
  elapsedMs: number
}

/** 等待扫码的参数（都可省略）。 */
export interface WaitForLoginOptions {
  /** Chrome DevTools 端口，默认 9222。 */
  port?: number
  /** 最长等待毫秒数，默认 180000；超时抛 UNAUTHORIZED。 */
  timeoutMs?: number
  /** 轮询间隔毫秒数，默认 2000。 */
  pollIntervalMs?: number
  /** 中止信号（HTTP 客户端断开时由路由侧 abort）。 */
  signal?: AbortSignal
  /** 每轮进度回调；不要在这里做耗时操作。 */
  onTick?: (tick: LoginTick) => void
}

/**
 * 可注入依赖：测试传假实现，生产用默认的 CDP 实现。
 * 拆成「开页面 / 读 cookie / 时钟 / 睡眠」四件事，测试不需要真连浏览器也不用等真实时间。
 */
export interface LoginRuntimeDeps {
  /** 打开登录页；默认用 CDP 新开一个 goofish 标签页。 */
  openLoginPage?: (port: number) => Promise<void>
  /** 读一次登录 cookie；缺登录态时应抛 UNAUTHORIZED（默认实现即如此）。 */
  readLoginJar?: (port: number) => Promise<CookieJar>
  /**
   * 确保端口上有可连的浏览器，返回释放回调。
   * 为什么需要：扫码登录曾要求用户先手动 `--remote-debugging-port` 起 Chrome（只是 attach），
   * 而面板按钮写的是「打开闲鱼登录页等你扫码」——没有调试端口时必失败，用户看到的就是
   * 「没办法正常登陆」。默认实现改为：能 attach 就复用，连不上就自己起一个带窗口的 Chrome。
   */
  ensureBrowser?: (port: number) => Promise<() => Promise<void>>
  now?: () => number
  /** 睡眠；必须响应 signal 中止（默认实现用 setTimeout + abort 监听）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** 扫码登录 + 落库的输入。 */
export interface LoginInput extends WaitForLoginOptions {
  /** 覆盖默认账号 id；默认取 unb cookie（闲鱼 userId）。 */
  accountId?: string
}

/** loginAndSave 的依赖：凭据库 + 可注入的浏览器操作。 */
export interface LoginDeps extends LoginRuntimeDeps {
  credentials: CredentialStore
  /** 自起浏览器时的独立 profile 目录（默认 ~/.bigfish/chrome-profile）：留着可复用已登录态。 */
  browserProfileDir?: string
  /** 收尾失败（关不掉自起浏览器）时的告警出口；不传就只留在内部，不掩盖登录结果。 */
  onWarn?: (message: string) => void
  now?: () => number
}

/** 登录结果：ImportedAccount 加上本次实际等待/导入耗时。 */
export interface LoginResult extends ImportedAccount {
  /** 从开始等待扫码到落库完成的总毫秒数（整数）。 */
  elapsedMs: number
}

/** 把一轮进度变成用户可读文案；CLI 与插件共用一份，避免两边措辞漂移。 */
export function formatLoginTick(tick: LoginTick): string {
  return (
    '等待扫码中（已等 ' +
    String(Math.floor(tick.elapsedMs / 1000)) +
    's，第 ' +
    String(tick.attempt) +
    ' 次检查）…'
  )
}

/**
 * 打开登录页并轮询 cookie，直到读到非空 unb 且 _m_h5_tk 都在。
 *
 * 为什么要自己轮询而不是让浏览器事件通知：CDP 的 cookie 变更没有稳定的浏览器级事件，
 * 轮询 Storage.getCookies 是本机场景下最简单、不依赖权限的可靠做法。
 */
export async function waitForLogin(
  options: WaitForLoginOptions = {},
  deps: LoginRuntimeDeps = {},
): Promise<CookieJar> {
  const port = options.port ?? DEFAULT_PORT
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOGIN_POLL_MS
  validateWait(port, timeoutMs, pollIntervalMs)
  const now = deps.now ?? Date.now
  const startedAt = now()
  await (deps.openLoginPage ?? openLoginPageOnChrome)(port)

  let attempt = 0
  let lastProblem = '还没读到登录 cookie'
  for (;;) {
    attempt += 1
    const elapsedMs = now() - startedAt
    options.onTick?.({ attempt, elapsedMs })
    if (elapsedMs >= timeoutMs) throw timeoutError(port, timeoutMs, lastProblem)
    throwIfAborted(options.signal)
    const outcome = await readOnce(deps, port).catch((error: unknown): ReadOutcome => {
      const normalized = toXianyuError(error)
      // 只有「还没登录」可以继续等；连不上 CDP、协议不兼容等真故障必须立刻上报。
      if (normalized.code !== 'UNAUTHORIZED') throw normalized
      return { ready: false, problem: normalized.message }
    })
    if (outcome.ready) return outcome.jar
    lastProblem = outcome.problem
    const remaining = timeoutMs - (now() - startedAt)
    if (remaining <= 0) throw timeoutError(port, timeoutMs, lastProblem)
    await (deps.sleep ?? sleepMs)(Math.min(pollIntervalMs, remaining), options.signal)
  }
}

/** 一次读取的结果：就绪给 jar，否则给「为什么还没就绪」（用来拼超时文案）。 */
type ReadOutcome = { ready: true; jar: CookieJar } | { ready: false; problem: string }

/** 读一次并判断登录是否完成；不打印、不写库，纯读。 */
async function readOnce(deps: LoginRuntimeDeps, port: number): Promise<ReadOutcome> {
  const jar = await (deps.readLoginJar ?? readLoginJarFromChrome)(port)
  if (!isLoginReady(jar)) return { ready: false, problem: '登录态未就绪：cookie 里还没有非空的 unb' }
  return { ready: true, jar }
}

/** unb 决定账号、_m_h5_tk 参与 mtop 签名，两者缺一都不能算登录完成。 */
function isLoginReady(jar: CookieJar): boolean {
  return nonEmpty(jar.goofish['unb']) && nonEmpty(jar.goofish['_m_h5_tk'])
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== ''
}

/** 参数校验：端口/超时/间隔都必须是正整数，且端口在合法范围。 */
function validateWait(port: number, timeoutMs: number, pollIntervalMs: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail('VALIDATION', 'Chrome DevTools 端口必须是 1..65535 的整数：' + String(port))
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail('VALIDATION', '扫码超时时间必须是正整数毫秒：' + String(timeoutMs))
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    fail('VALIDATION', '轮询间隔必须是正整数毫秒：' + String(pollIntervalMs))
  }
}

/** 超时给可操作的下一步：用户最常犯的错是浏览器窗口没开或没扫码。 */
function timeoutError(port: number, timeoutMs: number, lastProblem: string): XianyuError {
  return new XianyuError({
    code: 'UNAUTHORIZED',
    message:
      '扫码超时：请确认浏览器窗口已打开并完成扫码（已等 ' +
      String(Math.round(timeoutMs / 1000)) +
      ' 秒，端口 ' +
      String(port) +
      '；最后状态：' +
      lastProblem +
      '）',
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError()
}

function cancelledError(): XianyuError {
  return new XianyuError({ code: 'UNAUTHORIZED', message: '扫码登录已取消：等待被中止（可重新运行 login 子命令）' })
}

/** 默认实现：连浏览器、新开一个 goofish 标签页，然后断开连接（标签页留给用户扫码）。 */
async function openLoginPageOnChrome(port: number): Promise<void> {
  const target = await attachChrome(port)
  const connection = await CdpConnection.connect(target.browserWsUrl)
  try {
    await connection.send('Target.createTarget', { url: LOGIN_URL })
  } catch (error) {
    throw new XianyuError({
      code: 'NETWORK',
      message: '打不开闲鱼登录页（端口 ' + String(port) + '）：' + toXianyuError(error).message,
      cause: error,
    })
  } finally {
    await connection.close()
    await target.close()
  }
}

/** 默认实现：附加 Chrome，用 CdpCookieSource 读 goofish cookie 后断开；缺登录态抛 UNAUTHORIZED。 */
async function readLoginJarFromChrome(port: number): Promise<CookieJar> {
  const target = await attachChrome(port)
  const connection = await CdpConnection.connect(target.browserWsUrl)
  try {
    return await new CdpCookieSource(connection).readGoofishCookies()
  } finally {
    await connection.close()
    await target.close()
  }
}

/** 默认睡眠：可被 AbortSignal 提前唤醒，避免 HTTP 客户端断开后还挂着 2s 定时器。 */
function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout((): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(cancelledError())
    }
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 默认「确保有浏览器」：端口上已有带调试端口的 Chrome 就复用（真人 profile，反检测最好），
 * 没有就自己起一个带窗口的 Chrome（独立 profile，避免和用户正在用的浏览器抢锁）。
 */
async function ensureLoginBrowser(port: number, profileDir: string | undefined): Promise<() => Promise<void>> {
  if (await browserReachable(port)) return async (): Promise<void> => {}
  const launched = await launchChrome({
    port,
    headless: false,
    userDataDir: profileDir ?? join(homedir(), '.bigfish', 'chrome-profile'),
  })
  return launched.close
}

/** 探一下端口上有没有可用的 DevTools；没有就返回 false（由调用方决定是否自起浏览器）。 */
async function browserReachable(port: number): Promise<boolean> {
  try {
    const target = await attachChrome(port)
    await target.close()
    return true
  } catch (error) {
    // 端口没人听、返回非 200、响应不是 DevTools JSON 都属于「这个端口用不了」；
    // 自起的浏览器会给出更准确的失败原因（找不到 Chrome / DevTools 未就绪）。
    void error
    return false
  }
}

/** 释放浏览器失败不该盖住登录结果或真实错误：只报一条告警。 */
async function releaseQuietly(release: () => Promise<void>, onWarn: ((message: string) => void) | undefined): Promise<void> {
  try {
    await release()
  } catch (error) {
    onWarn?.('关闭扫码浏览器失败：' + toXianyuError(error).message)
  }
}

/**
 * 扫码登录并落库：先确保有浏览器，再等登录态，最后复用 saveImportedAccount 做账号 id 推导与加密写入。
 * 返回 ImportedAccount + elapsedMs；不含任何 cookie 值。
 */
export async function loginAndSave(deps: LoginDeps, input: LoginInput = {}): Promise<LoginResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const ensure = deps.ensureBrowser ?? ((port: number): Promise<() => Promise<void>> => ensureLoginBrowser(port, deps.browserProfileDir))
  const release = await ensure(input.port ?? DEFAULT_PORT)
  try {
    const jar = await waitForLogin(input, deps)
    const saveInput = input.accountId === undefined ? {} : { accountId: input.accountId }
    const imported = await saveImportedAccount(
      { credentials: deps.credentials, ...(deps.now === undefined ? {} : { now: deps.now }) },
      jar,
      saveInput,
    )
    return { ...imported, elapsedMs: now() - startedAt }
  } finally {
    await releaseQuietly(release, deps.onWarn)
  }
}
