/**
 * POST /accounts/:id/verify：登录态校验接口的测试。
 *
 * 为什么同时测纯函数、集成链路和路由表：
 * - 纯函数层：错误 → {code,message} 的映射与 secret 脱敏，脱离网络才好覆盖边界；
 * - 集成层：令牌刷新回写、HTTP 映射（200 还是 400/500）只有拼起 runtime + 假 transport 才成立；
 * - 路由层：正则必须吃下 /verify 且不误伤 /accounts/login。
 * 全程不连真实闲鱼：mtop transport 是假的，cookie 是假字符串。
 * @module @bigfish/daemon/test/account-verify
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { XianyuError, loadDaemonConfig } from '@bigfish/core'
import type { DaemonConfig } from '@bigfish/core'
import type { MtopHttpRequest, MtopHttpResponse, MtopTransport } from '@bigfish/channel-mtop'

import { buildAccountSessionState, classifyVerifyError } from '../src/account-verify.ts'
import type { AccountSessionState, AccountVerifyCode } from '../src/account-verify.ts'
import { matchRoute } from '../src/routes.ts'
import { startDaemonRuntime } from '../src/runtime.ts'
import type { DaemonRuntime } from '../src/runtime.ts'
import { asRecord, createHarness, dataOf, errorOf } from './harness.ts'
import type { RawResponse } from './harness.ts'

const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-verify/', import.meta.url))

/** 测试注入的固定时钟：checkedAt 必须等于它，否则说明 runtime 偷用了 Date.now。 */
const FIXED_NOW = 1_700_000_123_456

/** 假 mtop 传输记录的一次调用；cookie 是拼好的请求头，用来断言「有没有用刷新后的令牌」。 */
interface TransportCall {
  api: string
  cookie: string
}

interface RuntimeFixture {
  readonly runtime: DaemonRuntime
  /** 调校验接口；token 缺省读 daemon 写下的 token 文件，null 表示不带鉴权头。 */
  verify(accountId: string, token?: string | null): Promise<RawResponse>
}

interface MtopResponseOptions {
  data?: unknown
  setCookie?: readonly string[]
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 从 mtop URL（.../h5/<api>/<version>/?...）里取 api，断言「调的是不是 head 接口」。 */
function apiOf(url: string): string {
  return url.slice(url.indexOf('/h5/') + 4, url.lastIndexOf('/1.0'))
}

/** 造一个 mtop 信封响应；ret 决定成功/失败分类。 */
function mtopResponse(api: string, ret: readonly string[], options: MtopResponseOptions = {}): MtopHttpResponse {
  const text = JSON.stringify({
    api,
    v: '1.0',
    ret: [...ret],
    ...(options.data === undefined ? {} : { data: options.data }),
  })
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    text,
    ...(options.setCookie === undefined ? {} : { setCookie: options.setCookie }),
  }
}

/** 假 transport：按调用序号返回不同响应，并记录每次请求。 */
function createFakeTransport(
  handler: (call: TransportCall, index: number) => MtopHttpResponse,
): MtopTransport & { calls: TransportCall[] } {
  const calls: TransportCall[] = []
  const transport: MtopTransport = {
    async request(request: MtopHttpRequest): Promise<MtopHttpResponse> {
      const call: TransportCall = { api: apiOf(request.url), cookie: request.headers['cookie'] ?? '' }
      calls.push(call)
      return handler(call, calls.length - 1)
    },
  }
  return Object.assign(transport, { calls })
}

