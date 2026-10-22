/**
 * daemon 自动拉起（宿主侧守护）：面板读到 NETWORK 错误时，把本地 daemon 拉起来。
 *
 * 为什么需要：daemon 是独立进程（ADR 0001 的边界），但用户不该为了「打开面板看到实时状态」
 * 先手动跑一条命令。面板每 3 秒轮询 `/bigfish health`，第一次拿到 NETWORK 就等于「daemon 没起」，
 * 这时在宿主进程里 detached 拉起一个 daemon，下一次轮询就能连上。
 *
 * 约束（见 AGENTS §1/§3）：
 * - 只做确定性动作：node 内置 spawn，零第三方依赖；
 * - 失败不刷屏：冷却窗口内只尝试一次，失败原因写进 `<数据目录>/plugin.log`；
 * - 不写凭据、不打印 token；daemon 自己把 token 落盘，插件照旧每次读文件。
 *
 * @module @bigfish/plugin-ops/src/daemon-supervisor
 */
import { appendFileSync, closeSync, openSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn as spawnProcess } from 'node:child_process'

/** 拉起失败后的冷却窗口：面板 3 秒一轮询，30 秒冷却避免 fork 风暴。 */
export const DEFAULT_START_COOLDOWN_MS = 30_000
/** 等 daemon 就绪的上限：首次启动要建库/读凭据，20 秒足够。 */
export const DEFAULT_READY_TIMEOUT_MS = 20_000
/** 就绪轮询间隔。 */
export const READY_POLL_INTERVAL_MS = 500
/** health 探测超时：daemon 只回一行 JSON，2 秒足够。 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000
/** 拉起失败时回读 daemon.log 的尾部字节数，把真正的错误带进日志。 */
const LOG_TAIL_BYTES = 2048

/** 判断是否普通对象（排除 null 与数组）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从 daemonUrl 解析 spawn 需要的 host/port。
 *
 * daemon 只监听回环地址（packages/daemon/src/config.ts 的 isLoopbackHost），
 * 非回环地址说明用户显式配了远端 daemon：这时不该本地拉起，返回 undefined。
 *
 * @param {string} daemonUrl - 已规范化的 http(s) origin。
 * @returns {{host: string, port: number} | undefined} 端点；远端/非法时 undefined。
 */
export function resolveDaemonEndpoint(daemonUrl) {
  let parsed
  try {
    parsed = new URL(daemonUrl)
  } catch {
    return undefined
  }
  const host = parsed.hostname
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  if (!loopback) return undefined
  const port = parsed.port === '' ? 47001 : Number(parsed.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host: host === 'localhost' ? '127.0.0.1' : host.replace(/^\[|\]$/g, ''), port }
}

/**
 * 选 node 可执行文件：配置 > 当前进程（是 node 时）> PATH 里的 node。
 *
 * 桌面版 DSH 的 process.execPath 是 Electron 可执行文件，直接拿它 spawn `.ts` 会失败，
 * 所以必须落到真正的 node.exe；找不到就返回 undefined（由调用方降级成「请手动启动」）。
 *
 * @param {object} options - 解析上下文。
 * @param {string} [options.configured] - 配置里的 nodePath。
 * @param {string} options.execPath - process.execPath。
 * @param {string} [options.pathEnv] - PATH。
 * @param {(path: string) => boolean} [options.isFile] - 文件存在判定（测试注入）。
 * @param {string} [options.delimiter] - PATH 分隔符，默认按平台。
 * @returns {string | undefined} node 路径。
 */
