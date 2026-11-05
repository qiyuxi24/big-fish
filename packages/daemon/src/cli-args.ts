/**
 * CLI 参数解析与帮助文案：与进程启动逻辑拆开，cli.ts 只负责「解析 → 执行 → 退出码」。
 *
 * 单独一个文件的原因：参数/帮助占了大半篇幅，混在 cli.ts 里会把入口文件撑过 400 行上限
 * （AGENTS §3）；测试也只需要 import 这里的纯函数，不触发任何进程副作用。
 * @module @bigfish/daemon/cli-args
 */
import { join } from 'node:path'

import { fail } from '@bigfish/core'
import type { DaemonConfig } from '@bigfish/core'

/** 子命令：默认 serve（起 daemon）；import-account 导入登录态；login 扫码登录；publish 发布。 */
export type CliCommand = 'serve' | 'import-account' | 'login' | 'publish'

/** 命令行解析结果。 */
export interface CliOptions {
  command: CliCommand
  dataDir?: string
  port?: number
  host?: string
  tokenPath?: string
  /** import-account / login：覆盖默认账号 id（默认取 unb）。 */
  accountId?: string
  /** import-account / login / publish：Chrome DevTools 端口，默认 9222。 */
  chromePort?: number
  /** login：最长等待扫码毫秒数，默认 180000。 */
  timeoutMs?: number
  /** publish：草稿 JSON 文件路径（必填）。 */
  draft?: string
  /** publish：每步截图目录（真机校准时必开）。 */
  screenshots?: string
  /** publish：默认 false = dry-run，只填表不提交。 */
  submit?: boolean
  printConfig: boolean
  help: boolean
}

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--data-dir',
  '--host',
  '--token-path',
  '--port',
  '--account-id',
  '--chrome-port',
  '--timeout-ms',
  '--draft',
  '--screenshots',
])

export const USAGE_HINT = [
  '用法：bigfish-daemon [--data-dir DIR] [--port PORT] [--host HOST] [--token-path FILE] [--print-config] [--help]',
  '      bigfish-daemon import-account [--data-dir DIR] [--account-id ID] [--chrome-port PORT]',
  '      bigfish-daemon login [--data-dir DIR] [--account-id ID] [--chrome-port PORT] [--timeout-ms MS]',
  '      bigfish-daemon publish --draft FILE [--account-id ID] [--chrome-port PORT] [--screenshots DIR] [--submit]',
].join('\n')

export const HELP_TEXT = [
  'bigfish daemon —— 闲鱼店铺自动化的本地控制面',
  '',
  '用法：bigfish-daemon [选项]',
  '      bigfish-daemon import-account [选项]',
  '      bigfish-daemon login [选项]',
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
  '子命令 login：',
  '  打开闲鱼登录页，等用户扫码，自动轮询到登录态后加密落盘（不用手输账号 id）。',
  '  前置：Chrome 必须带 --remote-debugging-port 启动；未登录时会弹扫码入口。',
  '  --account-id ID    账号 id，默认取扫码后读到的 unb cookie',
  '  --chrome-port PORT DevTools 端口，默认 9222',
  '  --timeout-ms MS    最长等待扫码毫秒数，默认 180000（3 分钟）；超时退出码 1',
  '',
  '子命令 publish：',
  '  用 CDP 在网页发布页填表；默认 dry-run（只填表、不点提交），便于先校准选择器。',
  '  前置：Chrome 带 --remote-debugging-port 启动，且已登录要发布的那个闲鱼账号。',
  '  --draft FILE       草稿 JSON（title/desc/priceCents/images 必填，可选 pricingMode/shipping/address）',
  '  --account-id ID    期望账号，会与浏览器登录账号比对（不一致直接拒绝）',
  '  --chrome-port PORT DevTools 端口，默认 9222',
  '  --screenshots DIR  每步截图到该目录（真机校准必开）',
  '  --submit           真提交；不加就是 dry-run（默认）',
  '',
  '环境变量：BF_DATA_DIR / BF_HOST / BF_PORT / BF_LOG_LEVEL / BF_LEASE_TTL_MS / BF_POLL_INTERVAL_MS',
  '          BF_PUBLISH_SUBMIT=1 允许队列发布真提交（默认关闭）/ BF_CHROME_PORT / BF_PUBLISH_SCREENSHOTS',
].join('\n')

