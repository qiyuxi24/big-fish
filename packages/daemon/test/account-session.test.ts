/**
 * 登录态校验执行器单测：冷却、单飞、结果落 account-state、刷新回写。
 *
 * 为什么不用真 runtime：这里要精确控制并发（两个 verify 同一账号）与失败时序，
 * 直接注入假凭据库、假 state、假 ports 比起 HTTP 服务更稳定，也不会打真实 mtop。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'
import type { CredentialRecord } from '@bigfish/core'

import { VERIFY_COOLDOWN_MS, createAccountVerifier } from '../src/account-session.ts'
import type { AccountVerifier, VerifyCredentials } from '../src/account-session.ts'
import type { AccountRuntimeState, AccountStateStore } from '../src/account-state.ts'
import type { OperationPort, Session } from '../src/executors.ts'

interface SaveInput {
  accountId: string
  cookies: Record<string, string>
  meta?: Record<string, unknown>
}

interface FixtureOptions {
  records?: readonly CredentialRecord[]
  loadError?: unknown
  verifySession?: (session: Session) => Promise<void>
  saveError?: unknown
  recordError?: unknown
}

interface Fixture {
  verifier: AccountVerifier
  calls: Session[]
  saved: SaveInput[]
  recorded: Array<{ accountId: string; state: AccountRuntimeState }>
  recordErrors: unknown[]
  setNow(value: number): void
}

const START = 1_000_000

function credential(accountId: string, overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    accountId,
    cookies: { unb: 'u-' + accountId, _m_h5_tk: 'tk-' + accountId },
    updatedAt: 1,
    meta: { deviceId: 'dev-1', source: 'chrome-cdp' },
    ...overrides,
  }
}

function createFixture(options: FixtureOptions = {}): Fixture {
  let nowMs = START
  const records = new Map<string, CredentialRecord>()
  for (const entry of options.records ?? [credential('a1')]) records.set(entry.accountId, entry)
  const calls: Session[] = []
  const saved: SaveInput[] = []
  const recorded: Array<{ accountId: string; state: AccountRuntimeState }> = []
  const recordErrors: unknown[] = []

  const credentials: VerifyCredentials = {
    async load(accountId: string): Promise<CredentialRecord | undefined> {
      if (options.loadError !== undefined) throw options.loadError
      return records.get(accountId)
    },
    async save(input: SaveInput): Promise<void> {
      if (options.saveError !== undefined) throw options.saveError
      saved.push(input)
    },
    async remove(accountId: string): Promise<boolean> {
      return records.delete(accountId)
    },
  }

  const ports: Pick<OperationPort, 'verifySession'> = {
    async verifySession({ session }: { session: Session }): Promise<void> {
      calls.push(session)
      if (options.verifySession !== undefined) await options.verifySession(session)
    },
  }

  const state: AccountStateStore = {
    async read(): Promise<Record<string, AccountRuntimeState>> {
      return {}
    },
    async record(accountId: string, entry: AccountRuntimeState): Promise<void> {
      if (options.recordError !== undefined) throw options.recordError
      recorded.push({ accountId, state: entry })
    },
    async remove(): Promise<void> {
      // 校验器不删状态，占位以满足接口。
    },
  }

  const verifier = createAccountVerifier({
    credentials,
    ports,
    state,
    now: (): number => nowMs,
    onRecordError: (error) => {
      recordErrors.push(error)
    },
  })
  return {
    verifier,
    calls,
    saved,
    recorded,
    recordErrors,
    setNow(value: number): void {
      nowMs = value
    },
  }
}

describe('createAccountVerifier', () => {
  it('成功：online:true + checkedAt 取注入时钟，并落 account-state（source=manual）', async () => {
    const fixture = createFixture()
    const state = await fixture.verifier.verify('a1')

    assert.deepEqual(state, { accountId: 'a1', online: true, checkedAt: START, refreshed: false })
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.saved.length, 0)
    assert.deepEqual(fixture.recorded, [
      { accountId: 'a1', state: { checkedAt: START, online: true, refreshed: false, source: 'manual' } },
    ])
  })

  it('冷却窗口内重复请求直接回缓存（cached:true），不打第二次 mtop', async () => {
    const fixture = createFixture()
    const first = await fixture.verifier.verify('a1')
    const second = await fixture.verifier.verify('a1')

    assert.equal(fixture.calls.length, 1)
    assert.equal('cached' in first, false)
    assert.equal(second.cached, true)
    assert.equal(second.checkedAt, first.checkedAt)

    fixture.setNow(START + VERIFY_COOLDOWN_MS)
    const third = await fixture.verifier.verify('a1')
    assert.equal(fixture.calls.length, 2)
    assert.equal('cached' in third, false)
  })

  it('失败结果不进冷却：立刻重试会真的再打一次', async () => {
    const fixture = createFixture({
      verifySession: async (): Promise<void> => {
        throw new XianyuError({ code: 'AUTH_EXPIRED', message: 'FAIL_SYS_SESSION_EXPIRED::登录态失效' })
      },
    })
    const first = await fixture.verifier.verify('a1')
    assert.equal(first.online, false)
    assert.equal(first.code, 'AUTH_EXPIRED')
    assert.match(first.message ?? '', /登录态已失效/)
    // 脱敏：原始 message 里的平台 ret 细节不透传。
    assert.doesNotMatch(first.message ?? '', /FAIL_SYS_SESSION_EXPIRED/)

    const second = await fixture.verifier.verify('a1')
    assert.equal(fixture.calls.length, 2)
    assert.notEqual(second.cached, true)
  })

  it('单飞：同账号并发共享同一个 Promise，只打一次 mtop', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fixture = createFixture({
      verifySession: async (): Promise<void> => {
        await gate
      },
    })
    const first = fixture.verifier.verify('a1')
    const second = fixture.verifier.verify('a1')
    release()
    const [a, b] = await Promise.all([first, second])

    assert.equal(fixture.calls.length, 1)
    assert.deepEqual(a, b)
    assert.equal(a.online, true)
  })

  it('source=keepalive 会写进 account-state，便于面板区分人工/后台检测', async () => {
    const fixture = createFixture()
    await fixture.verifier.verify('a1', 'keepalive')
    assert.equal(fixture.recorded[0]?.state.source, 'keepalive')
  })

  it('令牌刷新：onSessionUpdate 写回合并后的 cookies 与 meta.refreshedAt，refreshed:true', async () => {
    const fixture = createFixture({
      verifySession: async (session: Session): Promise<void> => {
        await session.onSessionUpdate?.({ ...session.cookies, _m_h5_tk: 'tk-new' })
      },
    })
    const state = await fixture.verifier.verify('a1')

    assert.equal(state.online, true)
    assert.equal(state.refreshed, true)
    assert.equal(fixture.saved.length, 1)
    const saved = fixture.saved[0]
    assert.ok(saved !== undefined)
    assert.deepEqual(saved.cookies, { unb: 'u-a1', _m_h5_tk: 'tk-new' })
    // 保留原 meta（deviceId 是后续请求要用的），只追加 refreshedAt。
    assert.equal(saved.meta?.['deviceId'], 'dev-1')
    assert.equal(saved.meta?.['source'], 'chrome-cdp')
    assert.equal(saved.meta?.['refreshedAt'], START)
    assert.equal(fixture.recorded[0]?.state.refreshed, true)
  })

  it('刷新回写失败 → 按失败处理（online:false INTERNAL，refreshed:false）', async () => {
    const fixture = createFixture({
      verifySession: async (session: Session): Promise<void> => {
        await session.onSessionUpdate?.({ ...session.cookies, _m_h5_tk: 'tk-new' })
      },
      saveError: new XianyuError({ code: 'STORAGE', message: '凭据写盘失败' }),
    })
    const state = await fixture.verifier.verify('a1')
    assert.equal(state.online, false)
    assert.equal(state.code, 'INTERNAL')
    assert.equal(state.refreshed, false)
  })

  it('账号不存在 → VALIDATION 抛出（要变成 HTTP 400，不是 200 online:false）', async () => {
    const fixture = createFixture()
    await assert.rejects(
      async () => fixture.verifier.verify('missing'),
      (error: unknown): boolean => {
        assert.ok(error instanceof XianyuError)
        assert.equal(error.code, 'VALIDATION')
        assert.equal(error.message, '账号不存在：missing')
        return true
      },
    )
    assert.equal(fixture.calls.length, 0)
    assert.deepEqual(fixture.recorded, [])
  })

  it('凭据读取失败（STORAGE）→ 200 online:false INTERNAL，不冒成 500', async () => {
    const fixture = createFixture({ loadError: new XianyuError({ code: 'STORAGE', message: '凭据文件损坏' }) })
    const state = await fixture.verifier.verify('a1')
    assert.equal(state.online, false)
    assert.equal(state.code, 'INTERNAL')
    assert.equal(fixture.calls.length, 0)
    assert.equal(fixture.recorded.length, 1)
  })

  it('通道 VALIDATION（如缺 unb）保留原文文案', async () => {
    const fixture = createFixture({
      verifySession: async (): Promise<void> => {
        throw new XianyuError({ code: 'VALIDATION', message: '凭据里没有 unb，无法校验登录态' })
      },
    })
    const state = await fixture.verifier.verify('a1')
    assert.equal(state.code, 'VALIDATION')
    assert.equal(state.message, '凭据里没有 unb，无法校验登录态')
  })

  it('非 XianyuError（网络底层异常）归 INTERNAL', async () => {
    const fixture = createFixture({
      verifySession: async (): Promise<void> => {
        throw new TypeError('fetch failed')
      },
    })
    const state = await fixture.verifier.verify('a1')
    assert.equal(state.online, false)
    assert.equal(state.code, 'INTERNAL')
  })

  it('account-state 写盘失败不影响本次结论，只走 onRecordError', async () => {
    const fixture = createFixture({ recordError: new Error('disk full') })
    const state = await fixture.verifier.verify('a1')
    assert.equal(state.online, true)
    assert.equal(fixture.recordErrors.length, 1)
  })
})
