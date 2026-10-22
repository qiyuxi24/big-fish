/**
 * daemon 常驻服务的副作用层：文件、进程、信号、HTTP 探测、spawn、就绪轮询。
 *
 * 为什么要单独一个文件：AGENTS 规定单文件 ≤400 行；纯逻辑在 ./daemon-service.mjs，
 * 这里只包装 Node 的 fs / net / child_process，编排与文案留在 ../daemon-service.mjs。
 * 本文件不做单测（会起进程/连端口），可测的决定性逻辑一律放回纯函数层。
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { daemonArgs, formatPidFile, healthUrl, parsePidFile, tailLines } from './daemon-service.mjs'

const isWindows = process.platform === 'win32'

/**
 * 读 pid 文件：exists 表示文件在不在，record 表示能否解析成有效记录。
 * @param {string} pidPath
 * @returns {{exists: boolean, record: {pid: number, port?: number, host?: string, startedAt?: number, dataDir?: string, logPath?: string} | undefined}}
 */
export function readPidRecord(pidPath) {
  if (!existsSync(pidPath)) return { exists: false, record: undefined }
  let raw
  try {
    raw = readFileSync(pidPath, 'utf8')
  } catch {
    return { exists: true, record: undefined }
  }
  return { exists: true, record: parsePidFile(raw) }
}

/**
 * 写 pid 文件（0600：里面只有本机进程信息，但也没必要给别人读）。
 * @param {string} pidPath
 * @param {{pid: number, port?: number, host?: string, startedAt?: number, dataDir?: string, logPath?: string}} record
 */
export function writePidRecord(pidPath, record) {
  mkdirSync(dirname(pidPath), { recursive: true })
  writeFileSync(pidPath, formatPidFile(record), { mode: 0o600 })
}

/**
 * @param {string} pidPath
 */
export function removePidFile(pidPath) {
  rmSync(pidPath, { force: true })
}

/**
 * 进程是否存活：kill(pid, 0) 只做存在性检查；EPERM 说明进程在、只是没权限（同用户下不该出现）。
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * GET /health：只认 {ok:true,data:{pid,version,uptimeMs}} 这个信封；连不上/超时/格式不符都算不健康。
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, port?: number, pid?: number, version?: string, uptimeMs?: number, error?: string}>}
 */
export async function healthCheck(host, port, timeoutMs) {
  let url
  try {
    url = healthUrl({ host, port })
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs ?? 1500) })
    if (!response.ok) return { ok: false, error: 'HTTP ' + String(response.status) }
    const body = await response.json()
    if (typeof body !== 'object' || body === null || body.ok !== true) return { ok: false, error: '健康响应格式不符' }
    const data = typeof body.data === 'object' && body.data !== null ? body.data : {}
    const result = { ok: true, port }
    if (typeof data.pid === 'number') result.pid = data.pid
    if (typeof data.version === 'string') result.version = data.version
    if (typeof data.uptimeMs === 'number') result.uptimeMs = data.uptimeMs
    return result
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * 端口是否有人监听（只连不写，用来区分「daemon 未就绪」与「端口被别人占了」）。
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isPortInUse(host, port, timeoutMs) {
  return await new Promise((resolvePromise) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs ?? 1000, () => finish(false))
  })
}

/**
 * 等端口真正释放：Windows 上 TerminateProcess 后监听套接字可能还会短暂占用，立即探测会误报。
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitForPortFree(host, port, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!(await isPortInUse(host, port))) return true
    await sleep(100)
  }
  return !(await isPortInUse(host, port))
}

/**
 * 请求停止进程：POSIX 发 SIGTERM（daemon 的 SIGTERM handler 会优雅 close）；
 * Windows 无法跨进程投递可捕获信号：先 taskkill /T（不带 /F，控制台程序通常会失败），失败回落 TerminateProcess。
 * @param {number} pid
 * @returns {string} 实际使用的方式，便于日志与用户排查
 */
