import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyMtopRet } from '../src/risk.ts'

const ok = (raw: unknown) => {
  const result = classifyMtopRet('mtop.test', raw)
  assert.equal(result.ok, true)
}

test('ret 为空或含 SUCCESS 判定成功', () => {
  ok({})
  ok({ ret: [] })
  ok({ ret: ['SUCCESS::调用成功', 'SUCCESS::redirect'] })
})

test('风控关键词 → RISK_CONTROL', () => {
  for (const ret of ['RGV587_ERROR::失败', 'FAIL_SYS_USER_VALIDATE::需要验证', '哎哟喂，被挤爆啦', 'https://h5.m.taobao.com/punish?x5secdata=1']) {
    const result = classifyMtopRet('mtop.search', { ret: [ret] })
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.equal(result.code, 'RISK_CONTROL')
    assert.ok(result.message.includes('mtop.search'))
  }
})

test('登录态关键词 → AUTH_EXPIRED，TOKEN_EXOIRED 拼写照平台原文', () => {
  for (const ret of ['FAIL_SYS_SESSION_EXPIRED::Session过期', 'FAIL_SYS_TOKEN_EXOIRED::令牌过期', 'FAIL_SYS_TOKEN_EMPTY::令牌为空', '令牌过期']) {
    const result = classifyMtopRet('mtop.detail', { ret: [ret] })
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.equal(result.code, 'AUTH_EXPIRED')
  }
})

test('FAIL_SYS_ILLEGAL_ACCESS 归 AUTH_EXPIRED 且标注不可自动恢复', () => {
  const result = classifyMtopRet('mtop.detail', { ret: ['FAIL_SYS_ILLEGAL_ACCESS::非法访问'] })
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.code, 'AUTH_EXPIRED')
  assert.ok(result.message.includes('不可自动恢复'))
})

test('签名/请求非法 → VALIDATION', () => {
  // FAIL_SYS_API_SIGN_ERROR 的下划线挡住过词边界（\bsign\b 命不中），必须整串命中。
  for (const ret of ['FAIL_SYS_ILLEGAL_REQUEST::非法请求', 'SIGN_CHECK_FAILED::sign error', 'FAIL_SYS_API_SIGN_ERROR::签名错误']) {
    const result = classifyMtopRet('mtop.detail', { ret })
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.equal(result.code, 'VALIDATION')
  }
})

test('未找到 → VALIDATION；未知 ret → UNKNOWN 且保留原文', () => {
  const notFound = classifyMtopRet('mtop.detail', { ret: ['FAIL_SYS_ITEM_NOT_FOUND::不存在'] })
  assert.equal(notFound.ok, false)
  if (notFound.ok) throw new Error('unreachable')
  assert.equal(notFound.code, 'VALIDATION')

  const unknown = classifyMtopRet('mtop.detail', { ret: ['WEIRD_CODE::奇怪错误'] })
  assert.equal(unknown.ok, false)
  if (unknown.ok) throw new Error('unreachable')
  assert.equal(unknown.code, 'UNKNOWN')
  assert.ok(unknown.message.includes('WEIRD_CODE::奇怪错误'))
})

test('ret 为字符串也能分类', () => {
  const result = classifyMtopRet('mtop.detail', { ret: 'RGV587_ERROR::X' })
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.code, 'RISK_CONTROL')
})
