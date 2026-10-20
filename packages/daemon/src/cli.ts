/**
 * daemon 可执行入口：解析命令行 → 加载配置 → 起 HTTP 服务 → 等信号优雅关闭。
 *
 * 为什么把 runCli 拆出来返回退出码：本机沙箱禁止 spawn 子进程，测试只能直接调
 * runCli/parseArgs；返回值 + 注入的 io 让「不启动子进程也能测 CLI」成立。
 * @module @bigfish/daemon/cli
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CredentialStore, createLogger, fail, loadDaemonConfig, toXianyuError } from '@bigfish/core'
import type { DaemonConfig, EnvLike, Logger } from '@bigfish/core'

import { importAccountFromChrome } from './accounts.ts'
import type { ImportAccountDeps, ImportAccountInput, ImportedAccount } from './accounts.ts'
import { isLoopbackHost } from './config.ts'
import { startDaemonRuntime } from './runtime.ts'
import type { DaemonRuntime } from './runtime.ts'

/** 子命令：默认 serve（起 daemon）；import-account 只做登录态导入后退出。 */
export type CliCommand = 'serve' | 'import-account'

/** 命令行解析结果。 */
export interface CliOptions {
  command: CliCommand
  dataDir?: string
  port?: number
  host?: string
  tokenPath?: string
  /** import-account：覆盖默认账号 id（默认取 unb）。 */
  accountId?: string
  /** import-account：Chrome DevTools 端口，默认 9222。 */
  chromePort?: number
  printConfig: boolean
  help: boolean
}

/** CLI 输出注入点：测试可捕获，生产默认写 stdout/stderr。 */
export interface CliIo {
  stdout(line: string): void
  stderr(line: string): void
}

/** 默认输出通道。 */
const defaultIo: CliIo = {
  stdout: (line: string): void => {
    process.stdout.write(line + '\n')
  },
  stderr: (line: string): void => {
    process.stderr.write(line + '\n')
  },
}

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--data-dir',
  '--host',
  '--token-path',
  '--port',
  '--account-id',
  '--chrome-port',
])

const USAGE_HINT = [
  '用法：bigfish-daemon [--data-dir DIR] [--port PORT] [--host HOST] [--token-path FILE] [--print-config] [--help]',
  '      bigfish-daemon import-account [--data-dir DIR] [--account-id ID] [--chrome-port PORT]',
].join('\n')

const HELP_TEXT = [
  'bigfish daemon —— 闲鱼店铺自动化的本地控制面',
  '',
  '用法：bigfish-daemon [选项]',
  '      bigfish-daemon import-account [选项]',
  '',
  '选项：',
  '  --data-dir DIR     数据目录（SQLite、token、凭据都放这里）',
  '  --port PORT        监听端口，默认 47001（0 = 让系统分配，适合冒烟/嵌入）',
  '  --host HOST        监听地址，只允许回环地址，默认 127.0.0.1',
  '  --token-path FILE  Bearer token 文件路径，默认 <data-dir>/daemon.token',
  '  --print-config     打印解析后的配置并退出（不启动服务）',
  '  --help, -h         显示本帮助',
  '',
  '子命令 import-account：',
  '  从本机已登录的 Chrome 读取闲鱼 cookie 并加密落盘，然后退出（不起服务）。',
  '  前置：Chrome 必须带 --remote-debugging-port 启动，且已登录 https://www.goofish.com/',
  '  --account-id ID    账号 id，默认取 unb cookie（闲鱼 userId）',
  '  --chrome-port PORT DevTools 端口，默认 9222',
  '',
  '环境变量：BF_DATA_DIR / BF_HOST / BF_PORT / BF_LOG_LEVEL / BF_LEASE_TTL_MS / BF_POLL_INTERVAL_MS',
].join('\n')

