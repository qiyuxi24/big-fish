/**
 * daemon 常驻管理的纯函数层：参数解析、路径解析、pid 文件、日志裁剪、状态判定。
 *
 * 为什么单独拆一个 lib：scripts/daemon-service.mjs 负责 spawn / 信号 / HTTP 这些有副作用的动作，
 * 本文件只放「输入 → 输出」的决定性逻辑，这样单测不用起进程、不用真网络（本机沙箱禁 spawn）。
 *
 * 为什么路径常量自己写一份：scripts 不在 pnpm workspace 里，不能 `import '@bigfish/core'`；
 * DEFAULT_PORT 与 packages/core/src/config.ts 的一致性由单测读取源码断言，避免两处漂移。
 * @module scripts/lib/daemon-service
 */
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

/** 与 packages/core/src/config.ts 的 DEFAULT_PORT 保持一致（单测会核对）。 */
export const DEFAULT_PORT = 47001
/** start 等 /health 就绪的默认超时（毫秒）。 */
export const DEFAULT_START_TIMEOUT_MS = 15_000
/** stop 等进程退出的默认超时（毫秒），超时后强杀。 */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000
/** `logs` 默认尾部行数。 */
export const DEFAULT_LOG_TAIL = 40
/** `status` 默认尾部行数（只给现场感，不刷屏）。 */
export const DEFAULT_STATUS_TAIL = 10
/** `--tail` 上限：只读尾部，不该把整份日志倒进终端。 */
export const MAX_LOG_TAIL = 1000
/**
 * 读日志时最多读文件末尾这么多字节。
 *
 * 为什么要封顶：`logTail` 过去是 `readFileSync(整个文件)` 再切尾。daemon 的 stdout 是
 * `openSync(path,'a')` 直写，没有任何轮转，过夜跑能把日志顶到几百 MB——那时 `pnpm daemon:status`
 * 自己会先卡住甚至 OOM。64KB 足够装下 1000 行普通日志。
 */
export const MAX_LOG_READ_BYTES = 64 * 1024
/** 日志超过这个大小就在 start 时轮转成 `.1`（只保留一份历史）。 */
export const MAX_LOG_BYTES = 8 * 1024 * 1024
/** pid 文件名（放在状态目录的 run/ 下）。 */
export const PID_FILE_NAME = 'daemon.pid'

/** 允许绑定的回环地址白名单；与 packages/daemon/src/config.ts 同义。 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']

/** 支持的子命令。 */
export const SERVICE_COMMANDS = ['start', 'stop', 'restart', 'status', 'logs']

/** 带取值的参数名。 */
const VALUE_FLAGS = new Set(['--port', '--host', '--data-dir', '--state-dir', '--tail', '--timeout-ms'])

/**
 * 是否回环地址：daemon 只在本机，健康检查也不该去连局域网地址。
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(host)
}

/**
 * 解析服务命令参数。
 * @param {readonly string[]} argv 不含 node 与脚本路径
 * @returns {{command: string | undefined, port: number | undefined, host: string | undefined, dataDir: string | undefined, stateDir: string | undefined, tail: number | undefined, timeoutMs: number | undefined, help: boolean}}
 */
export function parseServiceArgs(argv) {
  const options = {
    command: undefined,
    port: undefined,
    host: undefined,
    dataDir: undefined,
    stateDir: undefined,
    tail: undefined,
    timeoutMs: undefined,
    help: false,
  }
  let index = 0
  const first = argv[0]
  if (first !== undefined && !first.startsWith('-')) {
    if (!SERVICE_COMMANDS.includes(first)) {
      throw new Error('未知子命令：' + first + '（可用：' + SERVICE_COMMANDS.join(' / ') + '）')
    }
    options.command = first
    index = 1
  }
  while (index < argv.length) {
    const raw = argv[index]
    const parts = splitFlag(raw)
    if (parts.flag === '--help' || parts.flag === '-h') {
      options.help = true
      index += 1
      continue
    }
    if (!VALUE_FLAGS.has(parts.flag)) throw new Error('未知参数：' + raw)
    const value = takeValue(argv, index, parts)
    if (parts.flag === '--port') options.port = parsePortValue(value, '--port')
    else if (parts.flag === '--host') {
      if (!isLoopbackHost(value)) throw new Error('--host 只允许回环地址（' + LOOPBACK_HOSTS.join(' / ') + '），收到 ' + value)
      options.host = value
    } else if (parts.flag === '--data-dir') options.dataDir = requireNonEmpty(value, '--data-dir')
    else if (parts.flag === '--state-dir') options.stateDir = requireNonEmpty(value, '--state-dir')
    else if (parts.flag === '--tail') options.tail = parseTail(value)
    else options.timeoutMs = parsePositiveInt(value, '--timeout-ms')
    index += parts.inline === undefined ? 2 : 1
  }
  if (!options.help && options.command === undefined) {
    throw new Error('缺少子命令（' + SERVICE_COMMANDS.join(' / ') + '）')
  }
  return options
}

