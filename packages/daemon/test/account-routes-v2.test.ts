/**
 * 账号管理 v2 端口测试：/accounts/activate、/accounts/:id/logout 的路由接线、生命周期逻辑与真实 runtime 集成。
 *
 * 为什么分三层：
 * - 路由层（harness 假 handler）：验证请求体校验、UNSUPPORTED 兜底、正则互不误伤；
 * - 生命周期纯逻辑：切换/退出/自动激活的分支与失败语义；
 * - 集成层（真 runtime + 真加密凭据库）：确认 settings 落盘、凭据真的被删。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SETTINGS, XianyuError, loadDaemonConfig, parseSettingsPatch } from '@bigfish/core'
import type { CredentialRecord, DaemonConfig, Settings } from '@bigfish/core'

import { createAccountLifecycle } from '../src/account-lifecycle.ts'
import type { AccountCredentialSource } from '../src/account-lifecycle.ts'
import { startDaemonRuntime } from '../src/runtime.ts'
import type { DaemonRuntime } from '../src/runtime.ts'
import type { SettingsStore } from '../src/settings.ts'
import { asRecord, createHarness, dataOf, errorOf } from './harness.ts'
import type { RawResponse } from './harness.ts'

const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-account-routes/', import.meta.url))
const FIXED_NOW = 1_700_000_000_000

function assertCode(code: string, message?: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof XianyuError, '期望 XianyuError，实际 ' + String(error))
    assert.equal(error.code, code)
    if (message !== undefined) assert.match(error.message, message)
    return true
  }
}

describe('POST /accounts/activate（路由层）', () => {
  it('注入后原样返回 handler 结果', async (t) => {
    const harness = await createHarness(t, {
      activateAccount: async ({ accountId }) => ({ activeAccountId: accountId }),
    })
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/accounts/activate',
      body: JSON.stringify({ accountId: 'a2' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { activeAccountId: 'a2' })
  })

  it('accountId 是空白串 → 400 VALIDATION「accountId 不能为空」，不调用 handler', async (t) => {
    let called = false
    const harness = await createHarness(t, {
      activateAccount: async () => {
        called = true
        return { activeAccountId: '' }
      },
    })
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/accounts/activate',
      body: JSON.stringify({ accountId: '   ' }),
    })
    assert.equal(response.status, 400)
    assert.equal(errorOf(response).code, 'VALIDATION')
    assert.match(errorOf(response).message, /accountId 不能为空/)
    assert.equal(called, false)
  })

  it('缺 accountId 字段 → 400 VALIDATION', async (t) => {
    const harness = await createHarness(t, { activateAccount: async () => ({ activeAccountId: '' }) })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/activate', body: '{}' })
    assert.equal(response.status, 400)
    assert.equal(errorOf(response).code, 'VALIDATION')
  })

  it('未注入 handler → 500 UNSUPPORTED', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/accounts/activate',
      body: JSON.stringify({ accountId: 'a1' }),
    })
    assert.equal(response.status, 500)
    assert.equal(errorOf(response).code, 'UNSUPPORTED')
    assert.match(errorOf(response).message, /未注入切换账号能力/)
  })

  it('/accounts/activate 不会被 /accounts/:id/verify 抢走', async (t) => {
    const harness = await createHarness(t, {
      verifyAccount: async () => {
        throw new Error('verify 不应被调用')
      },
      activateAccount: async ({ accountId }) => ({ activeAccountId: accountId }),
    })
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/accounts/activate',
      body: JSON.stringify({ accountId: 'a1' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { activeAccountId: 'a1' })
  })

  it('/accounts/login 依旧走登录 handler（带参路由不误伤精确路由）', async (t) => {
    const harness = await createHarness(t, {
      loginAccount: async () => ({ accountId: 'a1', savedFieldCount: 2, updatedAt: 1, source: 'chrome-cdp', elapsedMs: 1 }),
      verifyAccount: async () => {
        throw new Error('verify 不应被调用')
      },
    })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/login', body: '{}' })
    assert.equal(response.status, 200)
    assert.equal(asRecord(dataOf(response))['accountId'], 'a1')
  })
})

describe('POST /accounts/:id/logout（路由层）', () => {
  it('注入后返回 accountId 与 activeAccountId', async (t) => {
    const harness = await createHarness(t, {
      logoutAccount: async ({ accountId }) => ({ accountId, activeAccountId: '' }),
    })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/a1/logout' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { accountId: 'a1', activeAccountId: '' })
  })

  it('未注入 handler → 500 UNSUPPORTED', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/a1/logout' })
    assert.equal(response.status, 500)
    assert.equal(errorOf(response).code, 'UNSUPPORTED')
    assert.match(errorOf(response).message, /未注入退出登录能力/)
  })

  it('GET 同路径 → 405（方法不匹配而不是 404）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'GET', path: '/accounts/a1/logout' })
    assert.equal(response.status, 405)
  })
})

interface LifecycleFixture {
  lifecycle: ReturnType<typeof createAccountLifecycle>
  settings: SettingsStore & { active(): string }
  credentials: AccountCredentialSource & { has(accountId: string): boolean }
  removedState: string[]
}

function fakeSettings(initial: string): SettingsStore & { active(): string } {
  let active = initial
  return {
    async get(): Promise<Settings> {
      return { ...DEFAULT_SETTINGS, activeAccountId: active }
    },
    async update(patch: unknown): Promise<Settings> {
      const parsed = parseSettingsPatch(patch)
      active = parsed.activeAccountId ?? active
      return { ...DEFAULT_SETTINGS, activeAccountId: active }
    },
    active: (): string => active,
  }
}

function fakeCredentials(ids: readonly string[]): AccountCredentialSource & { has(accountId: string): boolean } {
  const map = new Map<string, CredentialRecord>(
    ids.map((id) => [id, { accountId: id, cookies: { unb: id }, updatedAt: 1 }]),
  )
  return {
    async load(accountId: string): Promise<CredentialRecord | undefined> {
      return map.get(accountId)
    },
    async remove(accountId: string): Promise<boolean> {
      return map.delete(accountId)
    },
    has: (accountId: string): boolean => map.has(accountId),
  }
}

function createLifecycleFixture(
  ids: readonly string[],
  active: string,
  options: { stateError?: unknown } = {},
): LifecycleFixture {
  const credentials = fakeCredentials(ids)
  const settings = fakeSettings(active)
  const removedState: string[] = []
  const lifecycle = createAccountLifecycle({
    credentials,
    settings,
    state: {
      async remove(accountId: string): Promise<void> {
        if (options.stateError !== undefined) throw options.stateError
        removedState.push(accountId)
      },
    },
  })
  return { lifecycle, settings, credentials, removedState }
}

describe('createAccountLifecycle', () => {
  it('activate 存在的账号 → 写 settings 并返回新当前账号', async () => {
    const fixture = createLifecycleFixture(['a1', 'a2'], '')
    assert.deepEqual(await fixture.lifecycle.activate('a2'), { activeAccountId: 'a2' })
    assert.equal(fixture.settings.active(), 'a2')
  })

  it('activate 不存在的账号 → VALIDATION（不写设置）', async () => {
    const fixture = createLifecycleFixture(['a1'], 'a1')
    await assert.rejects(async () => fixture.lifecycle.activate('missing'), assertCode('VALIDATION', /账号不存在：missing/))
    assert.equal(fixture.settings.active(), 'a1')
  })

  it('activate 空白 id → VALIDATION「accountId 不能为空」', async () => {
    const fixture = createLifecycleFixture(['a1'], 'a1')
    await assert.rejects(async () => fixture.lifecycle.activate('  '), assertCode('VALIDATION', /accountId 不能为空/))
  })

  it('logout 当前账号 → 删凭据、清状态缓存、清空 activeAccountId', async () => {
    const fixture = createLifecycleFixture(['a1', 'a2'], 'a1')
    assert.deepEqual(await fixture.lifecycle.logout('a1'), { accountId: 'a1', activeAccountId: '' })
    assert.equal(fixture.credentials.has('a1'), false)
    assert.deepEqual(fixture.removedState, ['a1'])
    assert.equal(fixture.settings.active(), '')
  })

  it('logout 非当前账号 → 保留 activeAccountId', async () => {
    const fixture = createLifecycleFixture(['a1', 'a2'], 'a1')
    assert.deepEqual(await fixture.lifecycle.logout('a2'), { accountId: 'a2', activeAccountId: 'a1' })
    assert.equal(fixture.credentials.has('a1'), true)
    assert.equal(fixture.settings.active(), 'a1')
  })

  it('logout 不存在的账号 → VALIDATION「账号不存在」', async () => {
    const fixture = createLifecycleFixture(['a1'], 'a1')
    await assert.rejects(async () => fixture.lifecycle.logout('missing'), assertCode('VALIDATION', /账号不存在：missing/))
  })

  it('状态缓存清理失败只回调 onStateError，凭据删除与返回值不受影响', async () => {
    const credentials = fakeCredentials(['a1'])
    const settings = fakeSettings('a1')
    const errors: unknown[] = []
    const lifecycle = createAccountLifecycle({
      credentials,
      settings,
      state: {
        async remove(): Promise<void> {
          throw new Error('磁盘只读')
        },
      },
      onStateError: (error) => {
        errors.push(error)
      },
    })
    assert.deepEqual(await lifecycle.logout('a1'), { accountId: 'a1', activeAccountId: '' })
    assert.equal(credentials.has('a1'), false)
    assert.equal(errors.length, 1)
  })

  it('activateIfEmpty：没选账号时才自动选中，已有选择不动', async () => {
    const empty = createLifecycleFixture(['a1'], '')
    assert.equal(await empty.lifecycle.activateIfEmpty('a1'), 'a1')
    assert.equal(empty.settings.active(), 'a1')

    const chosen = createLifecycleFixture(['a1', 'a2'], 'a2')
    assert.equal(await chosen.lifecycle.activateIfEmpty('a1'), 'a2')
    assert.equal(chosen.settings.active(), 'a2')
  })
})

interface RuntimeFixture {
  runtime: DaemonRuntime
  request(method: string, path: string, body?: unknown): Promise<RawResponse>
}

async function createRuntime(t: { after(fn: () => Promise<void>): void }): Promise<RuntimeFixture> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'run-'))
  const loaded = loadDaemonConfig({}, {
    dbPath: join(dir, 'bigfish.db'),
    credentialsDir: join(dir, 'credentials'),
    circuitPath: join(dir, 'circuits.json'),
    tokenPath: join(dir, 'daemon.token'),
    pollIntervalMs: 20,
  })
  const config: DaemonConfig = { ...loaded, port: 0 }
  const runtime = await startDaemonRuntime({
    config,
    now: (): number => FIXED_NOW,
    autoStartWorker: false,
    autoStartKeepAlive: false,
  })
  // 必须先关 runtime 再删目录：SQLite 句柄与监听端口会拖住 test-all 的退出。
  t.after(async (): Promise<void> => {
    await runtime.close()
    await rm(dir, { recursive: true, force: true })
  })
  const authToken = (await readFile(config.tokenPath, 'utf8')).trim()
  const request = async (method: string, path: string, body?: unknown): Promise<RawResponse> => {
    const headers: Record<string, string> = { accept: 'application/json', authorization: 'Bearer ' + authToken }
    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const response = await fetch(runtime.daemon.url + path, init)
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', text, body: parsed }
  }
  return { runtime, request }
}

async function saveAccount(runtime: DaemonRuntime, accountId: string): Promise<void> {
  await runtime.credentials.save({
    accountId,
    cookies: { unb: accountId, _m_h5_tk: 'tk-' + accountId },
    meta: { source: 'chrome-cdp' },
  })
}

async function activeAccountIdOf(runtime: DaemonRuntime, request: RuntimeFixture['request']): Promise<string> {
  const settings = asRecord(dataOf(await request('GET', '/settings')))
  return typeof settings['activeAccountId'] === 'string' ? settings['activeAccountId'] : '<missing>'
}

describe('账号管理 v2（真实 runtime 集成）', () => {
  it('activate：200 + settings.activeAccountId 落盘', async (t) => {
    const { runtime, request } = await createRuntime(t)
    await saveAccount(runtime, 'a1')
    await saveAccount(runtime, 'a2')

    const response = await request('POST', '/accounts/activate', { accountId: 'a2' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { activeAccountId: 'a2' })
    assert.equal(await activeAccountIdOf(runtime, request), 'a2')
  })

  it('activate 不存在的账号 → 400 VALIDATION', async (t) => {
    const { request } = await createRuntime(t)
    const response = await request('POST', '/accounts/activate', { accountId: 'missing' })
    assert.equal(response.status, 400)
    assert.equal(errorOf(response).code, 'VALIDATION')
    assert.equal(errorOf(response).message, '账号不存在：missing')
  })

  it('logout 当前账号：删加密凭据 + 清空 activeAccountId', async (t) => {
    const { runtime, request } = await createRuntime(t)
    await saveAccount(runtime, 'a1')
    await saveAccount(runtime, 'a2')
    await request('POST', '/accounts/activate', { accountId: 'a1' })

    const response = await request('POST', '/accounts/a1/logout')
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { accountId: 'a1', activeAccountId: '' })
    assert.equal(await runtime.credentials.load('a1'), undefined)
    assert.notEqual(await runtime.credentials.load('a2'), undefined)
    assert.equal(await activeAccountIdOf(runtime, request), '')
  })

  it('logout 不存在的账号 → 400 VALIDATION', async (t) => {
    const { request } = await createRuntime(t)
    const response = await request('POST', '/accounts/missing/logout')
    assert.equal(response.status, 400)
    assert.equal(errorOf(response).code, 'VALIDATION')
  })
})