export function resolveNodeBinary(options = {}) {
  const isFile = typeof options.isFile === 'function' ? options.isFile : (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  if (typeof options.configured === 'string' && options.configured !== '') {
    return isFile(options.configured) ? options.configured : undefined
  }
  const execPath = typeof options.execPath === 'string' ? options.execPath : ''
  if (/[\\/]node(\.exe)?$/i.test(execPath) && isFile(execPath)) return execPath
  const pathEnv = typeof options.pathEnv === 'string' ? options.pathEnv : ''
  const delimiter = typeof options.delimiter === 'string' && options.delimiter !== ''
    ? options.delimiter
    : (process.platform === 'win32' ? ';' : ':')
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd'] : ['node']
  for (const entry of pathEnv.split(delimiter)) {
    const dir = entry.trim().replace(/^"|"$/g, '')
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 找 daemon 入口 `packages/daemon/src/cli.ts`：配置优先，其次按插件包位置推同仓兄弟目录。
 *
 * @param {object} options - 解析上下文。
 * @param {string} [options.configured] - 配置里的 daemonEntry。
 * @param {string} options.pluginDir - 插件包根目录（packages/plugin-ops）。
 * @param {(path: string) => boolean} [options.isFile] - 文件存在判定（测试注入）。
 * @returns {string | undefined} 入口文件绝对路径。
 */
export function resolveDaemonEntry(options = {}) {
  const isFile = typeof options.isFile === 'function' ? options.isFile : (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  if (typeof options.configured === 'string' && options.configured !== '') {
    return isFile(options.configured) ? options.configured : undefined
  }
  const pluginDir = typeof options.pluginDir === 'string' ? options.pluginDir : ''
  if (pluginDir === '') return undefined
  const entry = resolve(pluginDir, '..', 'daemon', 'src', 'cli.ts')
  return isFile(entry) ? entry : undefined
}

/**
 * 组装 spawn 参数：显式传 --data-dir / --port / --host / --token-path，
 * 保证 daemon 与插件读同一份 token、同一份库。
 *
 * @param {object} options - 目标配置。
 * @param {string} options.entry - daemon 入口。
 * @param {string} options.dataDir - 数据目录。
 * @param {string} options.tokenPath - token 文件。
 * @param {string} options.host - 监听地址（回环）。
 * @param {number} options.port - 监听端口。
 * @returns {string[]} spawn 参数（不含 node 自身）。
 */
export function buildSpawnArgs(options) {
  return [
    options.entry,
    '--data-dir', options.dataDir,
    '--token-path', options.tokenPath,
    '--host', options.host,
    '--port', String(options.port),
  ]
}

/**
 * 纯决策：此刻要不要尝试拉起。
 *
 * @param {object} options - 决策输入。
 * @param {boolean} options.enabled - 是否开启自动拉起。
 * @param {number} options.now - 当前毫秒。
 * @param {number | undefined} options.lastAttemptAt - 上次尝试时间。
 * @param {number} [options.cooldownMs] - 冷却窗口。
 * @returns {{attempt: boolean, reason: string}} 决策与原因（写日志用）。
 */
export function decideStart(options = {}) {
  if (options.enabled !== true) return { attempt: false, reason: 'disabled' }
  const cooldown = Number.isInteger(options.cooldownMs) ? options.cooldownMs : DEFAULT_START_COOLDOWN_MS
  const last = Number(options.lastAttemptAt)
  const now = Number(options.now)
  if (Number.isFinite(last) && Number.isFinite(now) && now - last < cooldown) {
    return { attempt: false, reason: 'cooldown' }
  }
  return { attempt: true, reason: 'due' }
}

/**
 * 建 supervisor：注入健康探测/拉起/时钟，纯逻辑可测。
 *
 * @param {object} options - 依赖与配置。
 * @param {boolean} [options.enabled] - 是否允许自动拉起（默认 true）。
 * @param {string} options.daemonUrl - daemon 地址。
 * @param {string} options.dataDir - 数据目录（日志落这里）。
 * @param {string} [options.tokenPath] - token 文件。
 * @param {string} [options.nodePath] - 指定的 node 路径。
 * @param {string} [options.daemonEntry] - 指定的 daemon 入口。
 * @param {string} [options.pluginDir] - 插件包目录（推 daemon 入口用）。
 * @param {(line: string) => void} [options.log] - 事件日志（默认 console.log JSON）。
 * @param {(level: string, message: string, detail?: object) => void} [options.writeLog] - 文件日志。
 * @param {object} [options.effects] - 测试注入：health/spawn/now/sleep/isFile/readTail。
 * @returns {{ensure: (reason?: string, options?: {force?: boolean}) => Promise<object>, snapshot: () => object, enabled: boolean}} supervisor。
 */
export function createDaemonSupervisor(options = {}) {
  const enabled = options.enabled !== false
  const daemonUrl = String(options.daemonUrl ?? '')
  const dataDir = String(options.dataDir ?? '')
  const tokenPath = typeof options.tokenPath === 'string' && options.tokenPath !== ''
    ? options.tokenPath
    : (dataDir === '' ? '' : join(dataDir, 'daemon.token'))
  const logFile = dataDir === '' ? '' : join(dataDir, 'plugin.log')
  const daemonLog = dataDir === '' ? '' : join(dataDir, 'daemon.log')
  const effects = isRecord(options.effects) ? options.effects : {}
  const now = typeof effects.now === 'function' ? effects.now : Date.now
  const sleep = typeof effects.sleep === 'function'
    ? effects.sleep
    : (ms) => new Promise((done) => setTimeout(done, ms))
  const isFile = typeof effects.isFile === 'function' ? effects.isFile : (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  const readTail = typeof effects.readTail === 'function' ? effects.readTail : readLogTail
  const spawn = typeof effects.spawn === 'function' ? effects.spawn : spawnDetached
  const health = typeof effects.health === 'function' ? effects.health : undefined
  const cooldownMs = Number.isInteger(options.cooldownMs) ? options.cooldownMs : DEFAULT_START_COOLDOWN_MS
  const readyTimeoutMs = Number.isInteger(options.readyTimeoutMs) ? options.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS
  const writeLog = typeof options.writeLog === 'function' ? options.writeLog : (level, message, detail) => {
    appendLogLine(logFile, level, message, detail)
  }

  let lastAttemptAt
  let lastError
  let lastStatus = 'idle'
  let inFlight

  /** 探测 daemon 是否已在线：注入优先，否则真实 GET /health。 */
  async function probe() {
    if (typeof health === 'function') return await health()
    return await probeHttp(daemonUrl)
  }

  /** 一次完整尝试：探测 → 解析 node/入口 → spawn → 等就绪。 */
  async function attempt() {
    lastAttemptAt = now()
    const before = await safeProbe(probe)
    if (before.ok) return finish('running', 'daemon 已在线，无需拉起')
    const endpoint = resolveDaemonEndpoint(daemonUrl)
    if (endpoint === undefined) return finish('skipped', 'daemonUrl 不是回环地址，不在本地拉起', { daemonUrl })
    const node = resolveNodeBinary({
      configured: options.nodePath, execPath: process.execPath, pathEnv: process.env.PATH, isFile,
    })
    if (node === undefined) {
      return finish('unavailable', '找不到 node 可执行文件：请配置 nodePath 或手动 pnpm daemon:start', { daemonUrl })
    }
    const entry = resolveDaemonEntry({ configured: options.daemonEntry, pluginDir: options.pluginDir, isFile })
    if (entry === undefined) {
      return finish('unavailable', '找不到 daemon 入口：请配置 daemonEntry 或手动 pnpm daemon:start', { entry })
    }
    const args = buildSpawnArgs({ entry, dataDir, tokenPath, host: endpoint.host, port: endpoint.port })
    let child
    try {
      child = spawn(node, args, { logPath: daemonLog })
    } catch (error) {
      return finish('failed', 'spawn 失败：' + describe(error), {})
    }
    const deadline = now() + readyTimeoutMs
    let exit = undefined
    if (child !== undefined && typeof child.once === 'function') {
      child.once('exit', (code) => { exit = code })
    }
    while (now() < deadline) {
      await sleep(READY_POLL_INTERVAL_MS)
      const probeNow = await safeProbe(probe)
      if (probeNow.ok) {
        return finish('started', 'daemon 已拉起（pid ' + String(child?.pid ?? '?') + '），面板下一次轮询即可连上', { pid: child?.pid })
      }
      if (exit !== undefined) break
    }
    const tail = daemonLog === '' ? '' : readTail(daemonLog, LOG_TAIL_BYTES)
    const detail = { exitCode: exit, daemonLog, tail }
    return finish('failed', 'daemon 起来了但没就绪（' + (exit === undefined ? '超时' : '进程已退出 code=' + String(exit)) + '）', detail)
  }

  /** 收尾：记状态、写日志、返回结构化结果。 */
  function finish(status, message, detail) {
    lastStatus = status
    if (status === 'failed' || status === 'unavailable') lastError = message
    const level = status === 'failed' || status === 'unavailable' ? 'warn' : 'info'
    writeLog(level, message, { status, ...detail })
    if (typeof options.log === 'function') options.log(JSON.stringify({ level, plugin: 'bigfish-ops', msg: message, status, ...detail }))
    return { status, message, detail }
  }

  /**
   * 确保 daemon 在线：单飞 + 冷却；由面板 rpc 拿到 NETWORK 错误时调用。
   *
   * @param {string} [reason] - 触发原因（health / mount / rpc / panel）。
   * @param {{force?: boolean}} [options] - force=true 跳过冷却（面板上人点了「启动」）。
   * @returns {Promise<object>} 尝试结果（永不在调用方炸）。
   */
  async function ensure(reason = 'rpc', options = {}) {
    if (!enabled) return { status: 'disabled', message: '自动拉起已关闭' }
    if (inFlight !== undefined) return await inFlight
    const decision = options.force === true
      ? { attempt: true, reason: 'forced' }
      : decideStart({ enabled, now: now(), lastAttemptAt, cooldownMs })
    if (!decision.attempt) return { status: 'skipped', reason: decision.reason }
    writeLog('info', '收到「daemon 不可达」，开始尝试本地拉起', { reason })
    inFlight = attempt()
      .catch((error) => finish('failed', '拉起异常：' + describe(error), {}))
      .finally(() => { inFlight = undefined })
    return await inFlight
  }

  /** 当前状态快照（诊断/测试用）。 */
  function snapshot() {
    return { enabled, status: lastStatus, lastAttemptAt, lastError, daemonUrl, dataDir, logFile, daemonLog }
  }

  return { ensure, snapshot, enabled }
}

/** 探测失败不抛：任何异常都算「不可达」。 */
async function safeProbe(probe) {
  try {
    const value = await probe()
    return isRecord(value) ? { ok: value.ok === true, value: value.value } : { ok: value === true }
  } catch {
    return { ok: false }
  }
}

/** GET /health：200 即在线（daemon 的 /health 不需要 token）。 */
async function probeHttp(daemonUrl) {
  if (daemonUrl === '') return { ok: false }
  try {
    const response = await fetch(daemonUrl + '/health', { signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS) })
    return { ok: response.ok }
  } catch {
    return { ok: false }
  }
}

/**
 * detached 拉起：日志重定向到 daemon.log，父进程退出后 daemon 仍活着（这是产品行为）。
 *
 * @param {string} command - node 路径。
 * @param {string[]} args - 入口与参数。
 * @param {{logPath: string}} options - 日志文件。
 * @returns {import('node:child_process').ChildProcess} 子进程句柄（已 unref）。
 */
function spawnDetached(command, args, options) {
  const logPath = options?.logPath ?? ''
  let fd
  if (logPath !== '') {
    fd = openSync(logPath, 'a')
  }
  try {
    const child = spawnProcess(command, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
      cwd: dirname(command),
    })
    child.unref()
    return child
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** 追加一行 JSON 日志到插件日志文件；写失败不抛（日志不是主路径）。 */
function appendLogLine(logPath, level, message, detail) {
  if (logPath === '') return
  try {
    const line = JSON.stringify({ level, at: new Date().toISOString(), plugin: 'bigfish-ops', scope: 'daemon-supervisor', msg: message, ...detail })
    appendFileSync(logPath, line + '\n')
  } catch {
    // 日志写不进去（数据目录只读等）不影响自动拉起本身。
  }
}

/** 读日志尾部：daemon 崩溃时把真正的错误带回插件日志。 */
function readLogTail(logPath, maxBytes) {
  try {
    const buffer = readFileSync(logPath)
    const start = Math.max(0, buffer.length - maxBytes)
    return buffer.subarray(start).toString('utf8').trim()
  } catch {
    return ''
  }
}

/** 错误 → 一行字符串（不打印任何凭据；spawn 错误里只有路径与 errno）。 */
function describe(error) {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? error.code : ''
    return code === '' ? error.message : code + ': ' + error.message
  }
  return String(error)
}
