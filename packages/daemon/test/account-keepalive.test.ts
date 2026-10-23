/**
 * 保活定时器与账号挑选器单测：假定时器 + 假时钟，不 sleep、不打真实 mtop。
 *
 * 为什么测「跳过重叠轮」：verify 慢通常意味着网络差/风控，排队只会让请求越堆越多，
 * 正确行为是跳过本轮而不是补跑；stop 必须幂等，否则 close() 二次调用会泄漏定时器。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_SETTINGS, XianyuError } from '@bigfish/core'
import type { CredentialRecord, Settings } from '@bigfish/core'

import { createKeepAlivePicker, startAccountKeepAlive } from '../src/account-keepalive.ts'
import type { AccountKeepAliveTimer } from '../src/account-keepalive.ts'
import type { CredentialSource } from '../src/account-list.ts'

interface FakeTimer {
  timer: AccountKeepAliveTimer
  fire(): Promise<void>
  intervals(): number[]
  clearCount(): number
}

function createFakeTimer(): FakeTimer {
  const callbacks: Array<() => void> = []
  const delays: number[] = []
  let clears = 0
  return {
    timer: {
      setInterval(callback: () => void, intervalMs: number): unknown {
        callbacks.push(callback)
        delays.push(intervalMs)
        return callback
      },
      clearInterval(): void {
        clears += 1
      },
    },
    async fire(): Promise<void> {
      callbacks.at(-1)?.()
      await flush()
    },
    intervals: (): number[] => delays,
    clearCount: (): number => clears,
  }
}

/** tick 内部有多层 await，两个 setImmediate 足够让「未被挂起的 Promise 链」跑完。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function settingsWith(activeAccountId: string): { get: () => Promise<Settings> } {
  return { get: async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, activeAccountId }) }
}

function credentialsOf(entries: Record<string, CredentialRecord | Error>): CredentialSource {
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

function record(accountId: string, cookies: Record<string, string>): CredentialRecord {
  return { accountId, cookies, updatedAt: 1 }
}

describe('startAccountKeepAlive', () => {
  it('按注入间隔触发一次校验（用 picker 挑的账号）', async () => {
    const fake = createFakeTimer()
    const verified: string[] = []
    startAccountKeepAlive({
      intervalMs: 60_000,
      verify: async (accountId) => {
        verified.push(accountId)
      },
      pickAccountId: async () => 'a1',
      timer: fake.timer,
    })
    assert.deepEqual(fake.intervals(), [60_000])
    await fake.fire()
    assert.deepEqual(verified, ['a1'])
  })

  it('picker 返回 undefined 时本轮不校验', async () => {
    const fake = createFakeTimer()
    const verified: string[] = []
    startAccountKeepAlive({
      intervalMs: 1_000,
      verify: async (accountId) => {
        verified.push(accountId)
      },
      pickAccountId: async () => undefined,
      timer: fake.timer,
    })
    await fake.fire()
    assert.deepEqual(verified, [])
  })

  it('上一轮未结束 → 跳过本轮，不排队', async () => {
    const fake = createFakeTimer()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    startAccountKeepAlive({
      intervalMs: 1_000,
      verify: async () => {
        calls += 1
        await gate
      },
      pickAccountId: async () => 'a1',
      timer: fake.timer,
    })

    await fake.fire()
    await fake.fire()
    assert.equal(calls, 1)

    release()
    await flush()
    await fake.fire()
    assert.equal(calls, 2)
  })

  it('stop 幂等：只有第一次真正清表，之后不再触发', async () => {
    const fake = createFakeTimer()
    let calls = 0
    const keepAlive = startAccountKeepAlive({
      intervalMs: 1_000,
      verify: async () => {
        calls += 1
      },
      pickAccountId: async () => 'a1',
      timer: fake.timer,
    })
    keepAlive.stop()
    keepAlive.stop()
    assert.equal(fake.clearCount(), 1)

    await fake.fire()
    assert.equal(calls, 0)
  })

  it('verify 抛错 → onError 收到错误，下一轮继续跑', async () => {
    const fake = createFakeTimer()
    const errors: unknown[] = []
    let calls = 0
    startAccountKeepAlive({
      intervalMs: 1_000,
      verify: async () => {
        calls += 1
        throw new XianyuError({ code: 'NETWORK', message: 'socket hang up' })
      },
      pickAccountId: async () => 'a1',
      onError: (error) => {
        errors.push(error)
      },
      timer: fake.timer,
    })
    await fake.fire()
    await fake.fire()
    assert.equal(calls, 2)
    assert.equal(errors.length, 2)
  })

  it('picker 抛错也只走 onError，不停表', async () => {
    const fake = createFakeTimer()
    const errors: unknown[] = []
    startAccountKeepAlive({
      intervalMs: 1_000,
      verify: async () => undefined,
      pickAccountId: async () => {
        throw new Error('凭据库读失败')
      },
      onError: (error) => {
        errors.push(error)
      },
      timer: fake.timer,
    })
    await fake.fire()
    assert.equal(errors.length, 1)
    assert.equal(fake.clearCount(), 0)
  })

  it('非法间隔 → VALIDATION（不允许 0 / 负数 / 非整数）', () => {
    for (const intervalMs of [0, -1, 1.5]) {
      assert.throws(
        () =>
          startAccountKeepAlive({
            intervalMs,
            verify: async () => undefined,
            pickAccountId: async () => undefined,
            timer: createFakeTimer().timer,
          }),
        (error: unknown): boolean => {
          assert.ok(error instanceof XianyuError)
          assert.equal(error.code, 'VALIDATION')
          return true
        },
      )
    }
  })
})

describe('createKeepAlivePicker', () => {
  it('优先当前激活账号（即使它不是 ready 的第一个）', async () => {
    const pick = createKeepAlivePicker({
      credentials: credentialsOf({
        a1: record('a1', { unb: 'u1', _m_h5_tk: 'tk1' }),
        a2: record('a2', { unb: 'u2' }),
      }),
      settings: settingsWith('a2'),
    })
    assert.equal(await pick(), 'a2')
  })

  it('激活账号为空 → 取第一个 ready 账号（跳过缺 _m_h5_tk 的）', async () => {
    const pick = createKeepAlivePicker({
      credentials: credentialsOf({
        a1: record('a1', { unb: 'u1' }),
        a2: record('a2', { unb: 'u2', _m_h5_tk: 'tk2' }),
      }),
      settings: settingsWith(''),
    })
    assert.equal(await pick(), 'a2')
  })

  it('激活账号不存在 → 退到第一个 ready 账号', async () => {
    const pick = createKeepAlivePicker({
      credentials: credentialsOf({ a1: record('a1', { unb: 'u1', _m_h5_tk: 'tk1' }) }),
      settings: settingsWith('gone'),
    })
    assert.equal(await pick(), 'a1')
  })

  it('坏凭据只跳过它自己，不影响其它账号', async () => {
    const pick = createKeepAlivePicker({
      credentials: credentialsOf({
        broken: new XianyuError({ code: 'STORAGE', message: '解密失败' }),
        good: record('good', { unb: 'u', _m_h5_tk: 'tk' }),
      }),
      settings: settingsWith('broken'),
    })
    assert.equal(await pick(), 'good')
  })

  it('没有可用账号 → undefined（本轮跳过，不误报错误）', async () => {
    const pick = createKeepAlivePicker({
      credentials: credentialsOf({ a1: record('a1', { unb: 'u1' }) }),
      settings: settingsWith(''),
    })
    assert.equal(await pick(), undefined)
  })
})
