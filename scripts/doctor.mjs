#!/usr/bin/env node
/**
 * 一键体检：把这台机器上 bigfish 的真实状态摊在一屏里。
 *
 * 为什么需要它：dogfooding 时最耗时的不是「有 bug」，而是**不知道文件在哪**——
 * 数据目录（db / token / 凭据）、状态目录（pid / 日志）、chrome-profile 至少有三种算法，
 * 历史上还分化出两份 profile（175MB + 330MB）和两份日志。用户没法自己判断
 * 「我到底是哪一个 daemon 在跑、日志写到了哪、为什么面板说连不上」。
 *
 * 本脚本**只读**，不改任何文件、不启动任何进程（`--json` 给机器读，默认给人类读）。
 * 退出码：0 一切正常 / 1 有要修或建议看一眼的 / 2 参数错误。
 *
 * 判定逻辑（「什么算正常」）在 scripts/lib/doctor.mjs，可单测；本文件只负责读盘与探端口。
 *
 * 用法：
 *   node scripts/doctor.mjs [--json] [--port N] [--data-dir DIR] [--state-dir DIR] [--tail N]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEFAULT_STATUS_TAIL,
  resolveDaemonPort,
  resolveServicePaths,
} from './lib/daemon-service.mjs'
import { healthCheck, isProcessAlive, logTail, messageOf, readPidRecord } from './lib/daemon-runtime.mjs'
import { DOCTOR_FLAGS, diagnose, parseDoctorArgs, renderReport, verdictOf } from './lib/doctor.mjs'

const USAGE_TEXT = [
  'bigfish 一键体检（只读，不启动/不修改任何东西）',
  '',
  '用法：pnpm doctor [-- 选项]',
  '',
  '选项：',
  '  --port PORT        体检哪个端口上的 daemon（默认 47001 / BF_PORT）',
  '  --data-dir DIR     数据目录（db / token / 凭据），默认按 BF_DATA_DIR 或平台默认',
  '  --state-dir DIR    状态目录（pid / 日志），默认 %LOCALAPPDATA%\\bigfish',
  '  --tail N           日志尾部行数，默认 ' + String(DEFAULT_STATUS_TAIL),
  '  --json             输出 JSON（给脚本用）',
  '  --help, -h         显示本帮助',
  '',
  '可用参数：' + DOCTOR_FLAGS.join(' '),
  '退出码：0 正常；1 有需要处理的问题；2 参数错误。',
].join('\n')

/** 探 /health 的超时：本机回环，1.5s 足够，别让体检卡住。 */
const HEALTH_TIMEOUT_MS = 1500

/**
 * 数据根：与 packages/core/src/config.ts 的 defaultDataRoot 同一口径（脚本不能 import 那个包）。
 * @param {Record<string, string | undefined>} env
 * @param {string} platform
 * @returns {string}
 */
function resolveDataRoot(env, platform) {
  if (env.BF_DATA_DIR !== undefined && env.BF_DATA_DIR.trim() !== '') return env.BF_DATA_DIR.trim()
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? (env.USERPROFILE === undefined ? undefined : join(env.USERPROFILE, 'AppData', 'Local'))
    return join(localAppData ?? homedir(), 'bigfish')
  }
  return join(homedir(), '.local', 'share', 'bigfish')
}

/** 递归算目录大小（跳过软链，深度封顶 4 层；profile 目录几千个文件，够用就行）。 */
function dirSize(path, depth = 0) {
  if (depth > 4) return 0
  let total = 0
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += dirSize(child, depth + 1)
    else {
      try {
        total += statSync(child).size
      } catch {
        // 单个文件读不到（权限/已删）不该让整次体检失败。
      }
    }
  }
  return total
}

/** 文件大小；不存在返回 undefined。 */
function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

/** settings.json 存在性 + 可解析性（daemon 起来时读坏了会直接失败，这条要能提前发现）。 */
function inspectSettings(path) {
  if (!existsSync(path)) return { present: false, valid: true, keys: [], path }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    return { present: true, valid: isObject, keys: isObject ? Object.keys(parsed) : [], path }
  } catch (error) {
    return { present: true, valid: false, keys: [], path, error: messageOf(error) }
  }
}

/** 凭据目录里有多少个账号文件（不读内容，只看数量）。 */
function countCredentials(dir) {
  try {
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

/** 收集一份体检快照。全部只读。 */
async function inspect(input) {
  const dataRoot = input.dataDir ?? resolveDataRoot(input.env, input.platform)
  const paths = resolveServicePaths({ stateDir: input.stateDir, env: input.env })
  const dbPath = join(dataRoot, 'bigfish.db')
  const tokenPath = join(dataRoot, 'daemon.token')
  const credentialsDir = join(dataRoot, 'credentials')

  const record = readPidRecord(paths.pidPath)
  const processAlive = record === undefined ? false : isProcessAlive(record.pid)
  const port = input.port ?? record?.port ?? 47001
  const health = await healthCheck(input.host ?? '127.0.0.1', port, HEALTH_TIMEOUT_MS)

  // profile 目录有两种历史算法：现在统一在 dataRoot 下，旧版登录流程曾写到 ~/.bigfish。
  const currentProfile = join(dataRoot, 'chrome-profile')
  const legacyProfile = join(homedir(), '.bigfish', 'chrome-profile')

  return {
    node: process.version,
    platform: input.platform,
    dataRoot,
    stateRoot: paths.root,
    dbPath,
    dbSize: fileSize(dbPath),
    walSize: fileSize(dbPath + '-wal'),
    shmSize: fileSize(dbPath + '-shm'),
    tokenPath,
    tokenSize: fileSize(tokenPath),
    settings: inspectSettings(join(dataRoot, 'settings.json')),
    credentialsDir,
    credentialCount: countCredentials(credentialsDir),
    pidPath: paths.pidPath,
    pidRecord: record,
    processAlive,
    logPath: paths.logPath,
    logSize: fileSize(paths.logPath),
    rotatedLogSize: fileSize(paths.logPath + '.1'),
    pluginLogPath: join(dataRoot, 'plugin.log'),
    pluginLogSize: fileSize(join(dataRoot, 'plugin.log')),
    profile: {
      current: { path: currentProfile, size: existsSync(currentProfile) ? dirSize(currentProfile) : undefined },
      legacy: { path: legacyProfile, size: existsSync(legacyProfile) ? dirSize(legacyProfile) : undefined },
    },
    port,
    health,
    logTail: logTail(paths.logPath, input.tail ?? DEFAULT_STATUS_TAIL) ?? [],
  }
}

async function main(argv) {
  let options
  try {
    options = parseDoctorArgs(argv)
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
  const snapshot = await inspect({
    env: process.env,
    platform: process.platform,
    host: options.host,
    port: options.port ?? resolveDaemonPort({ port: undefined }, process.env),
    dataDir: options.dataDir === undefined ? undefined : resolve(options.dataDir),
    stateDir: options.stateDir === undefined ? undefined : resolve(options.stateDir),
    tail: options.tail,
  })
  const rows = diagnose(snapshot)
  if (options.json) console.log(JSON.stringify({ snapshot, rows }, null, 2))
  else console.log(renderReport(snapshot, rows))
  return verdictOf(rows) === 'ok' ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error('✖ 体检脚本自己崩了：' + messageOf(error))
    process.exitCode = 1
  },
)
