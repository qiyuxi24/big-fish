/**
 * 把账号能力适配成 HTTP 路由处理器。
 *
 * 为什么单独成文件：账号有六个动作（摘要/导入/扫码/校验/切换/退出），每个都要
 * 「读凭据 + 调能力 + 刷新状态缓存」，原来全塞在 startDaemonRuntime 的对象字面量里，
 * 主装配函数被撑到 300 行。适配层独立后，加账号动作只改这里。
 * @module @bigfish/daemon/runtime-account-handlers
 */
import type { CredentialStore, Logger } from '@bigfish/core'
import type { AccountLifecycle } from './account-lifecycle.ts'
import { listAccountSummaries } from './account-list.ts'
import type { AccountSummary } from './account-list.ts'
import type { AccountStateStore } from './account-state.ts'
import type { AccountVerifier } from './account-session.ts'
import { importAccountFromChrome } from './accounts.ts'
import { loginAndSave } from './login.ts'
import type { ManagedBrowser } from './managed-browser.ts'
import type {
  ActivateAccountHandler,
  ImportAccountHandler,
  LoginAccountHandler,
  LogoutAccountHandler,
  VerifyAccountHandler,
} from './routes-accounts.ts'
import type { SettingsStore } from './settings.ts'

/** 账号适配层的依赖：能力对象由 runtime 装配，这里只负责把结果翻译成 HTTP 形状。 */
export interface AccountHandlerDeps {
  credentials: CredentialStore
  /** 已包 keepAlive 的 SettingsStore（切换/读取当前账号都走它）。 */
  settings: SettingsStore
  state: AccountStateStore
  verifier: AccountVerifier
  lifecycle: AccountLifecycle
  /** 导入/登录/退出后刷新 /status 的账号快照（status 是同步接口）。 */
  refreshAccounts: () => Promise<string[]>
  /**
   * 托管浏览器：扫码登录/导入/发布共用的那个实例。
   * 有它时「扫码登录」复用它并**保留**窗口（会话由这个真浏览器续期）；
   * 没有它（CLI/测试）就退回 login.ts 的「自起一个、用完关掉」。
   */
  browser?: ManagedBrowser | undefined
  /** 没有托管浏览器时，扫码自起浏览器用的独立 profile 目录。 */
  browserProfileDir?: string | undefined
  logger: Logger
  now?: (() => number) | undefined
}

/** 注入给路由上下文的账号处理器集合。 */
export interface AccountHandlers {
  accountSummaries: () => Promise<AccountSummary[]>
  importAccount: ImportAccountHandler
  loginAccount: LoginAccountHandler
  verifyAccount: VerifyAccountHandler
  activateAccount: ActivateAccountHandler
  logoutAccount: LogoutAccountHandler
}

export function createAccountHandlers(deps: AccountHandlerDeps): AccountHandlers {
  const { credentials, settings, state, verifier, lifecycle, refreshAccounts, logger } = deps
  const now = deps.now

  return {
    // 账号面板的列表：只读摘要，cookie 值不出进程（见 account-list.ts）；顺带带上当前账号与最近检测结论。
    accountSummaries: async () => {
      const snapshot = await state.read()
      return listAccountSummaries({
        credentials,
        state: snapshot,
        activeAccountId: await readActiveAccountId(settings),
        ...(now === undefined ? {} : { now }),
      })
    },
    importAccount: async (input) => {
      // 默认读托管浏览器：它就是扫码登录用的那个窗口，刚登完立刻「导入」读到的必然是同一份登录态。
      const port = input.port ?? deps.browser?.port
      const imported = await importAccountFromChrome({
        credentials,
        ...(now === undefined ? {} : { now }),
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(port === undefined ? {} : { port }),
      })
      // /status 的账号列表是启动时快照；导入后立刻刷新，概览面板才不会显示旧列表。
      await refreshAccounts()
      // 第一个导入的账号自动成为当前账号：否则面板与保活都没有默认可操作对象。
      // 设置写失败不回滚导入（凭据已经安全落盘），只在日志里提示。
      try {
        await lifecycle.activateIfEmpty(imported.accountId)
      } catch (error) {
        logger.warn('导入成功但设置当前账号失败（可在设置里手动切换）', {
          accountId: imported.accountId,
          error: messageOf(error),
        })
      }
      return imported
    },
    // 扫码登录与导入共用 CredentialStore，只是多了「开页面 + 等扫码」的轮询。
    loginAccount: async (input) => {
      const browser = deps.browser
      // 没显式给端口 = 走托管浏览器：复用/拉起同一个实例，并且**不关**它——
      // 会话要靠这个真浏览器续期，关掉就等于把登录态的最后一条命根子掐了。
      const keepBrowser = browser !== undefined && input.port === undefined
      const port = input.port ?? browser?.port
      const logged = await loginAndSave({
        credentials,
        ...(browser === undefined ? {} : { browserProfileDir: browser.profileDir }),
        ...(keepBrowser && browser !== undefined
          ? {
              ensureBrowser: async (): Promise<() => Promise<void>> => {
                await browser.ensure()
                return async (): Promise<void> => {}
              },
            }
          : {}),
        // 自起浏览器关不掉只是收尾噪音，记一条 warn 即可，不能盖住登录结果。
        onWarn: (message: string): void => {
          logger.warn(message)
        },
        ...(now === undefined ? {} : { now }),
      }, port === undefined ? input : { ...input, port })
      await refreshAccounts()
      try {
        await lifecycle.activateIfEmpty(logged.accountId)
      } catch (error) {
        logger.warn('登录成功但设置当前账号失败（可在设置里手动切换）', {
          accountId: logged.accountId,
          error: messageOf(error),
        })
      }
      return logged
    },
    // 登录态校验：只读探测，失败也回 200 + online:false——面板要的是「账号掉没掉线」，
    // 而不是把 mtop 错误码当成 daemon 故障。只有账号不存在（VALIDATION）与能力未装配走错误信封。
    verifyAccount: async (input) => verifier.verify(input.accountId),
    // 切换当前账号只是本地设置，不触达闲鱼；退出登录只删本地凭据（见 account-lifecycle.ts）。
    activateAccount: async (input) => lifecycle.activate(input.accountId),
    logoutAccount: async (input) => {
      const result = await lifecycle.logout(input.accountId)
      // /status 的账号列表是启动时快照：退出后必须刷新，否则概览面板仍显示已删账号。
      await refreshAccounts()
      return result
    },
  }
}

/** settings 读不出来时只影响「当前账号」高亮，不该让账号列表 500。 */
async function readActiveAccountId(settings: SettingsStore): Promise<string> {
  try {
    return (await settings.get()).activeAccountId
  } catch {
    return ''
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
