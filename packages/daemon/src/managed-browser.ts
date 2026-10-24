/**
 * 托管浏览器：daemon 自己养一个带调试端口的 Chrome，扫码登录 / 导入 / 发布共用同一份登录态。
 *
 * 为什么需要：原来有三个互不相干的浏览器上下文（用户手动开的导入用、扫码时临时起又立刻关的、
 * 发布用的），结果是——扫码登完窗口立刻被关掉，会话失去唯一能替它续期的载体；发布又在另一个
 * 浏览器里校验「必须同账号」（cdp-publish 的 assertSameAccount），很容易对不上号。
 * 托管之后只有一个实例、一份 profile，登录态、发布、导入都指向它。
 *
 * 边界：
 * - 只托管「我们自己拉起的」实例：`stop()` 绝不关用户手动开的调试浏览器（那个可能是人家的工作窗口）。
 * - 端口与 profile 由数据目录决定（换 `--data-dir` 就等于换一套登录态），profile 固定
 *   `<dataDir>/chrome-profile`，与用户的真实浏览器隔离，不抢 profile 锁。
 * - headful 优先：真人浏览器反检测最好，也是扫码的前提；无桌面环境才用 headless（能力更弱）。
 * @module @bigfish/daemon/managed-browser
 */
import { fail } from '@bigfish/core'
import type { Logger } from '@bigfish/core'
import { attachChrome, launchChrome } from '@bigfish/channel-cdp'

/** 与 channel-cdp 的 DEFAULT_PORT 同口径；这里显式写死，避免装配层依赖通道内部常量。 */
export const DEFAULT_MANAGED_BROWSER_PORT = 9222

/** 只保留「能关掉」这一件事：launchChrome 的返回值结构上满足它。 */
export interface BrowserHandle {
  close(): Promise<void>
}

export interface BrowserStatus {
  /** port/profileDir 为面板与排障服务；不含任何 cookie 或页面内容。 */
  port: number
  profileDir: string
  /** 端口上现在有没有可用的 DevTools。 */
  running: boolean
  /** true = 这个实例是 daemon 拉起的（停 daemon 会关掉它）；false = 复用用户自己开的。 */
  owned: boolean
  headless: boolean
}

export interface LaunchRequest {
  port: number
  userDataDir: string
  headless: boolean
}

export interface ManagedBrowserDeps {
  port: number
  profileDir: string
  /** 探测端口上是否已有可用的 DevTools；默认 attachChrome。 */
  probe?: (port: number) => Promise<boolean>
  /** 拉起浏览器；默认 launchChrome（headful）。 */
  launch?: (request: LaunchRequest) => Promise<BrowserHandle>
  /** 自起浏览器是否 headless，默认 false。 */
  headless?: boolean
  logger?: Logger
}

export interface ManagedBrowser {
  readonly port: number
  readonly profileDir: string
  /**
   * 确保端口上有可用的浏览器：已有就复用（可能是用户开的），没有就拉起一个并一直留着。
   * 单飞：并发调用共享同一次启动，避免面板连点开出两个窗口。
   */
  ensure(): Promise<BrowserStatus>
  /** 只探测，不启动（面板展示用）。 */
  status(): Promise<BrowserStatus>
  /** 关掉「我们自己拉起的」实例；复用来的外部浏览器一律不动。 */
  stop(): Promise<void>
}

/** 端口合法性在装配边界校验一次，坏值不进入浏览器调用。 */
function assertPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail('VALIDATION', '托管浏览器端口必须是 1..65535 的整数：' + String(port))
  }
  return port
}

/** 默认探测：能 attach 就说明端口上有 DevTools；这里只关心「有没有」，不关心是谁起的。 */
async function probePort(port: number): Promise<boolean> {
  try {
    const target = await attachChrome(port)
    await target.close()
    return true
  } catch {
    // 连不上 / 返回非 200 / 不是 DevTools JSON 都算「这个端口用不了」；
    // 真正拉起时的失败原因由 launchChrome 给出（找不到 Chrome、端口被占等）。
    return false
  }
}

/** 默认拉起：headful Chrome + 固定 profile；返回的 close 只杀这个子进程。 */
async function launchBrowser(request: LaunchRequest): Promise<BrowserHandle> {
  const launched = await launchChrome({
    port: request.port,
    headless: request.headless,
    userDataDir: request.userDataDir,
  })
  return { close: launched.close }
}

export function createManagedBrowser(deps: ManagedBrowserDeps): ManagedBrowser {
  const port = assertPort(deps.port)
  const profileDir = deps.profileDir
  if (profileDir.trim() === '') fail('VALIDATION', '托管浏览器 profileDir 不能为空')
  const headless = deps.headless ?? false
  const probe = deps.probe ?? probePort
  const launch = deps.launch ?? launchBrowser
  const logger = deps.logger

  let handle: BrowserHandle | undefined
  let inflight: Promise<BrowserStatus> | undefined
  let stopped = false

  const snapshot = (running: boolean): BrowserStatus => ({
    port,
    profileDir,
    running,
    owned: handle !== undefined,
    headless,
  })

  /** 记住的句柄可能已被用户手动关掉：以端口探测为准，死句柄直接忘掉（下次 ensure 会重拉）。 */
  const forgetIfDead = (alive: boolean): void => {
    if (alive || handle === undefined) return
    handle = undefined
    logger?.warn('托管浏览器已退出（窗口被关闭或崩溃），下次使用时重新拉起', { port })
  }

  const describe = async (): Promise<BrowserStatus> => {
    const alive = await probe(port)
    forgetIfDead(alive)
    return snapshot(alive)
  }

  const start = async (): Promise<BrowserStatus> => {
    if (stopped) fail('INTERNAL', '托管浏览器已关闭（daemon 正在退出）')
    const alive = await probe(port)
    forgetIfDead(alive)
    if (alive) {
      // 端口上已经有调试浏览器：复用它，但**不**接管生命周期（可能正是用户的工作窗口）。
      return snapshot(true)
    }
    logger?.info('拉起托管浏览器（登录/发布共用）', { port, profileDir, headless })
    const launched = await launch({ port, userDataDir: profileDir, headless })
    if (stopped) {
      // 启动途中 daemon 退出：立刻收尾，别把没人管的浏览器留在桌面上。
      await closeQuietly(launched, logger)
      fail('INTERNAL', '托管浏览器启动期间 daemon 已退出')
    }
    handle = launched
    return snapshot(true)
  }

  return {
    port,
    profileDir,
    ensure(): Promise<BrowserStatus> {
      if (inflight !== undefined) return inflight
      const run = start()
      inflight = run
      void run.then(
        () => {
          if (inflight === run) inflight = undefined
        },
        () => {
          if (inflight === run) inflight = undefined
        },
      )
      return run
    },
    status: describe,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      const current = handle
      handle = undefined
      if (current !== undefined) await closeQuietly(current, logger)
    },
  }
}

/** 关浏览器失败只记一条 warn：收尾噪音不该把已经成功的登录/发布变成失败。 */
async function closeQuietly(handle: BrowserHandle, logger: Logger | undefined): Promise<void> {
  try {
    await handle.close()
  } catch (error) {
    logger?.warn('关闭托管浏览器失败', { error: error instanceof Error ? error.message : String(error) })
  }
}
