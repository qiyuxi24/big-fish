/**
 * 托管浏览器：复用 / 拉起 / 单飞 / 只关自己起的 / 窗口被手动关掉能重拉 / 收尾后调用报错。
 * 全部用注入的 probe+launch，不连真浏览器也不 spawn 进程（沙箱禁止 spawn）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'

import { DEFAULT_MANAGED_BROWSER_PORT, createManagedBrowser } from '../src/managed-browser.ts'
import type { BrowserHandle, LaunchRequest } from '../src/managed-browser.ts'

const PORT = 9333
const PROFILE = 'C:/data/chrome-profile'

interface Fixture {
  browser: ReturnType<typeof createManagedBrowser>
  launches: LaunchRequest[]
  closes: () => number
  /** 模拟「用户把窗口关了」/「浏览器崩溃」：端口重新变成没人听。 */
  killPort: () => void
  /** 模拟端口上出现了一个不是我们起的调试浏览器。 */
  openPort: () => void
}

function fixture(options: { reachable?: boolean }): Fixture {
  const launches: LaunchRequest[] = []
  const state = { alive: options.reachable ?? false, closes: 0 }
  const browser = createManagedBrowser({
    port: PORT,
    profileDir: PROFILE,
    probe: async (): Promise<boolean> => state.alive,
    launch: async (request: LaunchRequest): Promise<BrowserHandle> => {
      launches.push(request)
      state.alive = true
      return {
        async close(): Promise<void> {
          state.closes += 1
          state.alive = false
        },
      }
    },
  })
  return {
    browser,
    launches,
    closes: (): number => state.closes,
    killPort: (): void => {
      state.alive = false
    },
    openPort: (): void => {
      state.alive = true
    },
  }
}

describe('createManagedBrowser', () => {
  it('端口上已有调试浏览器：复用、不拉起、也不接管生命周期', async () => {
    const f = fixture({ reachable: true })
    const status = await f.browser.ensure()
    assert.equal(status.running, true)
    assert.equal(status.owned, false)
    assert.equal(f.launches.length, 0)

    await f.browser.stop()
    // 用户自己的工作窗口不能被我们关掉。
    assert.equal(f.closes(), 0)
  })

  it('端口没人听：按 profile 拉起一个，第二次调用不再重复拉起', async () => {
    const f = fixture({ reachable: false })
    const first = await f.browser.ensure()
    assert.equal(first.running, true)
    assert.equal(first.owned, true)
    assert.equal(f.launches.length, 1)
    assert.deepEqual(f.launches[0], { port: PORT, userDataDir: PROFILE, headless: false })

    const second = await f.browser.ensure()
    assert.equal(second.owned, true)
    assert.equal(f.launches.length, 1, '已拉起过就不该再开第二个窗口')
  })

  it('并发 ensure 单飞：面板连点也只拉起一次', async () => {
    const f = fixture({ reachable: false })
    const [a, b] = await Promise.all([f.browser.ensure(), f.browser.ensure()])
    assert.equal(a.running, true)
    assert.equal(b.running, true)
    assert.equal(f.launches.length, 1)
  })

  it('用户手动关掉窗口：状态如实变未运行，下次 ensure 重新拉起', async () => {
    const f = fixture({ reachable: false })
    await f.browser.ensure()
    f.killPort()

    const status = await f.browser.status()
    assert.equal(status.running, false)
    assert.equal(status.owned, false, '死掉的句柄不能再被当成「我们起的」')

    const again = await f.browser.ensure()
    assert.equal(again.running, true)
    assert.equal(f.launches.length, 2)
  })

  it('stop 关掉自己拉起的实例，并且之后 ensure 明确报错', async () => {
    const f = fixture({ reachable: false })
    await f.browser.ensure()
    await f.browser.stop()
    assert.equal(f.closes(), 1)

    await assert.rejects(f.browser.ensure(), (error: unknown): boolean => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'INTERNAL')
      assert.match(error.message, /已关闭/)
      return true
    })
  })

  it('拉起失败原样抛出，且不会被记住成「已运行」；端口恢复后仍可继续用', async () => {
    const failure = new XianyuError({ code: 'UNSUPPORTED', message: '找不到 Chrome/Edge' })
    let alive = false
    let launches = 0
    const browser = createManagedBrowser({
      port: PORT,
      profileDir: PROFILE,
      probe: async (): Promise<boolean> => alive,
      launch: async (): Promise<BrowserHandle> => {
        launches += 1
        throw failure
      },
    })
    await assert.rejects(browser.ensure(), (error: unknown): boolean => error === failure)
    assert.equal((await browser.status()).running, false)

    // 修好之后（端口上出现了浏览器）仍可继续用：失败不该把实例锁死。
    alive = true
    assert.equal((await browser.ensure()).running, true)
    assert.equal(launches, 1)
  })

  it('status 只探测不启动；未启动时 running:false', async () => {
    const f = fixture({ reachable: false })
    const status = await f.browser.status()
    assert.equal(status.running, false)
    assert.equal(status.owned, false)
    assert.equal(f.launches.length, 0)
  })

  it('端口非法直接 VALIDATION；默认端口与 channel-cdp 对齐 9222', () => {
    assert.equal(DEFAULT_MANAGED_BROWSER_PORT, 9222)
    for (const port of [0, 65_536, 1.5]) {
      assert.throws(
        () => createManagedBrowser({ port, profileDir: PROFILE }),
        (error: unknown): boolean => error instanceof XianyuError && error.code === 'VALIDATION',
      )
    }
    assert.throws(
      () => createManagedBrowser({ port: PORT, profileDir: ' ' }),
      (error: unknown): boolean => error instanceof XianyuError && error.code === 'VALIDATION',
    )
  })
})
