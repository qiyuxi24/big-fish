/**
 * 登录态导入：从用户日常 Chrome 导出 cookie（CDP `Storage.getCookies`，旧版浏览器降级到 `Network.getAllCookies`）。
 *
 * 为什么不用读 Chrome 的 Cookies SQLite：Windows 下要 DPAPI 解 AES key，需要原生模块或
 * `browser_cookie3` 等价物，与「运行时零第三方依赖」冲突（AGENTS §2）；`Storage.getCookies` /
 * `Network.getAllCookies` 是浏览器级方法，不需要 sessionId，也不依赖 page 域（docs/component-decomposition.md §2.1）。
 *
 * 本文件只做「导出 → 挑选 → 校验」，不负责加密落盘（那是 core/credentials.ts 的事）。
 * @module @bigfish/channel-cdp/cookies
 */
import { fail, toXianyuError } from '@bigfish/core'
import type { XianyuError } from '@bigfish/core'

/** CDP cookie 的可移植子集；字段名与 CDP `Network.Cookie` 一致。 */
export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  /** CDP 的 expires 是秒级 Unix 时间；-1 表示会话 cookie，映射后为 undefined。 */
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  /** CDP 未指定时给空字符串，映射后为 undefined。 */
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface CookieJar {
  /** goofish.com / taobao.com 域下 cookie 名→值，可直接喂给 channel-mtop 的 MtopSession.cookies。 */
  goofish: Record<string, string>
  /** 其它域的 cookie 数量统计，用于诊断（不给具体值，避免日志泄密）。 */
  others: number
}

/** 登录必带的两个 cookie：`_m_h5_tk` 参与 mtop 签名，`unb` 标识账号。 */
const LOGIN_COOKIE_NAMES: readonly string[] = ['_m_h5_tk', 'unb']

/** 只认这两个基域及其子域：`goofish.com` / `taobao.com`（passport 的 cookie 落在 taobao.com）。 */
const LOGIN_DOMAIN_BASES: readonly string[] = ['goofish.com', 'taobao.com']

/**
 * 域名匹配只看标签边界，避免 `evilgoofish.com` 被误判：
 * 去掉前导点后等于基域，或是以 `.基域` 结尾。
 */
function isLoginDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\./, '')
  if (normalized === '') return false
  for (const base of LOGIN_DOMAIN_BASES) {
    if (normalized === base || normalized.endsWith('.' + base)) return true
  }
  return false
}

/** 一次挑选的结果：选中的 cookie 本身（值 + 到期时间）+ 其它域条数。 */
interface PickedCookies {
  /** 按同名规则挑出的 cookie；保留原对象是因为调用方还要读 expires。 */
  picked: Map<string, BrowserCookie>
  others: number
}

/**
 * 同名冲突时取 path 更长者（浏览器发请求时也是长 path 优先，例如
 * `/` 与 `.goofish.com` 各有一份同名 cookie）；path 等长时后出现者覆盖（CDP 大致按写入时间给出）。
 * 无名 cookie 无法参与签名，计入 others 以便诊断。
 * 值与到期时间必须出自同一条 cookie，所以两个导出函数共用这里。
 */
function pickLoginCookies(cookies: readonly BrowserCookie[]): PickedCookies {
  const picked = new Map<string, BrowserCookie>()
  let others = 0
  for (const cookie of cookies) {
    if (!isLoginDomain(cookie.domain) || cookie.name === '') {
      others += 1
      continue
    }
    const previous = picked.get(cookie.name)
    if (previous !== undefined && cookie.path.length < previous.path.length) continue
    picked.set(cookie.name, cookie)
  }
  return { picked, others }
}

/** 挑出闲鱼/淘宝域的 cookie（名→值），喂给 mtop 签名。 */
export function selectGoofishCookies(cookies: readonly BrowserCookie[]): CookieJar {
  const { picked, others } = pickLoginCookies(cookies)
  const goofish: Record<string, string> = {}
  for (const [name, cookie] of picked) goofish[name] = cookie.value
  return { goofish, others }
}

/**
 * 挑出闲鱼/淘宝域 cookie 的到期时间（毫秒级 Unix 时间，字段名→时间戳）。
 *
 * 用于面板展示「登录态还剩多久」：CDP 的 `expires` 是秒级，这里统一转成毫秒，避免和其它时间字段混用。
 * 会话 cookie（无 expires / -1）不出现——那类 cookie 关掉浏览器就没了，不是可展示的生命周期。
 */
export function selectGoofishCookieExpiries(cookies: readonly BrowserCookie[]): Record<string, number> {
  const { picked } = pickLoginCookies(cookies)
  const expiries: Record<string, number> = {}
  for (const [name, cookie] of picked) {
    if (cookie.expires === undefined) continue
    expiries[name] = Math.round(cookie.expires * 1000)
  }
  return expiries
}

