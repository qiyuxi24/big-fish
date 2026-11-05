#!/usr/bin/env node
/**
 * daemon 常驻管理：start / stop / restart / status / logs。
 *
 * 为什么需要它：pnpm daemon 是前台阻塞进程，关终端即丢现场；本脚本用 detached 子进程 + 日志重定向
 * + pid 文件把 daemon 变成「过夜跑」的常驻服务，并提供单实例保护与健康检查。
 *
 * 分层：纯逻辑在 ./lib/daemon-service.mjs（单测覆盖），副作用在 ./lib/daemon-runtime.mjs，
 * 本文件只做子命令编排、用户可见文案与退出码（0 成功 / 1 失败 / 2 参数错误）。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_LOG_TAIL,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_STATUS_TAIL,
  DEFAULT_STOP_TIMEOUT_MS,
  evaluateServiceState,
  formatBytes,
  formatUptime,
  healthUrl,
  parseServiceArgs,
  resolveDaemonPort,
  resolveServicePaths,
} from './lib/daemon-service.mjs'
import {
  forceKill,
  healthCheck,
  isPortInUse,
  isProcessAlive,
  killQuietly,
  logTail,
  messageOf,
  readPidRecord,
  removePidFile,
  requestStop,
  rotateLogIfNeeded,
  spawnDaemon,
  waitForExit,
  waitForPortFree,
  waitForReady,
  writePidRecord,
} from './lib/daemon-runtime.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const daemonCliPath = join(repoRoot, 'packages', 'daemon', 'src', 'cli.ts')
const isWindows = process.platform === 'win32'

const USAGE_TEXT = [
  'bigfish daemon 常驻管理',
  '',
  '用法（npm scripts 等价于下面这些子命令）：',
  '  pnpm daemon:start   [-- 选项]      后台启动（已有实例则复用）',
  '  pnpm daemon:stop    [-- 选项]      优雅停止（超时强杀）',
  '  pnpm daemon:restart [-- 选项]      先 stop 再 start',
  '  pnpm daemon:status  [-- 选项]      查看 pid / 端口 / uptime / 日志尾部',
  '  pnpm daemon:logs    [-- --tail N]  打印日志尾部（不跟随）',
  '',
  '选项：',
  '  --port PORT        监听端口，默认 47001（也可用环境变量 BF_PORT）',
  '  --host HOST        监听地址，只允许回环（127.0.0.1 / localhost / ::1）',
  '  --data-dir DIR     传给 daemon 的数据目录（SQLite / token / 凭据）',
  '  --state-dir DIR    状态目录（pid 与日志），默认 ' +
    (isWindows ? '%LOCALAPPDATA%\\bigfish' : '~/.bigfish'),
  '  --tail N           日志行数：logs 默认 ' + String(DEFAULT_LOG_TAIL) + '，status 默认 ' + String(DEFAULT_STATUS_TAIL),
  '  --timeout-ms MS    start 等 /health 的超时（默认 ' + String(DEFAULT_START_TIMEOUT_MS) + '）',
  '                     stop 等进程退出的超时（默认 ' + String(DEFAULT_STOP_TIMEOUT_MS) + '）',
  '  --help, -h         显示本帮助',
  '',
  '退出码：0 成功；1 失败（status 在 daemon 未运行时也返回 1）；2 参数错误。',
  '日志：<状态目录>/logs/daemon.log；pid：<状态目录>/run/daemon.pid',
].join('\n')

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error('✖ ' + messageOf(error))
    process.exitCode = 1
  },
)

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let options
  try {
    options = parseServiceArgs(argv)
  } catch (error) {
    console.error('✖ ' + messageOf(error))
    console.error('')
    console.error(USAGE_TEXT)
    return 2
  }
  if (options.help) {
    console.log(USAGE_TEXT)
    return 0
  }
  const stateDir = options.stateDir === undefined ? undefined : resolve(options.stateDir)
  // 必须把 env 透传下去：resolveServicePaths 缺省会当成 {}，win32 分支就拿不到 LOCALAPPDATA，
  // 于是回退到 ~/.bigfish —— 和插件拉起的 daemon（%LOCALAPPDATA%/bigfish）变成两个状态根。
  const paths = resolveServicePaths({ stateDir, env: process.env })
  if (options.command === 'start') return cmdStart(options, paths)
  if (options.command === 'stop') return cmdStop(options, paths)
  if (options.command === 'restart') return cmdRestart(options, paths)
  if (options.command === 'status') return cmdStatus(options, paths)
  return cmdLogs(options, paths)
}

/**
 * @param {object} options
 * @param {{pidPath: string, logPath: string, runDir: string, logDir: string, root: string}} paths
 * @returns {Promise<number>}
 */