/** 起一套真 HTTP 的 runtime（真 SQLite + 假通道）；t.after 负责关服务并删目录。 */
async function createRuntime(
  t: { after(fn: () => Promise<void>): void },
  transport: MtopTransport,
): Promise<RuntimeFixture> {
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
    transport,
    now: () => FIXED_NOW,
    autoStartWorker: false,
  })
  const authToken = (await readFile(config.tokenPath, 'utf8')).trim()
  const verify = async (accountId: string, token: string | null = authToken): Promise<RawResponse> => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (token !== null) headers['authorization'] = 'Bearer ' + token
    const response = await fetch(
      runtime.daemon.url + '/accounts/' + encodeURIComponent(accountId) + '/verify',
      { method: 'POST', headers },
    )
    const text = await response.text()
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', text, body: parseJson(text) }
  }
  t.after(async (): Promise<void> => {
    await runtime.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { runtime, verify }
}

const VERIFY_CODES: readonly AccountVerifyCode[] = ['AUTH_EXPIRED', 'RISK_CONTROL', 'RATE_LIMITED', 'NETWORK', 'VALIDATION', 'INTERNAL']

/** code 来自 JSON（unknown），窄化到 AccountVerifyCode 才能塞回 AccountSessionState。 */
function isVerifyCode(value: unknown): value is AccountVerifyCode {
  return typeof value === 'string' && (VERIFY_CODES as readonly string[]).includes(value)
}

/** 从 200 响应里窄化出 AccountSessionState；形状不对直接 fail，避免断言报错难读。 */
function sessionStateOf(response: RawResponse): AccountSessionState {
  const data = asRecord(dataOf(response))
  const accountId = data['accountId']
  const online = data['online']
  const checkedAt = data['checkedAt']
  const refreshed = data['refreshed']
  const code = data['code']
  const message = data['message']
  if (typeof accountId !== 'string' || typeof online !== 'boolean' || typeof checkedAt !== 'number' || typeof refreshed !== 'boolean') {
    assert.fail('AccountSessionState 形状非法：' + JSON.stringify(data))
  }
  return {
    accountId,
    online,
    checkedAt,
    refreshed,
    ...(isVerifyCode(code) ? { code } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  }
}

/** 命中路由，否则 fail（断言里直接用于后续取 params/route）。 */
function matchOrFail(method: string, path: string): { route: { method: string; pattern: RegExp }; params: string[] } {
  const matched = matchRoute(method, path)
  if (matched === undefined || 'methodNotAllowed' in matched) assert.fail('未命中路由：' + method + ' ' + path)
  return matched
}

describe('classifyVerifyError', () => {
  it('AUTH_EXPIRED / RISK_CONTROL / NETWORK 映射为固定中文短句', () => {
    const auth = classifyVerifyError(new XianyuError({ code: 'AUTH_EXPIRED', message: '登录态失效' }))
    assert.equal(auth.code, 'AUTH_EXPIRED')
    assert.match(auth.message, /登录态已失效/)
    const risk = classifyVerifyError(new XianyuError({ code: 'RISK_CONTROL', message: 'RGV587_ERROR' }))
    assert.equal(risk.code, 'RISK_CONTROL')
    assert.match(risk.message, /风控/)
    const network = classifyVerifyError(new XianyuError({ code: 'NETWORK', message: 'socket hang up' }))
    assert.equal(network.code, 'NETWORK')
    assert.match(network.message, /网络/)
  })

  it('VALIDATION 保留本仓库自写文案（缺 unb 的提示要能指导修复）', () => {
    const failure = classifyVerifyError(new XianyuError({ code: 'VALIDATION', message: '凭据里没有 unb，无法校验登录态' }))
    assert.deepEqual(failure, { code: 'VALIDATION', message: '凭据里没有 unb，无法校验登录态' })
  })

  it('文案里出现 cookie/令牌线索时退回固定短句', () => {
    const failure = classifyVerifyError(new XianyuError({ code: 'VALIDATION', message: 'cookie _m_h5_tk=abc 失效' }))
    assert.equal(failure.code, 'VALIDATION')
    assert.equal(failure.message, '登录态校验请求不合法')
  })

  it('非 XianyuError 与未登记错误码归 INTERNAL', () => {
    assert.equal(classifyVerifyError(new Error('boom')).code, 'INTERNAL')
    assert.equal(classifyVerifyError(new XianyuError({ code: 'STORAGE', message: '凭据写盘失败' })).code, 'INTERNAL')
  })

  it('buildAccountSessionState 由 failure 推导 online', () => {
    assert.deepEqual(buildAccountSessionState({ accountId: 'a', checkedAt: 1, refreshed: true }), {
      accountId: 'a', online: true, checkedAt: 1, refreshed: true,
    })
    assert.deepEqual(
      buildAccountSessionState({
        accountId: 'a', checkedAt: 2, refreshed: false,
        failure: { code: 'NETWORK', message: '网络请求失败，请检查网络后重试' },
      }),
      { accountId: 'a', online: false, checkedAt: 2, refreshed: false, code: 'NETWORK', message: '网络请求失败，请检查网络后重试' },
    )
  })
})

describe('POST /accounts/:id/verify', () => {
  it('登录态有效：200 + online:true + checkedAt 取注入时钟', async (t) => {
    const transport = createFakeTransport(call => mtopResponse(call.api, ['SUCCESS::调用成功'], { data: { self: false } }))
    const { runtime, verify } = await createRuntime(t, transport)
    await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'token_abc', unb: 'unb-1' } })

    const state = sessionStateOf(await verify('acc-1'))
    assert.deepEqual(state, { accountId: 'acc-1', online: true, checkedAt: FIXED_NOW, refreshed: false })
    assert.equal(transport.calls.length, 1)
    assert.equal(transport.calls[0]?.api, 'mtop.idle.web.user.page.head')
    assert.match(transport.calls[0]?.cookie ?? '', /unb=unb-1/)
  })

  it('AUTH_EXPIRED：200 + online:false + 登录态失效文案', async (t) => {
    const transport = createFakeTransport(call => mtopResponse(call.api, ['FAIL_SYS_SESSION_EXPIRED::登录态失效']))
    const { runtime, verify } = await createRuntime(t, transport)
    await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'token_abc', unb: 'unb-1' } })

    const state = sessionStateOf(await verify('acc-1'))
    assert.equal(state.online, false)
    assert.equal(state.code, 'AUTH_EXPIRED')
    assert.match(state.message ?? '', /登录态已失效/)
    // 脱敏：message 里绝不能出现凭据值。
    assert.doesNotMatch(state.message ?? '', /token_abc|unb-1/)
  })

  it('RISK_CONTROL：200 + online:false + 风控文案', async (t) => {
    const transport = createFakeTransport(call => mtopResponse(call.api, ['RGV587_ERROR::小助理'],
      { data: { url: 'https://www.goofish.com/punish' } }))
    const { runtime, verify } = await createRuntime(t, transport)
    await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'token_abc', unb: 'unb-1' } })

    const state = sessionStateOf(await verify('acc-1'))
    assert.equal(state.online, false)
    assert.equal(state.code, 'RISK_CONTROL')
    assert.match(state.message ?? '', /风控/)
  })

  it('NETWORK：transport 抛错也返回 200 + online:false，不冒成 500', async (t) => {
    const transport = createFakeTransport(() => {
      throw new Error('socket hang up')
    })
    const { runtime, verify } = await createRuntime(t, transport)
    await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'token_abc', unb: 'unb-1' } })

    const response = await verify('acc-1')
    assert.equal(response.status, 200)
    const state = sessionStateOf(response)
    assert.equal(state.online, false)
    assert.equal(state.code, 'NETWORK')
    assert.match(state.message ?? '', /网络/)
  })

  it('令牌过期自动刷新：refreshed:true 且合并后的 cookies 写回凭据库', async (t) => {
    const transport = createFakeTransport((call, index) => index === 0
      ? mtopResponse(call.api, ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'], {
        setCookie: ['_m_h5_tk=tok2_222; Path=/', '_m_h5_tk_enc=enc2; Path=/'],
      })
      : mtopResponse(call.api, ['SUCCESS::调用成功'], { data: { self: false } }))
    const { runtime, verify } = await createRuntime(t, transport)
    await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'tok1_111', unb: 'unb-1', cookie2: 'keep' } })

    const state = sessionStateOf(await verify('acc-1'))
    assert.equal(state.online, true)
    assert.equal(state.refreshed, true)
    // 刷新必须真的生效：第一次用旧令牌签名，重试必须用新令牌。
    assert.equal(transport.calls.length, 2)
    assert.match(transport.calls[0]?.cookie ?? '', /_m_h5_tk=tok1_111/)
    assert.match(transport.calls[1]?.cookie ?? '', /_m_h5_tk=tok2_222/)

    const saved = await runtime.credentials.load('acc-1')
    assert.ok(saved !== undefined)
    assert.equal(saved.cookies['_m_h5_tk'], 'tok2_222')
    assert.equal(saved.cookies['_m_h5_tk_enc'], 'enc2')
    assert.equal(saved.cookies['unb'], 'unb-1')
    assert.equal(saved.cookies['cookie2'], 'keep')
  })

  it('凭据缺 unb：200 + online:false + VALIDATION，且不打平台', async (t) => {
    const transport = createFakeTransport(call => mtopResponse(call.api, ['SUCCESS::调用成功']))
    const { runtime, verify } = await createRuntime(t, transport)
    await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'token_abc' } })

    const response = await verify('acc-1')
    assert.equal(response.status, 200)
    assert.equal(transport.calls.length, 0)
    assert.deepEqual(sessionStateOf(response), {
      accountId: 'acc-1',
      online: false,
      checkedAt: FIXED_NOW,
      refreshed: false,
      code: 'VALIDATION',
      message: '凭据里没有 unb，无法校验登录态',
    })
  })

  it('账号不存在：400 + VALIDATION（沿用现有 http 错误映射，不自造 404）', async (t) => {
    const transport = createFakeTransport(call => mtopResponse(call.api, ['SUCCESS::调用成功']))
    const { verify } = await createRuntime(t, transport)

    const response = await verify('missing')
    assert.equal(response.status, 400)
    const error = errorOf(response)
    assert.equal(error.code, 'VALIDATION')
    assert.equal(error.message, '账号不存在：missing')
  })

  it('缺少 Bearer token：401 UNAUTHORIZED', async (t) => {
    const transport = createFakeTransport(call => mtopResponse(call.api, ['SUCCESS::调用成功']))
    const { verify } = await createRuntime(t, transport)

    const response = await verify('acc-1', null)
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })
})

