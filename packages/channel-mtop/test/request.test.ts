import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XianyuError } from '@bigfish/core'
import { APP_KEY, MTOP_HOST, buildMtopRequest, signMtop } from '../src/index.ts'
import type { MtopCallOptions } from '../src/index.ts'

const T_MS = 1_700_000_000_123
const API = 'mtop.taobao.idle.pc.detail'
const COMPACT = '{"itemId":"123","page":2}'
const SESSION = { cookies: { _m_h5_tk: 'tok123_1700000000000', cookie2: 'ck2', unb: '1' } }

function options(overrides: Partial<MtopCallOptions> = {}): MtopCallOptions {
  const base: MtopCallOptions = {
    api: API,
    data: { itemId: '123', page: 2 },
    session: SESSION,
    t: T_MS,
  }
  return { ...base, ...overrides }
}

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, code)
    return true
  })
}

test('buildMtopRequest：url、通用参数、紧凑 data、毫秒 t', () => {
  const request = buildMtopRequest(options())
  assert.equal(request.method, 'POST')
  const url = new URL(request.url)
  assert.equal(url.origin + url.pathname, MTOP_HOST + '/h5/' + API + '/1.0/')
  const params = url.searchParams
  // 通用信封参数
  assert.equal(params.get('jsv'), '2.7.2')
  assert.equal(params.get('appKey'), APP_KEY)
  assert.equal(params.get('t'), String(T_MS))
  assert.equal(params.get('v'), '1.0')
  assert.equal(params.get('type'), 'originaljson')
  assert.equal(params.get('dataType'), 'json')
  assert.equal(params.get('accountSite'), 'xianyu')
  assert.equal(params.get('timeout'), '20000')
  assert.equal(params.get('api'), API)
  assert.equal(params.get('sessionOption'), 'AutoLoginOnly')
  assert.equal(params.get('spm_cnt'), 'a21ybx.home.0.0')
  // 签名针对紧凑 JSON，而不是带空格的默认序列化结果
  assert.equal(params.get('sign'), signMtop('tok123', T_MS, COMPACT))
  assert.equal(request.body, 'data=' + encodeURIComponent(COMPACT))
  assert.deepEqual(JSON.parse(decodeURIComponent(request.body.slice('data='.length))), { itemId: '123', page: 2 })
})

test('buildMtopRequest：headers 含 origin/referer/UA/content-type 与 cookie', () => {
  const { headers } = buildMtopRequest(options())
  assert.equal(headers.origin, 'https://www.goofish.com')
  assert.equal(headers.referer, 'https://www.goofish.com/')
  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded')
  assert.ok((headers['user-agent'] ?? '').includes('Mozilla/5.0'))
  assert.equal(headers.cookie, '_m_h5_tk=tok123_1700000000000; cookie2=ck2; unb=1')
})

test('buildMtopRequest：字符串 data 原样参与签名，不二次序列化', () => {
  const raw = '{"raw":true}'
  const request = buildMtopRequest(options({ data: raw }))
  const params = new URL(request.url).searchParams
  assert.equal(params.get('sign'), signMtop('tok123', T_MS, raw))
  assert.equal(request.body, 'data=' + encodeURIComponent(raw))
})

test('buildMtopRequest：version/spmCnt 可覆盖，extraParams 追加并覆盖同名键', () => {
  const request = buildMtopRequest(
    options({ version: '2.0', spmCnt: 'a21ybx.item.0.0', extraParams: { foo: 'bar', spm_cnt: 'override' } }),
  )
  const params = new URL(request.url).searchParams
  assert.equal(params.get('v'), '2.0')
  assert.equal(params.get('spm_cnt'), 'override')
  assert.equal(params.get('foo'), 'bar')
})

test('buildMtopRequest：t 缺省取当前毫秒（不截断到秒）', () => {
  const before = Date.now()
  const request = buildMtopRequest({ api: API, data: {}, session: SESSION })
  const after = Date.now()
  const t = Number(new URL(request.url).searchParams.get('t'))
  assert.ok(Number.isSafeInteger(t))
  assert.ok(t >= before && t <= after, 't 应为当前毫秒，实际 ' + String(t))
})

test('buildMtopRequest：signal 有则透传，无则不带该键', () => {
  const controller = new AbortController()
  const withSignal = buildMtopRequest(options({ signal: controller.signal }))
  assert.equal(withSignal.signal, controller.signal)
  const withoutSignal = buildMtopRequest(options())
  assert.equal('signal' in withoutSignal, false)
})

test('buildMtopRequest：api/t/data/session 非法分别抛 VALIDATION 或 AUTH_EXPIRED', () => {
  expectCode('VALIDATION', () => buildMtopRequest(options({ api: '' })))
  expectCode('VALIDATION', () => buildMtopRequest(options({ api: 'bad api' })))
  expectCode('VALIDATION', () => buildMtopRequest(options({ api: 'x/../y' })))
  expectCode('VALIDATION', () => buildMtopRequest(options({ t: 1.5 })))
  expectCode('VALIDATION', () => buildMtopRequest(options({ t: 0 })))
  expectCode('VALIDATION', () => buildMtopRequest(options({ data: undefined })))
  expectCode('AUTH_EXPIRED', () => buildMtopRequest(options({ session: { cookies: {} } })))
})
