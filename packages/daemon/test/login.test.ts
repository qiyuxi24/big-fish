/**
 * 扫码登录核心逻辑测试：注入假时钟/假浏览器，不真连 Chrome、不 sleep 真实时间。
 * 覆盖成功、轮询先无后有、超时、缺 unb、参数校验、取消与耗时记录。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { CredentialStore, XianyuError } from '@bigfish/core'
import type { CookieJar } from '@bigfish/channel-cdp'

import { DEFAULT_LOGIN_TIMEOUT_MS, formatLoginTick, loginAndSave, waitForLogin } from '../src/login.ts'
import type { LoginRuntimeDeps } from '../src/login.ts'

/** 临时凭据目录放 .scratch（已 gitignore），便于失败后排查残留。 */
const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-login/', import.meta.url))
const NOW = 1_700_000_000_000
const READY: CookieJar = { goofish: { unb: '12345', _m_h5_tk: 'tk-value' }, others: 2 }

interface FakeClock {
  deps: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
  advance(ms: number): void
  sleeps: number[]
}

/** 假时钟：sleep 不真等，只推进毫秒数，让超时/轮询断言可确定。 */
function fakeClock(start: number = NOW): FakeClock {
  let current = start
  const sleeps: number[] = []
  return {
    sleeps,
    deps: {
      now: (): number => current,
      sleep: async (ms: number, signal?: AbortSignal): Promise<void> => {
        if (signal?.aborted === true) throw cancelled()
        sleeps.push(ms)
        current += ms
      },
    },
    advance: (ms: number): void => {
      current += ms
    },
  }
}

/** 假读取器：按顺序返回 jar 或抛错；超出预期次数直接失败，防止偷偷多轮询。 */
function reader(sequence: ReadonlyArray<CookieJar | Error>): {
  read(port: number): Promise<CookieJar>
  calls: number[]
} {
  const calls: number[] = []
  let index = 0
  return {
    calls,
    read: async (port: number): Promise<CookieJar> => {
      calls.push(port)
      const next = sequence[index]
      index += 1
      if (next === undefined) throw new Error('测试读取次数超出预期：第 ' + String(index) + ' 次')
      if (next instanceof Error) throw next
      return next
    },
  }
}

function unauthorized(message: string): XianyuError {
  return new XianyuError({ code: 'UNAUTHORIZED', message })
}

function cancelled(): XianyuError {
  return unauthorized('扫码登录已取消：等待被中止（可重新运行 login 子命令）')
}

function assertCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof XianyuError, '期望 XianyuError，实际 ' + String(error))
    assert.equal(error.code, code)
    return true
  }
}

