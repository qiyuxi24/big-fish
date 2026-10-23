/**
 * listAccountSummaries 单测：摘要字段、ready 判定、损坏凭据不拖垮整表、时间非负、敏感值不外泄。
 * 用假 CredentialSource，不落加密文件（加解密由 core 的 credentials 测试覆盖）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'
import type { CredentialRecord } from '@bigfish/core'

import { ESTIMATED_TOKEN_TTL_MS, listAccountSummaries } from '../src/account-list.ts'
import type { CredentialSource } from '../src/account-list.ts'
import type { AccountRuntimeState } from '../src/account-state.ts'

function record(accountId: string, cookies: Record<string, string>, updatedAt = 1_000): CredentialRecord {
  return { accountId, cookies, updatedAt }
}

/** 假凭据源：值为 Error 时模拟损坏文件；值为 undefined 时模拟 list/load 之间被删。 */
function source(entries: Record<string, CredentialRecord | Error | undefined>): CredentialSource {
  return {
    async list(): Promise<string[]> {
      return Object.keys(entries).sort()
    },
    async load(accountId: string): Promise<CredentialRecord | undefined> {
      const entry = entries[accountId]
      if (entry instanceof Error) throw entry
      return entry
    },
  }
}

describe('listAccountSummaries', () => {
  it('unb + _m_h5_tk 齐备 → ready，且透出 unb / 字段数 / ageMs', async () => {
    const summaries = await listAccountSummaries({
      credentials: source({ '2206569289277': record('2206569289277', { unb: '2206569289277', _m_h5_tk: 'tk', cna: 'x' }, 1_000) }),
      now: () => 5_000,
    })
    assert.deepEqual(summaries, [
      { accountId: '2206569289277', updatedAt: 1_000, savedFieldCount: 3, ready: true, unb: '2206569289277', ageMs: 4_000, active: false },
    ])
  })

  it('缺 _m_h5_tk → ready=false（缺 token 不能跑写操作）', async () => {
    const summaries = await listAccountSummaries({ credentials: source({ a1: record('a1', { unb: 'u1' }, 10) }), now: () => 10 })
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0]?.ready, false)
    assert.equal(summaries[0]?.unb, 'u1')
  })

  it('空字符串不算有值', async () => {
    const summaries = await listAccountSummaries({
      credentials: source({ a1: record('a1', { unb: 'u1', _m_h5_tk: '   ' }, 10) }),
      now: () => 10,
    })
    assert.equal(summaries[0]?.ready, false)
  })

  it('缺 unb → 不带 unb 字段（不是空字符串）', async () => {
    const summaries = await listAccountSummaries({
      credentials: source({ a1: record('a1', { _m_h5_tk: 'tk', cna: 'c' }, 10) }),
      now: () => 10,
    })
    assert.equal(summaries[0]?.ready, false)
    assert.equal('unb' in (summaries[0] ?? {}), false)
  })

  it('单个凭据损坏 → broken 条目不拖垮整表', async () => {
    const summaries = await listAccountSummaries({
      credentials: source({
        broken: new XianyuError({ code: 'STORAGE', message: '凭据文件损坏: broken' }),
        good: record('good', { unb: 'u', _m_h5_tk: 'tk' }, 100),
      }),
      now: () => 200,
    })
    assert.equal(summaries.length, 2)
    assert.deepEqual(summaries[0], {
      accountId: 'broken',
      updatedAt: 0,
      savedFieldCount: 0,
      ready: false,
      ageMs: 0,
      active: false,
      broken: true,
      brokenReason: '凭据文件无法读取或解密（STORAGE）',
    })
    assert.equal(summaries[1]?.ready, true)
  })

  it('list 与 load 之间凭据被删（load 返回 undefined）→ 跳过', async () => {
    const summaries = await listAccountSummaries({ credentials: source({ gone: undefined }), now: () => 1 })
    assert.deepEqual(summaries, [])
  })

  it('时钟倒退时 ageMs 不为负', async () => {
    const summaries = await listAccountSummaries({ credentials: source({ a1: record('a1', { unb: 'u', _m_h5_tk: 'tk' }, 5_000) }), now: () => 1_000 })
    assert.equal(summaries[0]?.ageMs, 0)
  })

  it('active 标记来自 deps.activeAccountId（缺省一律 false）', async () => {
    const summaries = await listAccountSummaries({
      credentials: source({ a1: record('a1', {}), a2: record('a2', {}) }),
      now: () => 1,
      activeAccountId: 'a2',
    })
    assert.deepEqual(summaries.map((summary) => summary.active), [false, true])
  })

  it('meta.refreshedAt → 按 refreshedAt + ESTIMATED_TOKEN_TTL_MS 估算，来源 estimated', async () => {
    const summaries = await listAccountSummaries({
      credentials: source({
        a1: { ...record('a1', { unb: 'u', _m_h5_tk: 'tk' }), meta: { refreshedAt: 1_000_000 } },
      }),
      now: () => 2_000_000,
    })
    assert.equal(summaries[0]?.loginExpiresAt, 1_000_000 + ESTIMATED_TOKEN_TTL_MS)
    assert.equal(summaries[0]?.loginExpiresSource, 'estimated')
  })

  it('无 refreshedAt → 用导入时读到的 meta.expires._m_h5_tk，来源 browser', async () => {
    const summaries = await listAccountSummaries({
      credentials: source({ a1: { ...record('a1', {}), meta: { expires: { _m_h5_tk: 999_000 } } } }),
      now: () => 1,
    })
    assert.equal(summaries[0]?.loginExpiresAt, 999_000)
    assert.equal(summaries[0]?.loginExpiresSource, 'browser')
  })

  it('refreshedAt 优先于 expires（刷新过的令牌已续期，旧过期时间不再可信）', async () => {
    const summaries = await listAccountSummaries({
      credentials: source({
        a1: { ...record('a1', {}), meta: { refreshedAt: 1_000, expires: { _m_h5_tk: 5_000 } } },
      }),
      now: () => 1,
    })
    assert.equal(summaries[0]?.loginExpiresSource, 'estimated')
    assert.equal(summaries[0]?.loginExpiresAt, 1_000 + ESTIMATED_TOKEN_TTL_MS)
  })

  it('两种过期时间来源都没有 → 生命周期字段全部缺省（不编造时间）', async () => {
    const summaries = await listAccountSummaries({ credentials: source({ a1: record('a1', {}) }), now: () => 1 })
    const summary = summaries[0] ?? {}
    assert.equal('loginExpiresAt' in summary, false)
    assert.equal('loginExpiresSource' in summary, false)
    assert.equal('lastCheckedAt' in summary, false)
    assert.equal('lastOnline' in summary, false)
    assert.equal('lastCode' in summary, false)
  })

  it('account-state 快照 → lastCheckedAt / lastOnline / lastCode', async () => {
    const state: Record<string, AccountRuntimeState> = {
      a1: { checkedAt: 444, online: false, refreshed: false, source: 'keepalive', code: 'AUTH_EXPIRED', message: '登录态已失效' },
    }
    const summaries = await listAccountSummaries({ credentials: source({ a1: record('a1', {}) }), now: () => 1, state })
    assert.equal(summaries[0]?.lastCheckedAt, 444)
    assert.equal(summaries[0]?.lastOnline, false)
    assert.equal(summaries[0]?.lastCode, 'AUTH_EXPIRED')
    // 摘要只带 code，不带 message：面板按 code 查自己的文案，避免 daemon 文案与 UI 版本漂移。
    assert.equal('lastMessage' in (summaries[0] ?? {}), false)
  })

  it('摘要里不出现任何 cookie 值（只回个数）', async () => {
    const summaries = await listAccountSummaries({
      credentials: source({ a1: record('a1', { unb: '2206569289277', _m_h5_tk: 'SUPER_SECRET_TOKEN', cna: 'SECRET_CNA' }, 1) }),
      now: () => 2,
    })
    const text = JSON.stringify(summaries)
    assert.equal(text.includes('SUPER_SECRET_TOKEN'), false)
    assert.equal(text.includes('SECRET_CNA'), false)
  })
})
