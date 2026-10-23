/**
 * 登录态校验执行器：单飞（同账号并发共享一个请求）、冷却（刚校验过直接回缓存）、
 * 结果同时写进 account-state 供 /accounts 摘要复用。
 *
 * 为什么冷却放在这里而不是 HTTP 层：面板刷新 + 保活可能同时触发校验，mtop 的
 * user.page.head 是真实请求，短时间重复调用没有任何信息增量，只会增加风控暴露面。
 */
import { fail } from '@bigfish/core'
import type { CredentialRecord } from '@bigfish/core'

import {
  buildAccountSessionState,
  classifyVerifyError,
} from './account-verify.ts'
import type { AccountSessionState } from './account-verify.ts'
import type { AccountCredentialSource } from './account-lifecycle.ts'
import type { AccountRuntimeState, AccountStateStore } from './account-state.ts'
import type { OperationPort, Session } from './executors.ts'

/** 距上次成功校验不足该值时直接返回缓存，避免面板刷新风暴打到 mtop。 */
export const VERIFY_COOLDOWN_MS = 5_000

export interface VerifyCredentials extends AccountCredentialSource {
  save(input: { accountId: string; cookies: Record<string, string>; meta?: Record<string, unknown> }): Promise<unknown>
}

export interface AccountVerifierDeps {
  credentials: VerifyCredentials
  ports: Pick<OperationPort, 'verifySession'>
  state: AccountStateStore
  now: () => number
  /** 状态写盘失败只记日志：用户要的是校验结论，缓存写没写进去不该改变 HTTP 结果。 */
  onRecordError?: (error: unknown) => void
}

export interface AccountVerifier {
  verify(accountId: string, source?: AccountRuntimeState['source']): Promise<AccountSessionState>
}

export function createAccountVerifier(deps: AccountVerifierDeps): AccountVerifier {
  const inflight = new Map<string, Promise<AccountSessionState>>()
  const fresh = new Map<string, AccountSessionState>()

  const record = async (
    accountId: string,
    state: AccountSessionState,
    source: AccountRuntimeState['source'],
  ): Promise<AccountSessionState> => {
    if (state.online) fresh.set(accountId, state)
    const runtimeState: AccountRuntimeState = {
      checkedAt: state.checkedAt,
      online: state.online,
      refreshed: state.refreshed,
      source,
      ...(state.code === undefined ? {} : { code: state.code }),
      ...(state.message === undefined ? {} : { message: state.message }),
    }
    try {
      await deps.state.record(accountId, runtimeState)
    } catch (error) {
      deps.onRecordError?.(error)
    }
    return state
  }

  const verify = async (
    accountId: string,
    source: AccountRuntimeState['source'] = 'manual',
  ): Promise<AccountSessionState> => {
    const last = fresh.get(accountId)
    if (last !== undefined && deps.now() - last.checkedAt < VERIFY_COOLDOWN_MS) return { ...last, cached: true }
    const running = inflight.get(accountId)
    if (running !== undefined) return running
    const task = runVerify(deps, accountId, source, record)
    inflight.set(accountId, task)
    try {
      return await task
    } finally {
      // 只删自己这一条：如果失败后已有新的单飞进来，别把它的 entry 也删掉。
      if (inflight.get(accountId) === task) inflight.delete(accountId)
    }
  }

  return { verify }
}

async function runVerify(
  deps: AccountVerifierDeps,
  accountId: string,
  source: AccountRuntimeState['source'],
  record: (accountId: string, state: AccountSessionState, source: AccountRuntimeState['source']) => Promise<AccountSessionState>,
): Promise<AccountSessionState> {
  const checkedAt = deps.now()
  let credential: CredentialRecord
  try {
    const loaded = await deps.credentials.load(accountId)
    if (loaded === undefined) fail('VALIDATION', '账号不存在：' + accountId)
    credential = loaded
  } catch (error) {
    // 账号不存在要出去变成 400；凭据读不出来是校验失败，不能变成 500。
    const failure = classifyVerifyError(error)
    if (failure.code === 'VALIDATION') throw error
    return record(accountId, buildAccountSessionState({ accountId, checkedAt, refreshed: false, failure }), source)
  }

  let refreshed = false
  const deviceId = credential.meta?.['deviceId']
  const session: Session = {
    accountId: credential.accountId,
    cookies: credential.cookies,
    ...(typeof deviceId === 'string' ? { deviceId } : {}),
    onSessionUpdate: async (cookies) => {
      // 刷新成功才算 refreshed：save 抛错时必须让这次校验按失败处理（否则面板会以为令牌已续上）。
      await deps.credentials.save({
        accountId: credential.accountId,
        cookies,
        meta: { ...(credential.meta ?? {}), refreshedAt: deps.now() },
      })
      refreshed = true
    },
  }

  try {
    await deps.ports.verifySession({ session })
    return await record(accountId, buildAccountSessionState({ accountId: credential.accountId, checkedAt, refreshed }), source)
  } catch (error) {
    return record(
      accountId,
      buildAccountSessionState({ accountId: credential.accountId, checkedAt, refreshed, failure: classifyVerifyError(error) }),
      source,
    )
  }
}