describe('waitForLogin', () => {
  it('打开登录页并读到完整登录态后返回 jar', async () => {
    const clock = fakeClock()
    const source = reader([READY])
    const opened: number[] = []
    const ticks: Array<{ attempt: number; elapsedMs: number }> = []
    const result = await waitForLogin(
      {
        port: 9333,
        timeoutMs: 5000,
        pollIntervalMs: 1000,
        onTick: (tick): void => {
          ticks.push(tick)
        },
      },
      {
        ...clock.deps,
        openLoginPage: async (port: number): Promise<void> => {
          opened.push(port)
        },
        readLoginJar: source.read,
      },
    )
    assert.deepEqual(result, READY)
    assert.deepEqual(opened, [9333])
    assert.equal(source.calls.length, 1)
    assert.deepEqual(ticks, [{ attempt: 1, elapsedMs: 0 }])
    assert.deepEqual(clock.sleeps, [])
  })

  it('先无后有：缺 unb / 缺 _m_h5_tk 都继续等，第三轮才成功', async () => {
    const clock = fakeClock()
    const source = reader([
      { goofish: { _m_h5_tk: 'tk' }, others: 0 },
      { goofish: { unb: '12345' }, others: 0 },
      READY,
    ])
    const result = await waitForLogin(
      { timeoutMs: 10_000, pollIntervalMs: 2000 },
      {
        ...clock.deps,
        openLoginPage: async (): Promise<void> => {},
        readLoginJar: source.read,
      },
    )
    assert.deepEqual(result, READY)
    assert.equal(source.calls.length, 3)
    assert.deepEqual(clock.sleeps, [2000, 2000])
  })

  it('读取抛 UNAUTHORIZED（还没登录）时继续等，不是一次失败就退出', async () => {
    const clock = fakeClock()
    const source = reader([unauthorized('缺少 cookie unb、_m_h5_tk'), READY])
    const result = await waitForLogin(
      { timeoutMs: 10_000, pollIntervalMs: 2000 },
      { ...clock.deps, openLoginPage: async (): Promise<void> => {}, readLoginJar: source.read },
    )
    assert.deepEqual(result, READY)
    assert.equal(source.calls.length, 2)
  })

  it('超时：抛 UNAUTHORIZED 且文案给可操作提示，轮询次数与间隔正确', async () => {
    const clock = fakeClock()
    const source = reader(new Array(10).fill(unauthorized('还没读到登录 cookie')))
    const ticks: number[] = []
    await assert.rejects(
      async () =>
        waitForLogin(
          {
            timeoutMs: 5000,
            pollIntervalMs: 1000,
            onTick: (tick): void => {
              ticks.push(tick.elapsedMs)
            },
          },
          { ...clock.deps, openLoginPage: async (): Promise<void> => {}, readLoginJar: source.read },
        ),
      (error: unknown): boolean => {
        assertCode('UNAUTHORIZED')(error)
        const message = (error as XianyuError).message
        assert.match(message, /扫码超时/)
        assert.match(message, /完成扫码/)
        assert.match(message, /端口 9222/)
        assert.match(message, /最后状态/)
        return true
      },
    )
    assert.equal(source.calls.length, 5)
    assert.deepEqual(clock.sleeps, [1000, 1000, 1000, 1000, 1000])
    assert.deepEqual(ticks, [0, 1000, 2000, 3000, 4000, 5000])
  })

  it('缺 unb 一直轮询到超时，并在文案里指出最后缺的是什么', async () => {
    const clock = fakeClock()
    const source = reader(new Array(6).fill({ goofish: { _m_h5_tk: 'tk' }, others: 0 }))
    await assert.rejects(
      async () =>
        waitForLogin(
          { timeoutMs: 3000, pollIntervalMs: 1000 },
          { ...clock.deps, openLoginPage: async (): Promise<void> => {}, readLoginJar: source.read },
        ),
      (error: unknown): boolean => {
        assert.match((error as XianyuError).message, /unb/)
        return true
      },
    )
    assert.equal(source.calls.length, 3)
  })

  it('非 UNAUTHORIZED 的读取失败立即抛出（不伪装成还没登录）', async () => {
    const clock = fakeClock()
    const source = reader([new XianyuError({ code: 'NETWORK', message: '连不上 DevTools（端口 9222）' })])
    await assert.rejects(
      async () =>
        waitForLogin(
          { timeoutMs: 10_000, pollIntervalMs: 2000 },
          { ...clock.deps, openLoginPage: async (): Promise<void> => {}, readLoginJar: source.read },
        ),
      assertCode('NETWORK'),
    )
    // 读之前就 push 了调用记录：真发生了一次读取，但不能继续轮询。
    assert.equal(source.calls.length, 1)
  })

  it('参数非法 → VALIDATION，且不会打开登录页', async () => {
    let opened = 0
    const open = async (): Promise<void> => {
      opened += 1
    }
    for (const options of [{ port: 0 }, { port: 70000 }, { timeoutMs: 0 }, { timeoutMs: 1.5 }, { pollIntervalMs: 0 }]) {
      await assert.rejects(
        async () => waitForLogin(options, { openLoginPage: open }),
        assertCode('VALIDATION'),
        JSON.stringify(options),
      )
    }
    assert.equal(opened, 0)
  })

  it('signal 已中止：打开页面后立即取消，不再读 cookie', async () => {
    const clock = fakeClock()
    const source = reader([READY])
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      async () =>
        waitForLogin(
          { signal: controller.signal },
          { ...clock.deps, openLoginPage: async (): Promise<void> => {}, readLoginJar: source.read },
        ),
      (error: unknown): boolean => {
        assertCode('UNAUTHORIZED')(error)
        assert.match((error as XianyuError).message, /已取消/)
        return true
      },
    )
    assert.equal(source.calls.length, 0)
  })

  it('formatLoginTick 输出可读的中文进度', () => {
    assert.equal(formatLoginTick({ attempt: 3, elapsedMs: 4200 }), '等待扫码中（已等 4s，第 3 次检查）…')
    assert.equal(formatLoginTick({ attempt: 1, elapsedMs: 800 }), '等待扫码中（已等 0s，第 1 次检查）…')
  })
})

async function makeStore(t: { after(fn: () => Promise<void>): void }): Promise<CredentialStore> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'run-'))
  t.after(async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  })
  return new CredentialStore({ dir, now: (): number => NOW })
}