const COMMANDS: ReadonlySet<string> = new Set(['import-account', 'login', 'publish'])

/** 解析命令行；未知参数、缺取值、非法端口一律 VALIDATION（runCli 转成退出码 2）。 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { command: 'serve', printConfig: false, help: false }
  let index = 0
  const command = argv[0]
  if (command !== undefined && COMMANDS.has(command)) {
    options.command = command as CliCommand
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
    if (parts.flag === '--submit') {
      options.submit = true
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
    else if (parts.flag === '--timeout-ms') options.timeoutMs = parsePositiveIntFlag(value, '--timeout-ms')
    else if (parts.flag === '--draft') options.draft = value
    else if (parts.flag === '--screenshots') options.screenshots = value
    else options.port = parsePortFlag(value, '--port', true)
    index += parts.inline === undefined ? 2 : 1
  }
  validateCommandFlags(options)
  return options
}

/** 子命令与参数交叉校验：免得用户以为 serve 模式会顺手导入账号、扫码或发布。 */
function validateCommandFlags(options: CliOptions): void {
  // --help 一律短路：查帮助的人还没打算执行，不该先被「缺 --draft」这类必填校验劝退。
  // （未知参数仍在上面的解析循环里报错，所以 --help 不会掩盖拼错的 flag。）
  if (options.help) return
  if (options.command === 'serve') {
    if (options.accountId !== undefined || options.chromePort !== undefined) {
      fail('VALIDATION', '--account-id / --chrome-port 只用于 import-account / login / publish 子命令')
    }
    if (options.timeoutMs !== undefined) fail('VALIDATION', '--timeout-ms 只用于 login 子命令')
    if (options.draft !== undefined || options.screenshots !== undefined || options.submit === true) {
      fail('VALIDATION', '--draft / --screenshots / --submit 只用于 publish 子命令')
    }
    return
  }
  if (options.command === 'publish') {
    if (options.printConfig) fail('VALIDATION', 'publish 不支持 --print-config')
    if (
      options.host !== undefined ||
      options.port !== undefined ||
      options.tokenPath !== undefined ||
      options.dataDir !== undefined
    ) {
      fail('VALIDATION', 'publish 只接受 --draft / --account-id / --chrome-port / --screenshots / --submit / --help')
    }
    if (options.timeoutMs !== undefined) fail('VALIDATION', '--timeout-ms 只用于 login 子命令')
    if (options.draft === undefined) fail('VALIDATION', 'publish 子命令必须用 --draft 指定草稿 JSON 文件')
    return
  }
  // import-account / login：只吃数据目录、账号与 Chrome 端口；login 额外允许超时。
  if (options.printConfig) fail('VALIDATION', options.command + ' 不支持 --print-config')
  const allowed =
    options.command === 'login'
      ? '只接受 --data-dir / --account-id / --chrome-port / --timeout-ms / --help'
      : '只接受 --data-dir / --account-id / --chrome-port / --help'
  if (options.host !== undefined || options.port !== undefined || options.tokenPath !== undefined) {
    fail('VALIDATION', options.command + ' ' + allowed)
  }
  if (options.command === 'import-account' && options.timeoutMs !== undefined) {
    fail('VALIDATION', '--timeout-ms 只用于 login 子命令')
  }
  if (options.draft !== undefined || options.screenshots !== undefined || options.submit === true) {
    fail('VALIDATION', '--draft / --screenshots / --submit 只用于 publish 子命令')
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
export function parsePortFlag(value: string, flag: string, allowZero: boolean): number {
  const text = value.trim()
  if (!/^[0-9]+$/.test(text)) fail('VALIDATION', flag + ' 必须是整数，收到 ' + JSON.stringify(value))
  const port = Number(text)
  const min = allowZero ? 0 : 1
  if (!Number.isSafeInteger(port) || port < min || port > 65535) {
    fail('VALIDATION', flag + ' 超出范围 ' + String(min) + '..65535：' + text)
  }
  return port
}

/** 正整数参数（毫秒数）：0 与小数都拒绝，免得 NaN 传进轮询/超时逻辑。 */
function parsePositiveIntFlag(value: string, flag: string): number {
  const text = value.trim()
  if (!/^[0-9]+$/.test(text)) fail('VALIDATION', flag + ' 必须是正整数，收到 ' + JSON.stringify(value))
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('VALIDATION', flag + ' 超出范围（必须 ≥1）：' + text)
  return parsed
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