/**
 * 解析端口：--port / BF_PORT / 默认值；常驻模式不接受 0（无法轮询固定端口）。
 * @param {{port: number | undefined}} options parseServiceArgs 的结果
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function resolveDaemonPort(options, env) {
  if (options.port !== undefined) return options.port
  const raw = env['BF_PORT']
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  return parsePortValue(raw.trim(), 'BF_PORT')
}

/**
 * 默认状态根：Windows 走 %LOCALAPPDATA%/bigfish，回退 os.homedir()/.bigfish；
 * 其他平台用 os.homedir()/.bigfish。
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 * @param {string} platform
 * @returns {string}
 */
export function resolveStateRoot(env, home, platform) {
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']
    if (localAppData !== undefined && localAppData.trim() !== '') return join(localAppData.trim(), 'bigfish')
    return join(home, '.bigfish')
  }
  return join(home, '.bigfish')
}

/**
 * 解析 pid / 日志路径。状态根与 daemon 数据目录分离：数据目录可以换（--data-dir），
 * 但「这台机器上哪个 daemon 在跑」是机器级事实，pid 与日志放固定的状态根。
 * @param {{stateDir?: string | undefined, env?: Record<string, string | undefined>, home?: string, platform?: string}} input
 * @returns {{root: string, runDir: string, pidPath: string, logDir: string, logPath: string}}
 */
export function resolveServicePaths(input) {
  const env = input.env ?? {}
  const home = input.home ?? osHomedir()
  const platform = input.platform ?? process.platform
  const root = input.stateDir === undefined ? resolveStateRoot(env, home, platform) : input.stateDir
  const runDir = join(root, 'run')
  const logDir = join(root, 'logs')
  return { root, runDir, pidPath: join(runDir, PID_FILE_NAME), logDir, logPath: join(logDir, 'daemon.log') }
}

/**
 * 解析 pid 文件内容：JSON 记录（新）或纯数字（兼容手写/旧文件）。
 * @param {unknown} raw
 * @returns {{pid: number, port?: number, host?: string, startedAt?: number, dataDir?: string, logPath?: string} | undefined}
 */
export function parsePidFile(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return undefined
  if (text.startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const pid = parsed.pid
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
    const record = { pid }
    if (Number.isSafeInteger(parsed.port) && parsed.port >= 1 && parsed.port <= 65535) record.port = parsed.port
    if (typeof parsed.host === 'string' && parsed.host !== '') record.host = parsed.host
    if (Number.isSafeInteger(parsed.startedAt) && parsed.startedAt > 0) record.startedAt = parsed.startedAt
    if (typeof parsed.dataDir === 'string' && parsed.dataDir !== '') record.dataDir = parsed.dataDir
    if (typeof parsed.logPath === 'string' && parsed.logPath !== '') record.logPath = parsed.logPath
    return record
  }
  if (!/^[0-9]+$/.test(text)) return undefined
  const pid = Number(text)
  return Number.isSafeInteger(pid) && pid > 0 ? { pid } : undefined
}

/**
 * 序列化 pid 文件（固定字段顺序，便于人工读与 diff）。
 * @param {{pid: number, port?: number | undefined, host?: string | undefined, startedAt?: number | undefined, dataDir?: string | undefined, logPath?: string | undefined}} record
 * @returns {string}
 */
export function formatPidFile(record) {
  const clean = { pid: record.pid }
  if (record.port !== undefined) clean.port = record.port
  if (record.host !== undefined) clean.host = record.host
  if (record.startedAt !== undefined) clean.startedAt = record.startedAt
  if (record.dataDir !== undefined) clean.dataDir = record.dataDir
  if (record.logPath !== undefined) clean.logPath = record.logPath
  return JSON.stringify(clean, null, 2) + '\n'
}

/**
 * 拼健康检查 URL（IPv6 回环要加方括号）。
 * @param {{host: string, port: number}} input
 * @returns {string}
 */
export function healthUrl(input) {
  if (!isLoopbackHost(input.host)) throw new Error('健康检查只允许回环地址，收到 ' + input.host)
  const host = input.host === '::1' ? '[::1]' : input.host
  return 'http://' + host + ':' + String(input.port) + '/health'
}

/**
 * 拼给 daemon CLI 的参数（--port 总是显式传，避免脚本与 daemon 各自算默认值）。
 * @param {{dataDir?: string | undefined, port: number, host?: string | undefined}} input
 * @returns {string[]}
 */
