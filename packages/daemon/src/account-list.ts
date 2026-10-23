/**
 * 账号列表摘要：把加密凭据库整理成「可展示、不含敏感值」的账号概况。
 *
 * 为什么需要它：凭据文件里是整份 cookie（含 token），绝不能直接回给 UI；
 * 这里只暴露账号 id、更新时间、字段数，以及「写操作所需的两枚 cookie 是否齐备」。
 * 单个凭据损坏时产出 broken 条目，而不是让整张表 500 —— 否则一个坏文件会让账号面板完全不可用，
 * 用户也看不到是哪个号坏了。
 * 字段命名避开 'cookie' 子串，否则会被 core 的日志脱敏规则掩成 [redacted]（同 accounts.ts 的 savedFieldCount）。
 * @module @bigfish/daemon/account-list
 */
import { XianyuError } from '@bigfish/core'
import type { CredentialRecord } from '@bigfish/core'

import type { AccountRuntimeState } from './account-state.ts'

/** 发布/发货等写操作依赖的最小登录态：用户身份 + mtop 签名 token。 */
const READY_FIELDS = ['unb', '_m_h5_tk'] as const

/**
 * 只知道「几时刷新过」、不知道浏览器侧令牌真实过期时间时的估算 TTL。
 * 取 2 小时：_m_h5_tk 短于这个值很常见，宁可让面板提前提示重新登录，也不要给出乐观的过期时间。
 */
export const ESTIMATED_TOKEN_TTL_MS = 7_200_000

/** 一个账号的可展示概况。 */
export interface AccountSummary {
  accountId: string
  /** 凭据最后更新时间（整数毫秒）；broken 条目为 0。 */
  updatedAt: number
  /** 已保存字段数（只数个数，不回值）。 */
  savedFieldCount: number
  /** unb 与 _m_h5_tk 齐备才为 true：只有这种状态才能跑发布/发货。 */
  ready: boolean
  /** 闲鱼 userId；缺失说明导入不完整。 */
  unb?: string
  /** 距上次更新毫秒数（非负）。 */
  ageMs: number
  /** 是否为当前激活账号（settings.activeAccountId === accountId）。 */
  active: boolean
  /** 预计登录态过期时刻；两个来源都推不出来时缺省。 */
  loginExpiresAt?: number
  /** browser=导入时读到的浏览器真实过期时间；estimated=按 refreshedAt + 估算 TTL 推的。 */
  loginExpiresSource?: 'browser' | 'estimated'
  /** 最近一次登录态检测的时间与结论（来自 account-state；没检测过则缺省）。 */
  lastCheckedAt?: number
  lastOnline?: boolean
  lastCode?: string
  /** 凭据文件损坏或无法解密。 */
  broken?: boolean
  /** 损坏原因（只带 error code，不带任何 cookie 值）。 */
  brokenReason?: string
}

/** 只需这两个方法，测试可以不碰加密文件直接给假实现；CredentialStore 结构上刚好满足。 */
export interface CredentialSource {
  list(): Promise<string[]>
  load(accountId: string): Promise<CredentialRecord | undefined>
}

export interface AccountListDeps {
  credentials: CredentialSource
  /** 注入时钟；缺省 Date.now。 */
  now?: () => number
  /** 当前激活账号（settings.activeAccountId）；缺省视为没有激活账号，兼容旧调用。 */
  activeAccountId?: string
  /** 运行时状态快照；缺省表示还没做过任何检测。 */
  state?: Record<string, AccountRuntimeState>
}

/** 按 accountId 排序列出账号概况；读取单个凭据失败不影响其它账号。 */
export async function listAccountSummaries(deps: AccountListDeps): Promise<AccountSummary[]> {
  const now = deps.now ?? Date.now
  const current = now()
  const ids = await deps.credentials.list()
  const summaries: AccountSummary[] = []
  for (const accountId of ids) {
    let record: CredentialRecord | undefined
    try {
      record = await deps.credentials.load(accountId)
    } catch (error) {
      summaries.push({
        accountId,
        updatedAt: 0,
        savedFieldCount: 0,
        ready: false,
        ageMs: 0,
        // 坏凭据不可能是可用账号；把它标成 active=false，避免设置里残留的 id 让损坏条目看起来被选中。
        active: false,
        broken: true,
        brokenReason: brokenReason(error),
      })
      continue
    }
    // list() 与 load() 之间凭据可能被删；跳过即可，不当作错误。
    if (record === undefined) continue
    const unb = record.cookies['unb']
    summaries.push({
      accountId,
      updatedAt: record.updatedAt,
      savedFieldCount: Object.keys(record.cookies).length,
      ready: READY_FIELDS.every((name) => hasValue(record.cookies[name])),
      ...(hasValue(unb) ? { unb } : {}),
      ageMs: Math.max(0, current - record.updatedAt),
      active: deps.activeAccountId === accountId,
      ...lifecycleFields(record.meta, deps.state?.[accountId]),
    })
  }
  return summaries
}

/** 登录态生命周期字段：优先用「刷新时刻 + 估算 TTL」，其次用浏览器给的真实过期时间。 */
function lifecycleFields(
  meta: Record<string, unknown> | undefined,
  state: AccountRuntimeState | undefined,
): Pick<AccountSummary, 'loginExpiresAt' | 'loginExpiresSource' | 'lastCheckedAt' | 'lastOnline' | 'lastCode'> {
  const fields: Pick<AccountSummary, 'loginExpiresAt' | 'loginExpiresSource' | 'lastCheckedAt' | 'lastOnline' | 'lastCode'> = {}
  const refreshedAt = meta?.['refreshedAt']
  if (typeof refreshedAt === 'number' && Number.isSafeInteger(refreshedAt)) {
    fields.loginExpiresAt = refreshedAt + ESTIMATED_TOKEN_TTL_MS
    fields.loginExpiresSource = 'estimated'
  } else {
    const expires = meta?.['expires']
    const browserExpiry = typeof expires === 'object' && expires !== null
      ? (expires as Record<string, unknown>)['_m_h5_tk']
      : undefined
    if (typeof browserExpiry === 'number' && Number.isSafeInteger(browserExpiry)) {
      fields.loginExpiresAt = browserExpiry
      fields.loginExpiresSource = 'browser'
    }
  }
  if (state !== undefined) {
    fields.lastCheckedAt = state.checkedAt
    fields.lastOnline = state.online
    if (state.code !== undefined) fields.lastCode = state.code
  }
  return fields
}

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

/** 损坏原因只保留稳定 code：错误 message 可能带账号 id，但不该扩散到 UI。 */
function brokenReason(error: unknown): string {
  const code = error instanceof XianyuError ? error.code : 'UNKNOWN'
  return '凭据文件无法读取或解密（' + code + '）'
}