describe('loginAndSave', () => {
  it('复用 saveImportedAccount 落库，并记录从开始等待到落库的耗时', async (t) => {
    const credentials = await makeStore(t)
    const clock = fakeClock()
    const deps: LoginRuntimeDeps = {
      ...clock.deps,
      openLoginPage: async (): Promise<void> => {},
      readLoginJar: async (): Promise<CookieJar> => {
        clock.advance(3000)
        return READY
      },
    }
    const result = await loginAndSave({ credentials, ...deps })
    assert.equal(result.accountId, '12345')
    assert.equal(result.savedFieldCount, 2)
    assert.equal(result.source, 'chrome-cdp')
    assert.equal(result.elapsedMs, 3000)
    // 返回值绝不能带 cookie 值。
    assert.equal(JSON.stringify(result).includes('tk-value'), false)
    const record = await credentials.load('12345')
    assert.ok(record !== undefined)
    assert.deepEqual(record.cookies, { unb: '12345', _m_h5_tk: 'tk-value' })
  })

  it('显式 accountId 优先，耗时随等待增长', async (t) => {
    const credentials = await makeStore(t)
    const clock = fakeClock()
    let reads = 0
    const result = await loginAndSave(
      {
        credentials,
        ...clock.deps,
        openLoginPage: async (): Promise<void> => {},
        readLoginJar: async (): Promise<CookieJar> => {
          reads += 1
          if (reads < 2) throw unauthorized('还没读到登录 cookie')
          return READY
        },
      },
      { accountId: 'main-shop', timeoutMs: 10_000, pollIntervalMs: 2000 },
    )
    assert.equal(result.accountId, 'main-shop')
    assert.equal(result.elapsedMs, 2000)
    const record = await credentials.load('main-shop')
    assert.ok(record !== undefined)
    assert.equal(record.cookies['unb'], '12345')
  })

  it('先确保有浏览器再开登录页，成功与失败都要释放（自起浏览器不能漏关闭）', async (t) => {
    const credentials = await makeStore(t)
    const clock = fakeClock()
    const events: string[] = []
    const ensure = async (port: number): Promise<() => Promise<void>> => {
      events.push('ensure:' + String(port))
      return async (): Promise<void> => {
        events.push('release')
      }
    }
    const base = {
      credentials,
      ...clock.deps,
      ensureBrowser: ensure,
      openLoginPage: async (): Promise<void> => {
        events.push('open')
      },
    }
    const ok = await loginAndSave(
      { ...base, readLoginJar: async (): Promise<CookieJar> => READY },
      { port: 9333 },
    )
    assert.equal(ok.accountId, '12345')
    assert.deepEqual(events, ['ensure:9333', 'open', 'release'])

    // 失败路径：等待超时也要走 finally 释放，否则后台会留一个没人管的 Chrome。
    events.length = 0
    await assert.rejects(
      async () =>
        loginAndSave(
          {
            ...base,
            readLoginJar: async (): Promise<CookieJar> => {
              throw unauthorized('还没读到登录 cookie')
            },
          },
          { port: 9333, timeoutMs: 1000, pollIntervalMs: 1000 },
        ),
      assertCode('UNAUTHORIZED'),
    )
    assert.deepEqual(events, ['ensure:9333', 'open', 'release'])
  })

  it('释放失败只走告警出口，不盖住登录结果', async (t) => {
    const credentials = await makeStore(t)
    const warnings: string[] = []
    const result = await loginAndSave(
      {
        credentials,
        ensureBrowser: async (): Promise<() => Promise<void>> => async (): Promise<void> => {
          throw new Error('已经退出了')
        },
        onWarn: (message: string): void => {
          warnings.push(message)
        },
        openLoginPage: async (): Promise<void> => {},
        readLoginJar: async (): Promise<CookieJar> => READY,
      },
      { port: 9333 },
    )
    assert.equal(result.accountId, '12345')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /关闭扫码浏览器失败/)
  })

  it('超时 → UNAUTHORIZED，且一条凭据都不写', async (t) => {
    const credentials = await makeStore(t)
    const clock = fakeClock()
    await assert.rejects(
      async () =>
        loginAndSave(
          {
            credentials,
            ...clock.deps,
            openLoginPage: async (): Promise<void> => {},
            readLoginJar: async (): Promise<CookieJar> => {
              throw unauthorized('还没读到登录 cookie')
            },
          },
          { timeoutMs: 2000, pollIntervalMs: 1000 },
        ),
      assertCode('UNAUTHORIZED'),
    )
    assert.deepEqual(await credentials.list(), [])
  })

  it('默认超时是 180 秒', () => {
    assert.equal(DEFAULT_LOGIN_TIMEOUT_MS, 180_000)
  })
})