/**
 * 校验登录态完整：缺 `_m_h5_tk` 或 `unb` 就抛 UNAUTHORIZED（P1.1 要求两者都有）。
 * 空值按缺失处理——空 `_m_h5_tk` 签不出可用签名，早失败比发请求后被风控更好。
 * 错误消息直接给可执行的修复步骤（AGENTS §3：用户可见文案用中文且可操作）。
 */
export function assertLoginCookies(jar: CookieJar): void {
  const missing = LOGIN_COOKIE_NAMES.filter((name) => (jar.goofish[name] ?? '').trim() === '')
  if (missing.length === 0) return
  fail(
    'UNAUTHORIZED',
    'Chrome 里没读到闲鱼登录态：缺少 cookie ' + missing.join('、') +
      '。请在该 Chrome 里打开 https://www.goofish.com/ 确认已登录（右上角显示头像）后重新导入；' +
      '或改用扫码登录。',
  )
}

/** `send` 只需这一面：CdpConnection 与测试假连接都满足它。 */
export interface CdpRequestConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
}

/**
 * 取全部 cookie 的 CDP 方法，按新旧排序。
 *
 * Chrome 127+ / Edge 155 把浏览器级 cookie 读取挪到 Storage.getCookies，老方法会回
 * 「'Network.getAllCookies' wasn't found」；旧版本浏览器则相反。两个都是浏览器级方法：
 * 无参数、不需要 sessionId。
 */
const COOKIE_METHODS = ['Storage.getCookies', 'Network.getAllCookies'] as const

/** 「协议里没有这个方法」才降级；连接断开之类的真故障必须原样抛出，不能被当成版本差异吞掉。 */
function isMethodNotFound(error: XianyuError): boolean {
  const message = error.message.toLowerCase()
  return message.includes("wasn't found") || message.includes('not found') || message.includes('unknown method')
}

/** 从浏览器导出的 cookie 源。只读，不写浏览器。 */
export class CdpCookieSource {
  readonly #connection: CdpRequestConnection

  constructor(connection: CdpRequestConnection) {
    this.#connection = connection
  }

  /** 导全部域的 cookie；CDP 失败或响应结构不对都按 NETWORK 失败。 */
  async getAllCookies(): Promise<BrowserCookie[]> {
    const response = await this.#call()
    if (typeof response !== 'object' || response === null) {
      fail('NETWORK', 'CDP 取 cookie 返回结构异常：不是对象（实际 ' + describeType(response) + '）')
    }
    const list = (response as { cookies?: unknown }).cookies
    if (!Array.isArray(list)) {
      fail('NETWORK', 'CDP 取 cookie 返回结构异常：cookies 不是数组（实际 ' + describeType(list) + '）')
    }
    const cookies: BrowserCookie[] = []
    for (const item of list) {
      const cookie = narrowBrowserCookie(item)
      // 单条字段缺失/类型不对就当脏数据丢弃：宁可少一条 cookie，也不要让整次导入失败。
      if (cookie !== undefined) cookies.push(cookie)
    }
    return cookies
  }

  /** 导出并校验登录态；缺 `_m_h5_tk`/`unb` 时抛 UNAUTHORIZED。 */
  async readGoofishCookies(): Promise<CookieJar> {
    const jar = selectGoofishCookies(await this.getAllCookies())
    assertLoginCookies(jar)
    return jar
  }

  async #call(): Promise<unknown> {
    let lastError: XianyuError | undefined
    for (const method of COOKIE_METHODS) {
      try {
        // 两个方法都是浏览器级：没有参数，也不需要 sessionId。
        return await this.#connection.send(method, {})
      } catch (error) {
        const wrapped = toXianyuError(error, 'NETWORK')
        if (!isMethodNotFound(wrapped)) throw wrapped
        lastError = wrapped
      }
    }
    throw lastError ?? fail('NETWORK', 'CDP 取 cookie 失败：所有已知方法都不可用')
  }
}

function narrowBrowserCookie(item: unknown): BrowserCookie | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  const name = record['name']
  const value = record['value']
  const domain = record['domain']
  const path = record['path']
  if (typeof name !== 'string' || name === '') return undefined
  if (typeof value !== 'string' || typeof domain !== 'string' || typeof path !== 'string') return undefined
  const cookie: BrowserCookie = { name, value, domain, path }
  const expires = narrowExpires(record['expires'])
  if (expires !== undefined) cookie.expires = expires
  if (typeof record['httpOnly'] === 'boolean') cookie.httpOnly = record['httpOnly']
  if (typeof record['secure'] === 'boolean') cookie.secure = record['secure']
  const sameSite = narrowSameSite(record['sameSite'])
  if (sameSite !== undefined) cookie.sameSite = sameSite
  return cookie
}

/** -1 / 0 / 非有限值都是「无到期时间」，即会话 cookie。 */
function narrowExpires(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return raw
}

/** CDP 的 sameSite 可能是空字符串或缺失；只有三个合法枚举值才保留。 */
function narrowSameSite(raw: unknown): 'Strict' | 'Lax' | 'None' | undefined {
  if (raw === 'Strict' || raw === 'Lax' || raw === 'None') return raw
  return undefined
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
