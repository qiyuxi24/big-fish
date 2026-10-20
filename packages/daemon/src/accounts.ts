/**
 * 账号登录态导入：把本机 Chrome 里已登录的闲鱼 cookie 加密落盘。
 *
 * 为什么不用读 Chrome 的 Cookies SQLite：Windows 下要解 DPAPI/AES，需要原生模块，
 * 与「运行时零第三方依赖」冲突（AGENTS §2）；CDP 的 Network.getAllCookies 是浏览器级方法，
 * 用户带 --remote-debugging-port 启动 Chrome 即可导出（docs/component-decomposition.md §2.1）。
 *
 * 安全边界：cookie 值只在内存里从 CDP 流向 CredentialStore；返回值、日志、meta 都不含 cookie 值。
 * @module @bigfish/daemon/accounts
 */
import { fail } from '@bigfish/core'
import type { CredentialStore } from '@bigfish/core'
import { CdpConnection, CdpCookieSource, DEFAULT_PORT, attachChrome } from '@bigfish/channel-cdp'
import type { CookieJar } from '@bigfish/channel-cdp'

/** 账号 id 白名单，与 core/CredentialStore 一致；这里提前校验是为了报错更早、文案更可操作。 */
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

/** 导入成功后的非敏感摘要。 */
export interface ImportedAccount {
  accountId: string
  /**
   * 已保存的 cookie 字段数（不含值）。
   * 不叫 cookieCount：core 脱敏按字段名子串命中 'cookie'，HTTP 回包会被整段掩成 [redacted]。
   */
  savedFieldCount: number
  updatedAt: number
  source: 'chrome-cdp'
}

/** 导入参数。 */
export interface ImportAccountInput {
  /** 覆盖默认账号 id；默认取 unb cookie（闲鱼 userId）。 */
  accountId?: string
  /** Chrome DevTools 端口，默认 9222。 */
  port?: number
}

/** 导入依赖；测试注入假时钟。 */
export interface ImportAccountDeps {
  credentials: CredentialStore
  now?: () => number
}

/**
 * 把已校验过的 cookie jar 加密落库，返回摘要。
 *
 * 单独拆出来是为了让「账号 id 推导、meta、返回值」这些逻辑不连浏览器也能测。
 * 调用方必须先过 CdpCookieSource.readGoofishCookies()（它负责 assertLoginCookies）。
 */
export async function saveImportedAccount(
  deps: ImportAccountDeps,
  jar: CookieJar,
  input: ImportAccountInput = {},
): Promise<ImportedAccount> {
  const accountId = resolveAccountId(jar, input.accountId)
  const importedAt = (deps.now ?? Date.now)()
  await deps.credentials.save({
    accountId,
    cookies: { ...jar.goofish },
    meta: { source: 'chrome-cdp', importedAt, otherCookies: jar.others },
  })
  const record = await deps.credentials.load(accountId)
  if (record === undefined) fail('INTERNAL', '凭据刚写入却读不回来：' + accountId)
  return {
    accountId,
    savedFieldCount: Object.keys(record.cookies).length,
    updatedAt: record.updatedAt,
    source: 'chrome-cdp',
  }
}

/**
 * 连本机已开的 Chrome（需带 --remote-debugging-port 启动），读闲鱼登录态并落库。
 * 只附加不启动：启动浏览器属于「让用户先登录」的人工步骤，这里不替用户做。
 */
export async function importAccountFromChrome(
  deps: ImportAccountDeps & ImportAccountInput,
): Promise<ImportedAccount> {
  const port = deps.port ?? DEFAULT_PORT
  const target = await attachChrome(port)
  const connection = await CdpConnection.connect(target.browserWsUrl)
  try {
    const jar = await new CdpCookieSource(connection).readGoofishCookies()
    return await saveImportedAccount(deps, jar, deps)
  } finally {
    await connection.close()
    await target.close()
  }
}

/** 显式 id 优先；否则用 unb。unb 是闲鱼 userId，天然满足字符白名单。 */
function resolveAccountId(jar: CookieJar, explicit: string | undefined): string {
  const candidate = (explicit ?? (jar.goofish['unb'] ?? '')).trim()
  if (candidate === '') {
    fail(
      'UNAUTHORIZED',
      '没读到 unb cookie，无法确定是哪个闲鱼账号：请确认该 Chrome 已登录 https://www.goofish.com/ 后重试',
    )
  }
  if (!ACCOUNT_ID_RE.test(candidate) || candidate === '.' || candidate === '..') {
    fail('VALIDATION', '账号 id 非法（只允许字母数字和 . _ -，长度 1-64）：' + candidate.slice(0, 80))
  }
  return candidate
}