describe('未注入 verifyAccount 能力', () => {
  it('POST /accounts/acc-1/verify → 500 UNSUPPORTED（不假装成功）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/acc-1/verify' })
    assert.equal(response.status, 500)
    const error = errorOf(response)
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /未注入登录态校验能力/)
  })

  it('注入后原样返回 handler 的结果', async (t) => {
    const harness = await createHarness(t, {
      verifyAccount: async ({ accountId }) => ({ accountId, online: true, checkedAt: 7, refreshed: false }),
    })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/acc-1/verify' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { accountId: 'acc-1', online: true, checkedAt: 7, refreshed: false })
  })
})

describe('verify 路由匹配', () => {
  it('POST /accounts/:id/verify 命中并解码参数', () => {
    const matched = matchOrFail('POST', '/accounts/acc%2F1/verify')
    assert.equal(matched.route.method, 'POST')
    assert.deepEqual(matched.params, ['acc/1'])
  })

  it('尾斜杠也命中', () => {
    assert.deepEqual(matchOrFail('POST', '/accounts/acc-1/verify/').params, ['acc-1'])
  })

  it('/accounts/login 仍走登录路由，不被 verify 正则抢走', () => {
    const matched = matchOrFail('POST', '/accounts/login')
    assert.match(matched.route.pattern.source, /login/)
    assert.deepEqual(matched.params, [])
  })

  it('GET 同路径 → methodNotAllowed（405 而非 404）', () => {
    assert.deepEqual(matchRoute('GET', '/accounts/acc-1/verify'), { methodNotAllowed: true })
  })

  it('多余路径段不命中', () => {
    assert.equal(matchRoute('POST', '/accounts/acc-1/verify/extra'), undefined)
  })
})
