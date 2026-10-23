/**
 * 账号运行时状态缓存：记录每个账号最近一次登录态检测的结果，供 /accounts 摘要与面板展示。
 *
 * 为什么单独落一个文件、而不塞进凭据库：检测结果变化频繁（保活每几分钟一次），丢了也无所谓；
 * 凭据是加密的敏感数据，不能因为一次心跳就重写整个凭据文件。正因如此本文件「读不到 = 没有历史」，
 * 缺失/损坏/版本不认识一律返回空表，绝不允许一个可选缓存拖垮 /accounts。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { XianyuError } from '@bigfish/core'

import type { AccountVerifyCode } from './account-verify.ts'

const STATE_VERSION = 1
// 与 account-verify.ts 的 AccountVerifyCode 同步；读到未知 code 时只丢该字段，不丢整条检测记录。
const KNOWN_CODES: ReadonlySet<string> = new Set([
  'AUTH_EXPIRED',
  'RISK_CONTROL',
  'RATE_LIMITED',
  'NETWORK',
  'VALIDATION',
  'INTERNAL',
])

/** 一次检测的运行时快照；source 区分人工点「校验」与后台保活，面板据此展示不同文案。 */
export interface AccountRuntimeState {
  checkedAt: number
  online: boolean
  code?: AccountVerifyCode
  message?: string
  refreshed: boolean
  source: 'manual' | 'keepalive'
}

export interface AccountStateStore {
  read(): Promise<Record<string, AccountRuntimeState>>
  record(accountId: string, state: AccountRuntimeState): Promise<void>
  remove(accountId: string): Promise<void>
}

export interface AccountStateStoreOptions {
  path: string
  now?: () => number
}

export function createAccountStateStore(options: AccountStateStoreOptions): AccountStateStore {
  const path = options.path
  const now = options.now ?? Date.now
  // 与 settings.ts 同一套串行化：read-modify-write 并发会丢写，这里用 tail Promise 排队。
  let tail: Promise<unknown> = Promise.resolve()
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const readAll = async (): Promise<Record<string, AccountRuntimeState>> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      // 文件不存在（首次运行）与权限/IO 错误都按「没有历史」处理：调用方只想要可展示的缓存。
      return {}
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // 断电写坏之类的情况直接丢弃旧缓存，下一次 record 会重新写一份好的。
      return {}
    }
    return narrowAccounts(parsed)
  }

  const writeAll = async (accounts: Record<string, AccountRuntimeState>): Promise<void> => {
    const tempPath = path + '.tmp'
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(tempPath, JSON.stringify({ version: STATE_VERSION, accounts }), { mode: 0o600 })
      // 先写临时文件再 rename：读侧永远看不到半截 JSON。
      await rename(tempPath, path)
    } catch (error) {
      try {
        await rm(tempPath, { force: true })
      } catch {
        // 临时文件清理失败不能盖住真正的写入错误。
      }
      throw new XianyuError({ code: 'STORAGE', message: '账号状态缓存写入失败：' + path, cause: error })
    }
  }

  return {
    read: () => serially(readAll),
    record: (accountId, state) =>
      serially(async () => {
        const accounts = await readAll()
        accounts[accountId] = normalizeState(state, now)
        await writeAll(accounts)
      }),
    remove: (accountId) =>
      serially(async () => {
        const accounts = await readAll()
        if (!(accountId in accounts)) return
        delete accounts[accountId]
        await writeAll(accounts)
      }),
  }
}

function normalizeState(state: AccountRuntimeState, now: () => number): AccountRuntimeState {
  // checkedAt 必须是整数毫秒（AGENTS §3）；坏值退回当前时钟而不是写进文件。
  const checkedAt = Number.isSafeInteger(state.checkedAt) ? state.checkedAt : Math.trunc(now())
  return { ...state, checkedAt }
}

function narrowAccounts(parsed: unknown): Record<string, AccountRuntimeState> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  if (record['version'] !== STATE_VERSION) return {}
  const rawAccounts = record['accounts']
  if (typeof rawAccounts !== 'object' || rawAccounts === null || Array.isArray(rawAccounts)) return {}
  const accounts: Record<string, AccountRuntimeState> = {}
  for (const [accountId, value] of Object.entries(rawAccounts as Record<string, unknown>)) {
    const state = narrowState(value)
    if (state !== undefined) accounts[accountId] = state
  }
  return accounts
}

function narrowState(value: unknown): AccountRuntimeState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const checkedAt = record['checkedAt']
  const online = record['online']
  const refreshed = record['refreshed']
  const source = record['source']
  if (typeof checkedAt !== 'number' || !Number.isSafeInteger(checkedAt)) return undefined
  if (typeof online !== 'boolean' || typeof refreshed !== 'boolean') return undefined
  if (source !== 'manual' && source !== 'keepalive') return undefined
  const code = record['code']
  const message = record['message']
  return {
    checkedAt,
    online,
    refreshed,
    source,
    ...(typeof code === 'string' && KNOWN_CODES.has(code) ? { code: code as AccountVerifyCode } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  }
}