export function daemonArgs(input) {
  const args = []
  if (input.dataDir !== undefined) args.push('--data-dir', input.dataDir)
  args.push('--port', String(input.port))
  if (input.host !== undefined) args.push('--host', input.host)
  return args
}

/**
 * 存活判定：pid 文件 + 进程存在 + /health 可达，三者组合出唯一状态。
 *
 * 判定顺序是这里最要紧的东西：只要健康检查有应答就说明有 daemon 活着，
 * 所以「pid 进程已死 + 端口有应答」必须报 unmanaged（真实 pid 取自健康响应），
 * 不能报 stale-pid——后者会被 stop 当成「没什么可停的」直接 return 0。
 * @param {{pidRecord: object | undefined, processAlive: boolean, health: {ok: boolean, pid?: number, port?: number, error?: string} | undefined}} input
 * @returns {{state: 'running' | 'unhealthy' | 'unmanaged' | 'stale-pid' | 'not-running', pid?: number, port?: number}}
 */
export function evaluateServiceState(input) {
  const record = input.pidRecord
  if (record !== undefined && input.processAlive === true) {
    const port = record.port ?? input.health?.port
    if (input.health?.ok === true) return { state: 'running', pid: record.pid, ...(port === undefined ? {} : { port }) }
    return { state: 'unhealthy', pid: record.pid, ...(port === undefined ? {} : { port }) }
  }
  // pid 记录指向的进程已经不在时，不能直接判「没在跑」：另一个实例（面板拉起的、手动起的）
  // 可能正占着端口在应答。先信 /health，按「有人应答但没登记」报真实 pid——
  // 顺序写反会让最常见组合（pid 残留 + daemon 活着）永远落进最坏的分支。
  if (input.health?.ok === true) {
    // pid 只信健康响应：pid 文件里的那个已经确认死了，拿它当「真实 pid」会误导 stop。
    const pid = input.health.pid
    const port = input.health.port ?? record?.port
    return {
      state: 'unmanaged',
      ...(pid === undefined ? {} : { pid }),
      ...(port === undefined ? {} : { port }),
    }
  }
  if (record !== undefined) {
    return { state: 'stale-pid', pid: record.pid, ...(record.port === undefined ? {} : { port: record.port }) }
  }
  return { state: 'not-running' }
}

/**
 * 取日志尾部 N 行（统一 CRLF；丢掉末尾换行产生的空行）。
 * @param {string} text
 * @param {number} count
 * @returns {string[]}
 */
export function tailLines(text, count) {
  const limit = Math.trunc(count)
  if (!Number.isFinite(limit) || limit <= 0) return []
  const normalized = String(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-limit)
}

/**
 * 人类可读的 uptime：<1 分钟只给秒；否则最多两段（1m 5s / 2h 3m / 1d 4h）。
 * @param {number} ms
 * @returns {string}
 */
export function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return String(totalSeconds) + 's'
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return String(minutes) + 'm ' + String(seconds) + 's'
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return String(hours) + 'h ' + String(restMinutes) + 'm'
  return String(Math.floor(hours / 24)) + 'd ' + String(hours % 24) + 'h'
}

/**
 * 人类可读的字节数：只给一位小数，日志/数据库大小够用。
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Math.max(0, Math.floor(bytes))
  if (value < 1024) return String(value) + 'B'
  const units = ['KB', 'MB', 'GB']
  let scaled = value / 1024
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return scaled.toFixed(1) + units[unit]
}

function splitFlag(raw) {
  const eq = raw.indexOf('=')
  if (eq === -1) return { flag: raw, inline: undefined }
  return { flag: raw.slice(0, eq), inline: raw.slice(eq + 1) }
}

function takeValue(argv, index, parts) {
  if (parts.inline !== undefined) {
    if (parts.inline.length === 0) throw new Error('参数缺少取值：' + parts.flag)
    return parts.inline
  }
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('--')) throw new Error('参数缺少取值：' + parts.flag)
  return next
}

function requireNonEmpty(value, flag) {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(flag + ' 不能为空')
  return trimmed
}

function parsePortValue(value, label) {
  const text = String(value).trim()
  if (!/^[0-9]+$/.test(text)) throw new Error(label + ' 必须是整数，收到 ' + JSON.stringify(value))
  const port = Number(text)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(label + ' 超出范围 1..65535：' + text)
  return port
}

function parsePositiveInt(value, label) {
  const text = String(value).trim()
  if (!/^[0-9]+$/.test(text)) throw new Error(label + ' 必须是正整数，收到 ' + JSON.stringify(value))
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(label + ' 必须 ≥1：' + text)
  return parsed
}

function parseTail(value) {
  const tail = parsePositiveInt(value, '--tail')
  if (tail > MAX_LOG_TAIL) throw new Error('--tail 最多 ' + String(MAX_LOG_TAIL) + ' 行，收到 ' + String(tail))
  return tail
}
