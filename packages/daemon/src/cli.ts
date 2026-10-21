/**
 * daemon 可执行入口：解析命令行 → 加载配置 → 起 HTTP 服务 → 等信号优雅关闭。
 *
 * 为什么把 runCli 拆出来返回退出码：本机沙箱禁止 spawn 子进程，测试只能直接调
 * runCli/parseArgs；返回值 + 注入的 io 让「不启动子进程也能测 CLI」成立。
 *
 * 参数解析、帮助文案与配置覆盖在 cli-args.ts；本文件只保留执行路径与退出码，
 * 免得入口文件超过 AGENTS §3 的 400 行上限。
 * @module @bigfish/daemon/cli
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CredentialStore, createLogger, fail, loadDaemonConfig, toXianyuError } from '@bigfish/core'
import type { DaemonConfig, EnvLike, Logger } from '@bigfish/core'

import { importAccountFromChrome } from './accounts.ts'
import type { ImportAccountDeps, ImportAccountInput, ImportedAccount } from './accounts.ts'
import { parsePublishDraftFile, publishViaCdp } from './cdp-publish.ts'
import type { PublishViaCdpInput, PublishViaCdpResult } from './cdp-publish.ts'
import { HELP_TEXT, USAGE_HINT, parseArgs, parsePortFlag, toConfigOverrides } from './cli-args.ts'
import type { CliOptions } from './cli-args.ts'
import { isLoopbackHost } from './config.ts'
import { formatLoginTick, loginAndSave } from './login.ts'
import type { LoginDeps, LoginInput, LoginResult } from './login.ts'
import type { PublishPortOptions } from './operations.ts'
import { startDaemonRuntime } from './runtime.ts'
import type { DaemonRuntime } from './runtime.ts'

export { parseArgs, toConfigOverrides }
export type { CliCommand } from './cli-args.ts'
export type { CliOptions }

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

/** runCli 的可注入依赖；测试用假实现避免真连 Chrome（本机沙箱禁 spawn）。 */
export interface RunCliDeps {
  importAccount?: (deps: ImportAccountDeps & ImportAccountInput) => Promise<ImportedAccount>
  /** login 实现；默认 loginAndSave（连真 Chrome 开页面 + 轮询）。 */
  login?: (deps: LoginDeps, input: LoginInput) => Promise<LoginResult>
  /** publish 实现；默认 publishViaCdp（连真 Chrome）。 */
  publish?: (input: PublishViaCdpInput) => Promise<PublishViaCdpResult>
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
  if (options.command === 'publish') return await runPublish(options, io, deps)
  try {
    const config = loadDaemonConfig(env, toConfigOverrides(options))
    // core 的配置不校验回环：daemon 侧必须自己挡住，避免把控制面暴露到局域网。
    if (!isLoopbackHost(config.host)) {
      fail('VALIDATION', 'daemon 只允许绑定回环地址（127.0.0.1 / localhost / ::1），收到 ' + config.host)
    }
    if (options.command === 'import-account') return await runImportAccount(options, config, io, deps)
    if (options.command === 'login') return await runLogin(options, config, io, deps)
    if (options.printConfig) {
      io.stdout(JSON.stringify(config, null, 2))
      return 0
    }
    return await runServer(config, env, io)
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

/**
 * 扫码登录：打开闲鱼登录页 → 轮询 cookie → 落库 → 打印摘要。
 * 超时/取消都走 login.ts 的 UNAUTHORIZED，这里只负责退出码与可操作文案。
 */
async function runLogin(options: CliOptions, config: DaemonConfig, io: CliIo, deps: RunCliDeps): Promise<number> {
  const credentials = new CredentialStore({ dir: config.credentialsDir })
  const login = deps.login ?? loginAndSave
  const input: LoginInput = {
    onTick: (tick): void => {
      io.stdout(formatLoginTick(tick))
    },
  }
  if (options.accountId !== undefined) input.accountId = options.accountId
  if (options.chromePort !== undefined) input.port = options.chromePort
  if (options.timeoutMs !== undefined) input.timeoutMs = options.timeoutMs
  try {
    const result = await login({ credentials }, input)
    io.stdout(JSON.stringify(result, null, 2))
    io.stdout(
      '已导入账号 ' +
        result.accountId +
        '（' +
        String(result.savedFieldCount) +
        ' 条 cookie，耗时 ' +
        (result.elapsedMs / 1000).toFixed(1) +
        's，已加密落盘）。',
    )
    io.stdout('daemon 若正在运行，需重启（或再调一次 POST /accounts/login）才会在 /status 里看到该账号。')
    return 0
  } catch (error) {
    io.stderr('扫码登录失败：' + toXianyuError(error).message)
    return 1
  }
}

/**
 * publish 子命令：读草稿 → 跑 CDP 发布；默认 dry-run。
 * 不走 loadDaemonConfig：发布不依赖 daemon 数据目录，也不该因为配置缺失而拒绝校准。
 */
async function runPublish(options: CliOptions, io: CliIo, deps: RunCliDeps): Promise<number> {
  const draftPath = options.draft
  if (draftPath === undefined) {
    io.stderr('publish 子命令必须用 --draft 指定草稿 JSON 文件')
    io.stderr(USAGE_HINT)
    return 2
  }
  try {
    const draft = parsePublishDraftFile(await readDraftJson(draftPath))
    const publisher = deps.publish ?? publishViaCdp
    const result = await publisher({
      draft,
      submit: options.submit === true,
      ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
      ...(options.chromePort === undefined ? {} : { chromePort: options.chromePort }),
      ...(options.screenshots === undefined ? {} : { screenshotsDir: options.screenshots }),
      onLog: (step: string, message: string): void => {
        io.stdout('[' + step + '] ' + message)
      },
    })
    io.stdout(JSON.stringify(result, null, 2))
    if (result.dryRun) {
      io.stdout(
        'dry-run 完成：表单已填但**没有点提交**（账号 ' + result.accountId + '，URL ' + result.href + '）。',
      )
      io.stdout('对着截图确认页面没问题后，加 --submit 才会真发布；发布不可自动重试，失败要人工到闲鱼后台确认。')
    } else {
      io.stdout('已发布：itemId ' + (result.itemId ?? '未知') + '（账号 ' + result.accountId + '）。')
    }
    return 0
  } catch (error) {
    io.stderr('发布失败：' + toXianyuError(error).message)
    return 1
  }
}

/** 读草稿文件；读不到 / 不是 JSON 都转 VALIDATION，文案指向具体文件。 */
async function readDraftJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    fail('VALIDATION', '读不到草稿文件：' + path + '（' + toXianyuError(error).message + '）')
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    fail('VALIDATION', '草稿文件不是合法 JSON：' + path)
  }
}