export function requestStop(pid) {
  if (isWindows) {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true, timeout: 5000 })
    if (result.error === undefined && result.status === 0) return 'taskkill /T'
    try {
      process.kill(pid)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      return 'process.kill（进程已退出）'
    }
    return 'process.kill'
  }
  process.kill(pid, 'SIGTERM')
  return 'SIGTERM'
}

/**
 * 强杀：超时后的最后手段。Windows 上 SQLite 走 WAL + 队列租约可容忍这种非优雅退出。
 * @param {number} pid
 */
export function forceKill(pid) {
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
    try {
      process.kill(pid)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    return
  }
  process.kill(pid, 'SIGKILL')
}

/**
 * 等进程退出（轮询 100ms）。
 * @param {number} pid
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitForExit(pid, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) return true
    await sleep(100)
  }
  return !isProcessAlive(pid)
}

/**
 * 启动失败时清掉半启动的子进程，避免留下孤儿占端口。
 * @param {number} pid
 */
export async function killQuietly(pid) {
  if (!isProcessAlive(pid)) return
  try {
    forceKill(pid)
  } catch (error) {
    console.log('· 清理半启动进程失败：' + messageOf(error))
    return
  }
  await waitForExit(pid, 3000)
}

/**
 * detached 启动 daemon，stdout/stderr 直接重定向到日志文件。
 * @param {{repoRoot: string, cliPath: string, dataDir?: string, port: number, host: string, logPath: string}} input
 * @returns {{child: import('node:child_process').ChildProcess, pid: number | undefined, getSpawnError: () => Error | undefined}}
 */
export function spawnDaemon(input) {
  const args = [input.cliPath, ...daemonArgs({ dataDir: input.dataDir, port: input.port, host: input.host })]
  let logFd
  try {
    mkdirSync(dirname(input.logPath), { recursive: true })
    logFd = openSync(input.logPath, 'a')
  } catch (error) {
    throw new Error('打不开日志文件 ' + input.logPath + '：' + messageOf(error))
  }
  let spawnError
  let child
  try {
    child = spawn(process.execPath, args, {
      cwd: input.repoRoot,
      env: process.env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    })
    child.once('error', (error) => {
      spawnError = error
    })
  } catch (error) {
    throw new Error('启动 daemon 子进程失败：' + messageOf(error))
  } finally {
    closeSync(logFd)
  }
  child.unref()
  return { child, pid: child.pid, getSpawnError: () => spawnError }
}

/**
 * 轮询 /health 直到就绪、子进程退出或超时。
 * @param {{pid: number, host: string, port: number, timeoutMs: number, getSpawnError: () => Error | undefined}} input
 * @returns {Promise<{ok: true, health: {pid?: number, version?: string, uptimeMs?: number}} | {ok: false, reason: string}>}
 */
export async function waitForReady(input) {
  const started = Date.now()
  let lastError = '还没有响应'
  while (Date.now() - started < input.timeoutMs) {
    const spawnError = input.getSpawnError()
    if (spawnError !== undefined) return { ok: false, reason: '子进程启动失败：' + messageOf(spawnError) }
    if (!isProcessAlive(input.pid)) return { ok: false, reason: '子进程已退出（日志见下）' }
    const health = await healthCheck(input.host, input.port)
    if (health.ok) {
      if (health.pid !== undefined && health.pid !== input.pid) {
        return {
          ok: false,
          reason: '端口 ' + String(input.port) + ' 上应答 /health 的是 pid ' + String(health.pid) + '，不是刚启动的 ' + String(input.pid),
        }
      }
      return { ok: true, health }
    }
    lastError = health.error ?? lastError
    await sleep(250)
  }
  return { ok: false, reason: '等待 /health 超时（' + String(input.timeoutMs) + 'ms）：' + lastError }
}

/**
 * 读日志尾部 N 行；文件不存在返回 undefined（区别于「文件在但为空」）。
 * @param {string} logPath
 * @param {number} count
 * @returns {string[] | undefined}
 */
export function logTail(logPath, count) {
  if (!existsSync(logPath)) return undefined
  let text
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return undefined
  }
  return tailLines(text, count)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
