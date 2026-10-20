import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { XianyuError } from '@bigfish/core'
import { APP_KEY, h5Token, signMtop } from '../src/index.ts'

const T_MS = 1_700_000_000_000
const DATA = '{"a":1}'
/** md5('abc&1700000000000&34839810&{"a":1}')，独立算好后固化，防止实现漂移。 */
const VECTOR = '82935b9ade4505038b200b96c23f3f44'

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, code)
    return true
  })
}

test('signMtop：已知向量与 md5 公式一致', () => {
  assert.equal(signMtop('abc', T_MS, DATA), VECTOR)
  const formula = 'abc&' + String(T_MS) + '&' + APP_KEY + '&' + DATA
  assert.equal(createHash('md5').update(formula, 'utf8').digest('hex'), VECTOR)
})

test('signMtop：吃毫秒 t，不是秒级截断再乘 1000', () => {
  // 反面教材：t 先截断到秒会得到另一个签名，平台会判签名错误。
  assert.notEqual(signMtop('abc', T_MS / 1000, DATA), VECTOR)
  // 同一秒内不同毫秒必须得到不同签名，证明 t 的毫秒位参与摘要。
  assert.notEqual(signMtop('abc', T_MS + 1, DATA), VECTOR)
  assert.equal(signMtop('abc', T_MS, DATA), VECTOR)
})

test('h5Token：取 _m_h5_tk 的 "_" 前段', () => {
  assert.equal(h5Token({ _m_h5_tk: 'token123_1700000000000', cookie2: 'x' }), 'token123')
})

test('h5Token：缺失或格式非法抛 AUTH_EXPIRED', () => {
  expectCode('AUTH_EXPIRED', () => h5Token({}))
  expectCode('AUTH_EXPIRED', () => h5Token({ _m_h5_tk: '' }))
  expectCode('AUTH_EXPIRED', () => h5Token({ _m_h5_tk: '_1700000000000' }))
})

test('signMtop：非法入参抛 VALIDATION', () => {
  expectCode('VALIDATION', () => signMtop('', T_MS, DATA))
  expectCode('VALIDATION', () => signMtop('abc', 1.5, DATA))
  expectCode('VALIDATION', () => signMtop('abc', 0, DATA))
  expectCode('VALIDATION', () => signMtop('abc', Number.NaN, DATA))
})