async function cmdStart(options, paths) {
  const host = options.host ?? '127.0.0.1'
  const port = resolveDaemonPort(options, process.env)
  const dataDir = options.dataDir === undefined ? undefined : resolve(options.dataDir)

  const existing = readPidRecord(paths.pidPath)
  if (existing.exists && existing.record === undefined) {
    console.log('· 清理无法解析的 pid 文件：' + paths.pidPath)
    removePidFile(paths.pidPath)
  } else if (existing.record !== undefined) {
    const record = existing.record
    const recordHost = record.host ?? host
    const recordPort = record.port ?? port
    const health = await healthCheck(recordHost, recordPort)
    const state = evaluateServiceState({ pidRecord: record, processAlive: isProcessAlive(record.pid), health })
    if (state.state === 'running') {
      console.log('✔ daemon 已在运行（pid ' + String(record.pid) + '），本次不重复启动')
      printAddress(recordHost, recordPort, health)
      console.log('  日志     ' + (record.logPath ?? paths.logPath))
      console.log('  提示     pnpm daemon:restart 可重启；pnpm daemon:status 看详情')
      return 0
    }
    if (state.state === 'unhealthy') {
      console.log('✖ daemon 进程存在（pid ' + String(record.pid) + '）但 /health 不通：' + (health?.error ?? '未知错误'))
      printLogTail(record.logPath ?? paths.logPath, 20, '  ')
      console.log('  建议：pnpm daemon:stop 后重新 start')
      return 1
    }
    console.log('· 清理残留 pid 文件（pid ' + String(record.pid) + ' 已不存在）')
    removePidFile(paths.pidPath)
  }

  // 单实例第二道闸：端口上是否已有 daemon 在应答（可能手动启动、pid 文件丢了）
  const probe = await healthCheck(host, port)
  if (probe.ok) {
    if (probe.pid !== undefined && isProcessAlive(probe.pid)) {
      writePidRecord(paths.pidPath, {
        pid: probe.pid,
        port,
        host,
        startedAt: Date.now() - (probe.uptimeMs ?? 0),
        dataDir,
        logPath: paths.logPath,
      })
      console.log('✔ 发现已运行的 daemon（pid ' + String(probe.pid) + '），已登记 pid 文件，未重复启动')
      printAddress(host, port, probe)
      console.log('  日志     ' + paths.logPath)
      return 0
    }
    console.log('✖ 端口 ' + String(port) + ' 上有进程响应 /health，但拿不到可用 pid，无法确认归属')
    return 1
  }
  if (await isPortInUse(host, port)) {
    console.log('✖ 端口 ' + String(port) + ' 已被其他进程占用（不是本 daemon）')
    console.log('  换端口：pnpm daemon:start -- --port <端口>；或先结束占用进程')
    return 1
  }

  // 启动前收拾一次日志：stdout 是 direct-append、运行中没法安全 rename，
  // 只有现在没新进程持有该文件。涨过 8MB 就滚成 .1，只留一份历史。
  const rotated = rotateLogIfNeeded(paths.logPath)
  if (rotated.rotated) {
    console.log('· 日志已轮转：' + paths.logPath + ' → ' + paths.logPath + '.1（原本 ' + formatBytes(rotated.size) + '）')
  }

  const spawned = spawnDaemon({ repoRoot, cliPath: daemonCliPath, dataDir, port, host, logPath: paths.logPath })
  if (spawned.pid === undefined) {
    console.log('✖ 子进程没有 pid，启动失败')
    return 1
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const ready = await waitForReady({ pid: spawned.pid, host, port, timeoutMs, getSpawnError: spawned.getSpawnError })
  if (!ready.ok) {
    console.log('✖ daemon 启动失败：' + ready.reason)
    printLogTail(paths.logPath, 20, '  ')
    await killQuietly(spawned.pid)
    removePidFile(paths.pidPath)
    return 1
  }
  writePidRecord(paths.pidPath, {
    pid: spawned.pid,
    port,
    host,
    startedAt: Date.now() - (ready.health.uptimeMs ?? 0),
    dataDir,
    logPath: paths.logPath,
  })
  console.log('✔ daemon 已启动')
  printAddress(host, port, ready.health)
  console.log('  pid      ' + String(spawned.pid))
  if (dataDir !== undefined) console.log('  数据目录 ' + dataDir)
  console.log('  日志     ' + paths.logPath)
  console.log('  停止     pnpm daemon:stop')
  return 0
}

/**
 * @param {object} options
 * @param {{pidPath: string, logPath: string}} paths
 * @returns {Promise<number>}
 */
async function cmdStop(options, paths) {
  const host = options.host ?? '127.0.0.1'
  const port = resolveDaemonPort(options, process.env)
  const existing = readPidRecord(paths.pidPath)
  if (!existing.exists) {
    const health = await healthCheck(host, port)
    if (health.ok) {
      console.log('daemon 未登记 pid 文件，但端口 ' + String(port) + ' 上有 /health 响应（pid ' + String(health.pid ?? '未知') + '）')
      console.log('  先 pnpm daemon:start 接管登记，或手动结束该进程')
      return 1
    }
    console.log('daemon 未在运行（没有 pid 文件）')
    return 0
  }
  if (existing.record === undefined) {
    console.log('· pid 文件无法解析，按未运行处理并清理：' + paths.pidPath)
    removePidFile(paths.pidPath)
    return 0
  }
  const record = existing.record
  const recordHost = record.host ?? host
  const recordPort = record.port ?? port
  if (!isProcessAlive(record.pid)) {
    // pid 文件里的进程已经没了，但端口上可能还有一个（面板拉起的那个从不登记 pid）。
    // 这里 return 0 是最伤信任的一类谎：用户以为停了，其实它还在抢队列继续发。
    const health = await healthCheck(recordHost, recordPort)
    if (health.ok) {
      console.log('· pid 文件里的进程 ' + String(record.pid) + ' 已不存在，但端口 ' + String(recordPort) + ' 上还有 daemon 在应答')
      const livePid = health.pid
      if (livePid === undefined) {
        console.log('✖ 健康响应里没有 pid，无法确认归属，本次未做任何操作')
        console.log('  建议：手动确认该端口上的进程后结束，或换端口重启')
        return 1
      }
      console.log('  按端口上的实例处理（pid ' + String(livePid) + '）')
      const code = await stopPid(livePid, { timeoutMs: options.timeoutMs, host: recordHost, port: recordPort })
      if (code === 0) {
        removePidFile(paths.pidPath)
        console.log('  并清理了残留 pid 文件 ' + paths.pidPath)
      }
      return code
    }
    console.log('· 进程 ' + String(record.pid) + ' 已不存在，清理残留 pid 文件')
    removePidFile(paths.pidPath)
    return 0
  }
  const code = await stopPid(record.pid, { timeoutMs: options.timeoutMs, host: recordHost, port: recordPort })
  if (code === 0) removePidFile(paths.pidPath)
  return code
}

/**
 * 请求一个 pid 停止并确认端口释放（cmdStop 的两条分支共用）。
 * @param {number} pid
 * @param {{timeoutMs: number | undefined, host: string, port: number}} input
 * @returns {Promise<number>}
 */
async function stopPid(pid, input) {
  console.log('· 已请求停止（pid ' + String(pid) + '，方式 ' + requestStop(pid) + '）')
  const timeoutMs = input.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  let exited = await waitForExit(pid, timeoutMs)
  if (!exited) {
    console.log('· ' + String(timeoutMs) + 'ms 内未退出，强制结束')
    try {
      forceKill(pid)
    } catch (error) {
      console.log('· 强制结束失败：' + messageOf(error))
    }
    exited = await waitForExit(pid, 3000)
  }
  if (!exited) {
    console.log('✖ 无法结束进程 ' + String(pid) + '（pid 文件保留，便于排查）')
    return 1
  }
  if (!(await waitForPortFree(input.host, input.port, 3000))) {
    console.log('✖ 端口 ' + String(input.port) + ' 仍被占用')
    return 1
  }
  console.log('✔ daemon 已停止（pid ' + String(pid) + '），端口 ' + String(input.port) + ' 已释放')
  return 0
}

/**
 * @param {object} options
 * @param {{pidPath: string, logPath: string}} paths
 * @returns {Promise<number>}
 */
async function cmdRestart(options, paths) {
  const stopCode = await cmdStop(options, paths)
  if (stopCode !== 0) return stopCode
  return cmdStart(options, paths)
}

/**
 * @param {object} options
 * @param {{pidPath: string, logPath: string}} paths
 * @returns {Promise<number>}
 */
async function cmdStatus(options, paths) {
  const host = options.host ?? '127.0.0.1'
  const port = resolveDaemonPort(options, process.env)
  const existing = readPidRecord(paths.pidPath)
  const record = existing.record
  const recordHost = record?.host ?? host
  const recordPort = record?.port ?? port
  const health = await healthCheck(recordHost, recordPort)
  const state = evaluateServiceState({
    pidRecord: record,
    processAlive: record === undefined ? false : isProcessAlive(record.pid),
    health,
  })
  const tailCount = options.tail ?? DEFAULT_STATUS_TAIL
  const logPath = record?.logPath ?? paths.logPath

  if (state.state === 'running') {
    console.log('✔ daemon 正在运行')
    console.log('  地址     ' + healthUrl({ host: recordHost, port: recordPort }))
    if (health?.version !== undefined) console.log('  版本     ' + health.version)
    console.log('  pid      ' + String(state.pid ?? '未知'))
    console.log('  运行时长 ' + formatUptime(health?.uptimeMs ?? (record?.startedAt === undefined ? 0 : Date.now() - record.startedAt)))
    if (record?.dataDir !== undefined) console.log('  数据目录 ' + record.dataDir)
    console.log('  日志     ' + logPath)
    printLogTail(logPath, tailCount, '  ')
    return 0
  }
  if (state.state === 'unhealthy') {
    console.log('✖ daemon 进程存在（pid ' + String(state.pid ?? '未知') + '）但 /health 不通：' + (health?.error ?? '未知错误'))
    console.log('  地址     ' + healthUrl({ host: recordHost, port: recordPort }))
    console.log('  日志     ' + logPath)
    printLogTail(logPath, tailCount, '  ')
    console.log('  建议：pnpm daemon:stop 后 pnpm daemon:start')
    return 1
  }
  if (state.state === 'unmanaged') {
    console.log('✔ daemon 正在运行（pid ' + String(state.pid ?? '未知') + '），但没有登记 pid 文件')
    printAddress(recordHost, recordPort, health)
    console.log('  日志     ' + logPath)
    printLogTail(logPath, tailCount, '  ')
    console.log('  提示：执行一次 pnpm daemon:start 会接管登记（不会重复启动）')
    return 0
  }
  if (state.state === 'stale-pid') {
    console.log('✖ daemon 未在运行：pid 文件指向的进程 ' + String(record?.pid ?? '未知') + ' 已不存在')
    if (health.ok) {
      console.log('  注意：端口 ' + String(recordPort) + ' 上仍有 /health 响应（pid ' + String(health.pid ?? '未知') + '），可能是另一个实例')
    }
    console.log('  状态文件 ' + paths.pidPath)
    console.log('  日志     ' + logPath)
    console.log('  提示：pnpm daemon:start 会自动清理残留 pid 文件')
    return 1
  }
  console.log('daemon 未在运行')
  if (existing.exists) console.log('  注意：pid 文件无法解析，start 时会自动清理：' + paths.pidPath)
  console.log('  状态文件 ' + paths.pidPath)
  console.log('  日志     ' + logPath + (existsSync(logPath) ? '' : '（还不存在）'))
  console.log('  提示：pnpm daemon:start 启动')
  return 1
}

/**
 * @param {object} options
 * @param {{pidPath: string, logPath: string}} paths
 * @returns {Promise<number>}
 */
async function cmdLogs(options, paths) {
  const record = readPidRecord(paths.pidPath).record
  const logPath = record?.logPath ?? paths.logPath
  const count = options.tail ?? DEFAULT_LOG_TAIL
  const lines = logTail(logPath, count)
  if (lines === undefined) {
    console.log('日志文件不存在：' + logPath)
    console.log('  提示：daemon 还没通过 pnpm daemon:start 启动过')
    return 1
  }
  if (lines.length === 0) {
    console.log('日志文件是空的：' + logPath)
    return 0
  }
  console.log('日志：' + logPath + '（最后 ' + String(lines.length) + ' 行）')
  for (const line of lines) console.log(line)
  return 0
}

function printAddress(host, port, health) {
  console.log('  地址     ' + healthUrl({ host, port }))
  if (health?.version !== undefined) console.log('  版本     ' + health.version)
  if (health?.uptimeMs !== undefined) console.log('  运行时长 ' + formatUptime(health.uptimeMs))
}

function printLogTail(logPath, count, indent) {
  const lines = logTail(logPath, count)
  if (lines === undefined || lines.length === 0) return
  console.log('  最近日志：')
  for (const line of lines) console.log(indent + line)
}