/** 解析命令行；未知参数、缺取值、非法端口一律 VALIDATION（runCli 转成退出码 2）。 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { command: 'serve', printConfig: false, help: false }
  let index = 0
  const command = argv[0]
  if (command === 'import-account') {
    options.command = 'import-account'
    index = 1
  } else if (command !== undefined && !command.startsWith('-')) {
    fail('VALIDATION', '未知子命令：' + command)
  }
  while (index < argv.length) {
    const raw = argv[index]
    if (raw === undefined) {
      index += 1
      continue
    }
    const parts = splitFlag(raw)
    if (parts.flag === '--help' || parts.flag === '-h') {
      options.help = true
      index += 1
      continue
    }
    if (parts.flag === '--print-config') {
      options.printConfig = true
      index += 1
      continue
    }
    if (!VALUE_FLAGS.has(parts.flag)) fail('VALIDATION', '未知参数：' + raw)
    const value = takeValue(argv, index, parts)
    if (parts.flag === '--data-dir') options.dataDir = value
    else if (parts.flag === '--host') options.host = value
    else if (parts.flag === '--token-path') options.tokenPath = value
    else if (parts.flag === '--account-id') options.accountId = value
    else if (parts.flag === '--chrome-port') options.chromePort = parsePortFlag(value, '--chrome-port', false)
    else options.port = parsePortFlag(value, '--port', true)
    index += parts.inline === undefined ? 2 : 1
  }
  validateCommandFlags(options)
  return options
}

/** 子命令与参数交叉校验：免得用户以为 serve 模式会顺手导入账号。 */
function validateCommandFlags(options: CliOptions): void {
  if (options.command === 'serve') {
    if (options.accountId !== undefined || options.chromePort !== undefined) {
      fail('VALIDATION', '--account-id / --chrome-port 只用于 import-account 子命令')
    }
    return
  }
  if (options.printConfig) fail('VALIDATION', 'import-account 不支持 --print-config')
  if (options.host !== undefined || options.port !== undefined || options.tokenPath !== undefined) {
    fail('VALIDATION', 'import-account 只接受 --data-dir / --account-id / --chrome-port / --help')
  }
}

interface FlagParts {
  flag: string
  inline: string | undefined
}

function splitFlag(raw: string): FlagParts {
  const eq = raw.indexOf('=')
  if (eq === -1) return { flag: raw, inline: undefined }
  return { flag: raw.slice(0, eq), inline: raw.slice(eq + 1) }
}

function takeValue(argv: readonly string[], index: number, parts: FlagParts): string {
  if (parts.inline !== undefined) {
    if (parts.inline.length === 0) fail('VALIDATION', '参数缺少取值：' + parts.flag)
    return parts.inline
  }
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('--')) fail('VALIDATION', '参数缺少取值：' + parts.flag)
  return next
}

/**
 * CLI 端口校验。
 * --port 允许 0（「让系统分配」只对监听端口有意义）；--chrome-port 必须 1..65535。
 */
function parsePortFlag(value: string, flag: string, allowZero: boolean): number {
  const text = value.trim()
  if (!/^[0-9]+$/.test(text)) fail('VALIDATION', flag + ' 必须是整数，收到 ' + JSON.stringify(value))
  const port = Number(text)
  const min = allowZero ? 0 : 1
  if (!Number.isSafeInteger(port) || port < min || port > 65535) {
    fail('VALIDATION', flag + ' 超出范围 ' + String(min) + '..65535：' + text)
  }
  return port
}

/** 把 CLI 选项翻成 config 覆盖项；--data-dir 会重算该目录下的默认路径。 */
export function toConfigOverrides(options: CliOptions): Partial<DaemonConfig> {
  const overrides: Partial<DaemonConfig> = {}
  if (options.host !== undefined) overrides.host = options.host
  if (options.port !== undefined) overrides.port = options.port
  if (options.dataDir !== undefined) {
    overrides.dbPath = join(options.dataDir, 'bigfish.db')
    overrides.credentialsDir = join(options.dataDir, 'credentials')
    overrides.circuitPath = join(options.dataDir, 'circuits.json')
    if (options.tokenPath === undefined) overrides.tokenPath = join(options.dataDir, 'daemon.token')
  }
  if (options.tokenPath !== undefined) overrides.tokenPath = options.tokenPath
  return overrides
}

/** runCli 的可注入依赖；测试用假导入器避免真连 Chrome（本机沙箱禁 spawn）。 */
export interface RunCliDeps {
  importAccount?: (deps: ImportAccountDeps & ImportAccountInput) => Promise<ImportedAccount>
}

