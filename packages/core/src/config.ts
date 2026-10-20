/**
 * daemon 配置加载：默认值 + 环境变量覆盖 + 显式 override（测试/嵌入用）。
 * 非法值一律 VALIDATION，并在 message 里点名是哪个键，避免 daemon 静默跑错端口。
 * @module @bigfish/core/config
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fail } from './errors.ts'
import { LOG_LEVELS } from './logger.ts'
import type { LogLevel } from './logger.ts'

export interface DaemonConfig {
  host: string
  port: number
  dbPath: string
  tokenPath: string
  credentialsDir: string
  circuitPath: string
  logLevel: LogLevel
  /** 任务租约时长（毫秒）。 */
  leaseTtlMs: number
  /** 队列轮询间隔（毫秒）。 */
  pollIntervalMs: number
}

/** 环境变量形状；接受 process.env 或测试构造的对象。 */
export type EnvLike = Record<string, string | undefined>

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 47001
export const DEFAULT_LOG_LEVEL: LogLevel = 'info'
export const DEFAULT_LEASE_TTL_MS = 60_000
export const DEFAULT_POLL_INTERVAL_MS = 1_000

/** 数据根：Windows 走 LOCALAPPDATA，其他平台走 ~/.local/share。 */
export function defaultDataRoot(env: EnvLike = process.env): string {
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? (env.USERPROFILE === undefined ? undefined : join(env.USERPROFILE, 'AppData', 'Local'))
    return join(localAppData ?? homedir(), 'bigfish')
  }
  return join(homedir(), '.local', 'share', 'bigfish')
}

/**
 * 加载 daemon 配置。优先级：overrides > 环境变量 > 默认值。
 * @param env 环境变量来源，默认 process.env
 * @param overrides 显式覆盖项（测试/嵌入场景）
 */
export function loadDaemonConfig(env: EnvLike = process.env, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const root = env.BF_DATA_DIR === undefined ? defaultDataRoot(env) : assertNonEmpty('环境变量 BF_DATA_DIR', env.BF_DATA_DIR)
  const fromEnv: DaemonConfig = {
    host: readString(env, 'BF_HOST', DEFAULT_HOST),
    // 0 = 让系统分配端口（冒烟/嵌入场景用；真实运行仍是 47001）。
    port: readInt(env, 'BF_PORT', DEFAULT_PORT, 0, 65535),
    dbPath: join(root, 'bigfish.db'),
    tokenPath: join(root, 'daemon.token'),
    credentialsDir: join(root, 'credentials'),
    circuitPath: join(root, 'circuits.json'),
    logLevel: readLogLevel(env, 'BF_LOG_LEVEL', DEFAULT_LOG_LEVEL),
    leaseTtlMs: readInt(env, 'BF_LEASE_TTL_MS', DEFAULT_LEASE_TTL_MS, 1, Number.MAX_SAFE_INTEGER),
    pollIntervalMs: readInt(env, 'BF_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, 1, Number.MAX_SAFE_INTEGER),
  }
  return applyOverrides(fromEnv, overrides)
}

function readString(env: EnvLike, key: string, fallback: string): string {
  const raw = env[key]
  if (raw === undefined) return fallback
  return assertNonEmpty('环境变量 ' + key, raw)
}

function assertNonEmpty(label: string, raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') fail('VALIDATION', label + ' 不能为空')
  return trimmed
}

function readInt(env: EnvLike, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (raw === undefined) return fallback
  return parseInteger('环境变量 ' + key, raw, min, max)
}

function readLogLevel(env: EnvLike, key: string, fallback: LogLevel): LogLevel {
  const raw = env[key]
  if (raw === undefined) return fallback
  return parseLogLevel('环境变量 ' + key, raw)
}

function parseInteger(label: string, raw: string, min: number, max: number): number {
  const trimmed = raw.trim()
  if (!/^[+-]?[0-9]+$/.test(trimmed)) fail('VALIDATION', label + ' 必须是整数，实际为 "' + raw + '"')
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('VALIDATION', label + ' 超出允许范围 [' + String(min) + ', ' + String(max) + ']: ' + raw)
  }
  return value
}

function parseLogLevel(label: string, raw: string): LogLevel {
  const trimmed = raw.trim()
  if (!(LOG_LEVELS as readonly string[]).includes(trimmed)) {
    fail('VALIDATION', label + ' 必须是 ' + LOG_LEVELS.join('|') + ' 之一，实际为 "' + raw + '"')
  }
  return trimmed as LogLevel
}

function applyOverrides(base: DaemonConfig, overrides: Partial<DaemonConfig>): DaemonConfig {
  const host = overrides.host === undefined ? base.host : assertNonEmpty('配置项 host', overrides.host)
  const port = overrides.port === undefined ? base.port : assertInteger('配置项 port', overrides.port, 0, 65535)
  const dbPath = overrides.dbPath === undefined ? base.dbPath : assertNonEmpty('配置项 dbPath', overrides.dbPath)
  const tokenPath = overrides.tokenPath === undefined ? base.tokenPath : assertNonEmpty('配置项 tokenPath', overrides.tokenPath)
  const credentialsDir = overrides.credentialsDir === undefined ? base.credentialsDir : assertNonEmpty('配置项 credentialsDir', overrides.credentialsDir)
  const circuitPath = overrides.circuitPath === undefined ? base.circuitPath : assertNonEmpty('配置项 circuitPath', overrides.circuitPath)
  const logLevel = overrides.logLevel === undefined ? base.logLevel : parseLogLevel('配置项 logLevel', overrides.logLevel)
  const leaseTtlMs = overrides.leaseTtlMs === undefined ? base.leaseTtlMs : assertInteger('配置项 leaseTtlMs', overrides.leaseTtlMs, 1, Number.MAX_SAFE_INTEGER)
  const pollIntervalMs = overrides.pollIntervalMs === undefined ? base.pollIntervalMs : assertInteger('配置项 pollIntervalMs', overrides.pollIntervalMs, 1, Number.MAX_SAFE_INTEGER)
  return { host, port, dbPath, tokenPath, credentialsDir, circuitPath, logLevel, leaseTtlMs, pollIntervalMs }
}

function assertInteger(label: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('VALIDATION', label + ' 超出允许范围 [' + String(min) + ', ' + String(max) + ']: ' + String(value))
  }
  return value
}
