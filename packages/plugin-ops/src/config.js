/**
 * 插件配置解析。
 *
 * 为什么用 JS 而不是 TS：本包会被 DSH 宿主进程直接 import，宿主 Node 版本不受我们
 * 控制，不一定支持类型擦除；因此插件层刻意保持"零构建、纯 ESM JavaScript"。
 * 类型信息用 JSDoc，测试用 .ts 写（测试只在我们自己的 Node 24 下跑）。
 *
 * @module @bigfish/plugin-ops/config
 */
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'

/** daemon 默认端口，与 @bigfish/core 的 loadDaemonConfig 默认值保持一致。 */
export const DEFAULT_DAEMON_PORT = 47001
/** 默认请求超时，与 AGENTS.md「IO 超时 15s」一致。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 按「launchEnvironment 快照 → process.env」的顺序取环境变量。
 * DSH 启动器会把 .env 的值放进 launchEnvironment；进程环境可能没有。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {string} name - 环境变量名。
 * @returns {string | undefined} 非空值，或 undefined。
 */
export function resolveEnv(ctx, name) {
  const snapshot = ctx?.get?.('launchEnvironment')
  const fromLaunch = snapshot?.get?.(name)?.value
  if (typeof fromLaunch === 'string' && fromLaunch.length > 0) return fromLaunch
  const fromProcess = process.env[name]
  return typeof fromProcess === 'string' && fromProcess.length > 0 ? fromProcess : undefined
}

/**
 * 解析数据根目录，与 @bigfish/core 的 config.ts 保持同一规则：
 * BF_DATA_DIR > (win32 ? %LOCALAPPDATA%\\bigfish : ~/.local/share/bigfish)。
 *
 * @param {string | undefined} configured - 显式配置值。
 * @param {Record<string, string | undefined>} [env] - 环境变量表，便于测试。
 * @param {string} [platform] - process.platform，便于测试。
 * @returns {string} 绝对路径。
 */
export function resolveDataDir(configured, env = process.env, platform = process.platform) {
  if (typeof configured === 'string' && configured.length > 0) return configured
  const override = env.BF_DATA_DIR
  if (typeof override === 'string' && override.length > 0) return override
  // 用 platform 对应的 path 实现，而不是宿主 path：这样函数可测、行为不随运行平台漂移。
  const joinPath = platform === 'win32' ? win32.join : posix.join
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    if (typeof localAppData === 'string' && localAppData.length > 0) return joinPath(localAppData, 'bigfish')
    return joinPath(homedir(), 'AppData', 'Local', 'bigfish')
  }
  return joinPath(homedir(), '.local', 'share', 'bigfish')
}

/**
 * 规范化插件配置；非法值一律抛 TypeError（fail loud，不留半配置状态）。
 *
 * @param {Record<string, unknown>} [raw] - cordis.patch.yml 里该行的 config。
 * @param {object} [ctx] - Cordis 插件上下文，用于读环境快照。
 * @returns {{enabled: boolean, daemonUrl: string, tokenPath: string, dataDir: string, timeoutMs: number, writeGate: boolean,
 *   autoStartDaemon: boolean, enableAlerts: boolean, nodePath?: string, daemonEntry?: string}}
 */
export function normalizeConfig(raw = {}, ctx) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('bigfish-ops: config 必须是对象')
  }
  // 「是否启用」是设置卡片里的总开关。false 时 apply 不注册任何工具/门禁/rpc/轮询，
  // 于是这一轮 prompt 里连 16 个 xy_* 的 schema 都不会下发（顺带省下开场 token）。
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new TypeError(`bigfish-ops: enabled 必须是布尔值，收到 ${String(raw.enabled)}`)
  }
  const envUrl = resolveEnv(ctx, 'BF_DAEMON_URL') ?? resolveEnv(ctx, 'BF_DAEMON')
  const daemonUrlRaw = raw.daemonUrl ?? envUrl ?? `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`
  if (typeof daemonUrlRaw !== 'string' || daemonUrlRaw.length === 0) {
    throw new TypeError('bigfish-ops: daemonUrl 必须是非空字符串')
  }
  let parsed
  try {
    parsed = new URL(daemonUrlRaw)
  } catch {
    throw new TypeError(`bigfish-ops: daemonUrl 不是合法 URL：${daemonUrlRaw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`bigfish-ops: daemonUrl 只支持 http/https：${daemonUrlRaw}`)
  }
  const dataDir = resolveDataDir(raw.dataDir ?? resolveEnv(ctx, 'BF_DATA_DIR'), process.env, process.platform)
  const tokenPathRaw = raw.tokenPath ?? resolveEnv(ctx, 'BF_TOKEN_PATH') ?? join(dataDir, 'daemon.token')
  if (typeof tokenPathRaw !== 'string' || tokenPathRaw.length === 0) {
    throw new TypeError('bigfish-ops: tokenPath 必须是非空字符串')
  }
  const timeoutRaw = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof timeoutRaw !== 'number' || !Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
    throw new TypeError(`bigfish-ops: timeoutMs 必须是正数，收到 ${String(raw.timeoutMs)}`)
  }
  if (raw.writeGate !== undefined && typeof raw.writeGate !== 'boolean') {
    throw new TypeError(`bigfish-ops: writeGate 必须是布尔值，收到 ${String(raw.writeGate)}`)
  }
  // 自动拉起：面板连不上 daemon 时由宿主 detached 起一个（默认开；CI/远端 daemon 场景可关）。
  if (raw.autoStartDaemon !== undefined && typeof raw.autoStartDaemon !== 'boolean') {
    throw new TypeError(`bigfish-ops: autoStartDaemon 必须是布尔值，收到 ${String(raw.autoStartDaemon)}`)
  }
  // 异常唤醒：daemon 里发布失败/待复核时推一条消息回会话（默认开；不需要打扰可关）。
  if (raw.enableAlerts !== undefined && typeof raw.enableAlerts !== 'boolean') {
    throw new TypeError(`bigfish-ops: enableAlerts 必须是布尔值，收到 ${String(raw.enableAlerts)}`)
  }
  const config = {
    enabled: raw.enabled !== false,
    daemonUrl: parsed.origin,
    tokenPath: tokenPathRaw,
    dataDir,
    timeoutMs: timeoutRaw,
    writeGate: raw.writeGate !== false,
    autoStartDaemon: raw.autoStartDaemon !== false,
    enableAlerts: raw.enableAlerts !== false,
  }
  // 可选覆盖：打包/非常规布局下让用户显式指定 node 与 daemon 入口。
  if (raw.nodePath !== undefined) config.nodePath = requirePath(raw.nodePath, 'nodePath')
  if (raw.daemonEntry !== undefined) config.daemonEntry = requirePath(raw.daemonEntry, 'daemonEntry')
  return config
}

/**
 * 可选路径类配置：必须是非空字符串（空串等于「没配」，容易掩盖拼错）。
 *
 * @param {unknown} value - 配置值。
 * @param {string} key - 字段名（错误信息用）。
 * @returns {string} 绝对或相对路径字符串。
 */
function requirePath(value, key) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`bigfish-ops: ${key} 必须是非空字符串，收到 ${String(value)}`)
  }
  return value
}