/**
 * 执行 CLI；返回进程退出码（0 正常、1 运行期失败、2 用法错误）。
 * @param argv 参数（不含 node/脚本路径）
 * @param env 环境变量表
 * @param io 输出通道
 * @param deps 可注入依赖（默认用真实实现）
 */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  env: EnvLike = process.env,
  io: CliIo = defaultIo,
  deps: RunCliDeps = {},
): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    io.stderr(toXianyuError(error).message)
    io.stderr(USAGE_HINT)
    return 2
  }
  if (options.help) {
    io.stdout(HELP_TEXT)
    return 0
  }
  try {
    const config = loadDaemonConfig(env, toConfigOverrides(options))
    // core 的配置不校验回环：daemon 侧必须自己挡住，避免把控制面暴露到局域网。
    if (!isLoopbackHost(config.host)) {
      fail('VALIDATION', 'daemon 只允许绑定回环地址（127.0.0.1 / localhost / ::1），收到 ' + config.host)
    }
    if (options.command === 'import-account') return await runImportAccount(options, config, io, deps)
    if (options.printConfig) {
      io.stdout(JSON.stringify(config, null, 2))
      return 0
    }
    return await runServer(config, io)
  } catch (error) {
    io.stderr('daemon 无法启动：' + toXianyuError(error).message)
    return 1
  }
}

/**
 * 导入登录态：读本机 Chrome cookie → 加密写 <credentialsDir>/<accountId>.cred.json → 打印摘要。
 * 刻意不启动 daemon：导入是「登录一次」的一次性动作，不该要求后台常驻。
 */
async function runImportAccount(
  options: CliOptions,
  config: DaemonConfig,
  io: CliIo,
  deps: RunCliDeps,
): Promise<number> {
  const credentials = new CredentialStore({ dir: config.credentialsDir })
  const importer = deps.importAccount ?? importAccountFromChrome
  const input: ImportAccountInput = {}
  if (options.accountId !== undefined) input.accountId = options.accountId
  if (options.chromePort !== undefined) input.port = options.chromePort
  try {
    const imported = await importer({ credentials, ...input })
    io.stdout(JSON.stringify(imported, null, 2))
    io.stdout(
      '已导入账号 ' + imported.accountId + '（' + String(imported.savedFieldCount) + ' 条 cookie，已加密落盘）。',
    )
    io.stdout('daemon 若正在运行，需重启（或再调一次 POST /accounts/import）才会在 /status 里看到该账号。')
    return 0
  } catch (error) {
    io.stderr('导入登录态失败：' + toXianyuError(error).message)
    return 1
  }
}

/** 起队列 + worker + HTTP 服务，然后阻塞等 SIGINT/SIGTERM；启动失败返回 1。 */
async function runServer(config: DaemonConfig, io: CliIo): Promise<number> {
  const logger = createLogger({ level: config.logLevel, name: 'bigfish-daemon' })
  let runtime: DaemonRuntime | undefined
  try {
    runtime = await startDaemonRuntime({ config, logger, version: await readVersion() })
    logger.info('daemon 已启动', {
      url: runtime.daemon.url,
      port: runtime.daemon.port,
      pid: process.pid,
      workerOwner: 'daemon-' + String(process.pid),
    })
    const signal = await waitForShutdownSignal()
    logger.info('收到退出信号，开始关闭', { signal })
    await closeQuietly(runtime, logger)
    logger.info('daemon 已停止', {})
    return 0
  } catch (error) {
    const normalized = toXianyuError(error)
    logger.error('daemon 启动失败', { error: normalized.message })
    io.stderr(isAddressInUse(normalized) ? addressInUseHint(config) : '启动失败：' + normalized.message)
    return 1
  }
}

function addressInUseHint(config: DaemonConfig): string {
  return '端口已被占用：' + config.host + ':' + String(config.port) + '（换端口或先停止已有 daemon）'
}

function isAddressInUse(error: { code: string; details: Record<string, unknown> }): boolean {
  return error.code === 'NETWORK' && error.details['errno'] === 'EADDRINUSE'
}

async function closeQuietly(daemon: { close(): Promise<void> }, logger: Logger): Promise<void> {
  try {
    await daemon.close()
  } catch (error) {
    logger.warn('关闭 HTTP 服务时出错', { error: toXianyuError(error).message })
  }
}

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise<NodeJS.Signals>((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      resolve(signal)
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })
}

/** 读本包 package.json 的 version；读不到不影响启动。 */
async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch (error) {
    // 包元数据缺失/不可读时退回占位版本：版本只用于 /health 展示，不该阻断启动。
    return '0.0.0'
  }
  return '0.0.0'
}

/** 只有作为可执行入口时才启动；被测试 import 时零副作用。 */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(entry).href === import.meta.url
  } catch (error) {
    return false
  }
}

if (isEntryPoint()) {
  void (async (): Promise<void> => {
    const code = await runCli()
    process.exit(code)
  })()
}