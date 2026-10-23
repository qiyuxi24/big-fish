/**
 * 账号登录态保活：按固定间隔挑一个可用账号做一次心跳校验。
 *
 * 为什么用「上一轮没结束就跳过本轮」而不是排队：保活请求慢通常意味着网络差或风控，
 * 排队只会让请求越堆越多；跳过一轮的代价只是这次心跳晚几分钟。
 */
import { fail } from '@bigfish/core'

import type { CredentialSource } from './account-list.ts'
import type { SettingsStore } from './settings.ts'

export interface AccountKeepAliveTimer {
  setInterval(callback: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
}

export interface AccountKeepAliveOptions {
  intervalMs: number
  /** 做一次校验；抛错只交给 onError，不影响定时器。 */
  verify: (accountId: string) => Promise<unknown>
  pickAccountId: () => Promise<string | undefined>
  onError?: (error: unknown) => void
  /** 测试注入假定时器，避免真实等待间隔。 */
  timer?: AccountKeepAliveTimer
}

export interface AccountKeepAlive {
  stop(): void
}

const SYSTEM_TIMER: AccountKeepAliveTimer = {
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs)
    // 后台定时器不能阻止进程退出：daemon 关闭由 close() 显式 stop，unref 只是兜底。
    timer.unref()
    return timer
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

export function startAccountKeepAlive(options: AccountKeepAliveOptions): AccountKeepAlive {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    fail('VALIDATION', 'keepAliveIntervalMs 必须是正整数毫秒')
  }
  const timer = options.timer ?? SYSTEM_TIMER
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const accountId = await options.pickAccountId()
      if (accountId !== undefined) await options.verify(accountId)
    } catch (error) {
      // 单轮失败（网络抖动 / 风控）不代表要停表：下一轮继续试。
      options.onError?.(error)
    } finally {
      running = false
    }
  }

  const handle = timer.setInterval(() => {
    void tick()
  }, options.intervalMs)

  return {
    stop() {
      if (stopped) return
      stopped = true
      timer.clearInterval(handle)
    },
  }
}

export interface KeepAlivePickerDeps {
  credentials: CredentialSource
  settings: Pick<SettingsStore, 'get'>
}

/** 优先当前激活账号；没有可用激活账号时退到第一个 ready 账号（有 unb 与 _m_h5_tk）。 */
export function createKeepAlivePicker(deps: KeepAlivePickerDeps): () => Promise<string | undefined> {
  return async () => {
    const active = (await deps.settings.get()).activeAccountId
    if (active !== '' && (await loadQuietly(deps.credentials, active)) !== undefined) return active
    for (const accountId of await deps.credentials.list()) {
      const record = await loadQuietly(deps.credentials, accountId)
      if (record !== undefined && hasValue(record.cookies['unb']) && hasValue(record.cookies['_m_h5_tk'])) {
        return accountId
      }
    }
    return undefined
  }
}

/** 坏凭据（解密失败/文件损坏）只跳过它自己，不能拖累其它账号的心跳。 */
async function loadQuietly(credentials: CredentialSource, accountId: string) {
  try {
    return await credentials.load(accountId)
  } catch {
    return undefined
  }
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}
