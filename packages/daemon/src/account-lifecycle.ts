/**
 * 账号生命周期：切换当前账号、退出登录（只清本地凭据）。
 *
 * 退出登录绝不调用闲鱼接口：我们要的是「本机不再使用这个号」，而不是帮用户把网页端会话踢掉；
 * 真踢会话属于写入外部系统，需要单独的产品决策。
 */
import { fail } from '@bigfish/core'
import type { CredentialRecord } from '@bigfish/core'

import type { AccountStateStore } from './account-state.ts'
import type { SettingsStore } from './settings.ts'

/** 只依赖 load/remove 两个动作，便于测试注入假凭据库。 */
export interface AccountCredentialSource {
  load(accountId: string): Promise<CredentialRecord | undefined>
  remove(accountId: string): Promise<boolean>
}

export interface AccountLifecycleDeps {
  credentials: AccountCredentialSource
  settings: SettingsStore
  state: Pick<AccountStateStore, 'remove'>
  /** 状态缓存清理失败只记日志：凭据已经删掉，不该让用户看到 500。 */
  onStateError?: (error: unknown) => void
}

export interface ActivateResult {
  activeAccountId: string
}

export interface LogoutResult {
  accountId: string
  activeAccountId: string
}

export interface AccountLifecycle {
  activate(accountId: string): Promise<ActivateResult>
  logout(accountId: string): Promise<LogoutResult>
  activateIfEmpty(accountId: string): Promise<string>
}

export function createAccountLifecycle(deps: AccountLifecycleDeps): AccountLifecycle {
  return {
    async activate(accountId) {
      await requireAccount(deps, accountId)
      const next = await deps.settings.update({ activeAccountId: accountId })
      return { activeAccountId: next.activeAccountId }
    },

    async logout(accountId) {
      await requireAccount(deps, accountId)
      // 先删凭据再清缓存：反过来的话，凭据删除失败会留下一条「有凭据但没状态」的假象。
      await deps.credentials.remove(accountId)
      try {
        await deps.state.remove(accountId)
      } catch (error) {
        deps.onStateError?.(error)
      }
      const current = await deps.settings.get()
      if (current.activeAccountId !== accountId) return { accountId, activeAccountId: current.activeAccountId }
      // 清空当前账号走空串：core 的 parseActiveAccountId 明确允许 ''（避免伪造一个不存在的账号 id）。
      const next = await deps.settings.update({ activeAccountId: '' })
      return { accountId, activeAccountId: next.activeAccountId }
    },

    async activateIfEmpty(accountId) {
      const current = await deps.settings.get()
      if (current.activeAccountId !== '') return current.activeAccountId
      const next = await deps.settings.update({ activeAccountId: accountId })
      return next.activeAccountId
    },
  }
}

async function requireAccount(deps: AccountLifecycleDeps, accountId: string): Promise<void> {
  if (typeof accountId !== 'string' || accountId.trim() === '') fail('VALIDATION', 'accountId 不能为空')
  const record = await deps.credentials.load(accountId)
  if (record === undefined) fail('VALIDATION', '账号不存在：' + accountId)
}