/**
 * 从环境变量读队列发布配置：只有 BF_PUBLISH_SUBMIT=1/true 才开启（默认关闭）。
 * 截图目录默认 <data-dir>/publish-shots：真发布出问题时截图是唯一现场证据。
 */
export function publishOptionsFromEnv(env: EnvLike, config: DaemonConfig): PublishPortOptions | undefined {
  const submit = (env['BF_PUBLISH_SUBMIT'] ?? '').trim().toLowerCase()
  if (submit !== '1' && submit !== 'true') return undefined
  const chromePortRaw = (env['BF_CHROME_PORT'] ?? '').trim()
  const chromePort = chromePortRaw === '' ? undefined : parsePortFlag(chromePortRaw, 'BF_CHROME_PORT', false)
  const screenshotsRaw = (env['BF_PUBLISH_SCREENSHOTS'] ?? '').trim()
  const screenshotsDir = screenshotsRaw === '' ? join(dirname(config.dbPath), 'publish-shots') : screenshotsRaw
  return { submit: true, screenshotsDir, ...(chromePort === undefined ? {} : { chromePort }) }
}

/** 起队列 + worker + HTTP 服务，然后阻塞等 SIGINT/SIGTERM；启动失败返回 1。 */
async function runServer(config: DaemonConfig, env: EnvLike, io: CliIo): Promise<number> {
  const logger = createLogger({ level: config.logLevel, name: 'bigfish-daemon' })
  let runtime: DaemonRuntime | undefined
  try {
    const publish = publishOptionsFromEnv(env, config)
    runtime = await startDaemonRuntime({
      config,
      logger,
      version: await readVersion(),
      ...(publish === undefined ? {} : { publish }),
    })
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
