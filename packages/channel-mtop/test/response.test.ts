import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XianyuError } from '@bigfish/core'
import { parseMtopResponse, parseSetCookie } from '../src/index.ts'
import { RET_FIXTURES, SUCCESS_BODY, SUCCESS_REDIRECT_BODY } from './fixtures/mtop-responses.ts'

const API = 'mtop.taobao.idle.pc.detail'

function expectCode(code: string, raw: unknown): void {
  assert.throws(
    () => parseMtopResponse(API, raw),
    (error: unknown) => {
      assert.ok(error instanceof XianyuError, '应抛 XianyuError')
      assert.equal(error.code, code)
      return true
    },
  )
}

test('parseSetCookie：只留 name=value，属性全剥掉', () => {
  const cookies = parseSetCookie([
    '_m_h5_tk=abc_1700000000000; Domain=.goofish.com; Path=/; HttpOnly; Secure',
    'cookie2=xyz; Path=/; SameSite=None',
  ])
  assert.deepEqual(cookies, { _m_h5_tk: 'abc_1700000000000', cookie2: 'xyz' })
})

test('parseSetCookie：同名后者覆盖、值里允许 "="、无等号的头忽略', () => {
  const cookies = parseSetCookie([
    'unb=old; Path=/',
    'bogus-header-without-value',
    'unb=new; Domain=.goofish.com',
    'token=a=b=c; Path=/',
  ])
  assert.deepEqual(cookies, { unb: 'new', token: 'a=b=c' })
})

test('parseSetCookie：空数组返回空表', () => {
  assert.deepEqual(parseSetCookie([]), {})
})

test('parseMtopResponse：成功返回 data；无 data 字段返回整个响应体', () => {
  assert.deepEqual(parseMtopResponse(API, SUCCESS_BODY), { itemId: '1001', price: 9900 })
  assert.deepEqual(parseMtopResponse(API, SUCCESS_REDIRECT_BODY), { ok: true })
  const noData = { ret: ['SUCCESS::调用成功'], traceId: 't-1' }
  assert.deepEqual(parseMtopResponse(API, noData), noData)
})

test('parseMtopResponse：ret 原文按 fixture 映射到稳定 ErrorCode', () => {
  for (const fixture of RET_FIXTURES) {
    expectCode(fixture.code, { ret: fixture.ret })
  }
})

test('parseMtopResponse：未知 ret 的 message 保留平台原文', () => {
  const unknown = RET_FIXTURES.find((fixture) => fixture.code === 'UNKNOWN')
  assert.ok(unknown !== undefined)
  const original = unknown.ret.join(' ')
  assert.throws(
    () => parseMtopResponse(API, { ret: unknown.ret }),
    (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'UNKNOWN')
      assert.ok(error.message.includes(unknown.ret[0] ?? original))
      return true
    },
  )
})

test('parseMtopResponse：接受 JSON 文本，解析失败抛 NETWORK', () => {
  assert.deepEqual(parseMtopResponse(API, JSON.stringify(SUCCESS_BODY)), { itemId: '1001', price: 9900 })
  expectCode('NETWORK', '{not json')
})

test('parseMtopResponse：非对象响应抛 UNKNOWN', () => {
  expectCode('UNKNOWN', null)
  expectCode('UNKNOWN', '[]' as unknown)
  expectCode('UNKNOWN', 42)
})

test('parseMtopResponse：api 为空或非字符串抛 VALIDATION', () => {
  const badApis: readonly unknown[] = ['', 42, null, undefined]
  for (const api of badApis) {
    assert.throws(
      () => parseMtopResponse(api as string, SUCCESS_BODY),
      (error: unknown) => {
        assert.ok(error instanceof XianyuError)
        assert.equal(error.code, 'VALIDATION')
        return true
      },
      'api=' + String(api),
    )
  }
})