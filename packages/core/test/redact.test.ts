import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REDACTED, SENSITIVE_KEYS, TRUNCATED, isSensitiveKey, redact, redactString } from '../src/redact.ts'

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  return value as Record<string, unknown>
}

test('SENSITIVE_KEYS 覆盖凭据与登录态字段', () => {
  for (const key of ['cookie', 'authorization', 'token', 'tfstk', '_m_h5_tk', '_m_h5_tk_enc', 'x5sec', 'x5secdata', 'password', 'secret', 'apikey', 'accesstoken']) {
    assert.ok(SENSITIVE_KEYS.has(key), key + ' 应在 SENSITIVE_KEYS 中')
  }
})

test('isSensitiveKey 大小写不敏感并识别派生字段', () => {
  assert.equal(isSensitiveKey('Cookie'), true)
  assert.equal(isSensitiveKey('AUTHORIZATION'), true)
  assert.equal(isSensitiveKey('refreshToken'), true)
  assert.equal(isSensitiveKey('clientSecret'), true)
  assert.equal(isSensitiveKey('userName'), false)
  assert.equal(isSensitiveKey('accountId'), false)
})

test('redactString 掩掉 Cookie 与 Authorization 头值', () => {
  const input = 'Cookie: _m_h5_tk=abc123; tfstk=deadbeef\nAuthorization: Bearer tok-987654'
  const out = redactString(input)
  assert.ok(!out.includes('abc123'))
  assert.ok(!out.includes('deadbeef'))
  assert.ok(!out.includes('tok-987654'))
  assert.ok(out.includes(REDACTED))
})

test('redactString 掩掉 sk- 密钥与长随机串', () => {
  assert.ok(!redactString('key=sk-ABCDEFGH12345678').includes('sk-ABCDEFGH12345678'))
  const hex = 'a1b2c3d4e5f6a7b8c9d0e1f2'
  assert.equal(hex.length, 24)
  assert.ok(!redactString('id ' + hex + ' end').includes(hex))
  const short = 'a1b2c3d4e5f6a7b8c9d0e1f'
  assert.equal(short.length, 23)
  assert.ok(redactString('id ' + short).includes(short))
})

test('redact 对敏感 key 换占位、对字符串值脱敏且不改入参', () => {
  const input: Record<string, unknown> = {
    accountId: 'acc-1',
    cookie: 'raw-cookie-value',
    token: 'raw-token-value',
    nested: { password: 'raw-password', note: 'Cookie: _m_h5_tk=secretvalue' },
    list: [{ secret: 'raw-secret' }],
  }
  const out = asRecord(redact(input))
  assert.notEqual(out, input)
  assert.equal(out['accountId'], 'acc-1')
  assert.equal(out['cookie'], REDACTED)
  assert.equal(out['token'], REDACTED)
  const nested = asRecord(out['nested'])
  assert.equal(nested['password'], REDACTED)
  assert.ok(!String(nested['note']).includes('secretvalue'))
  const list = out['list']
  assert.ok(Array.isArray(list))
  assert.equal(asRecord(list[0])['secret'], REDACTED)
  assert.equal(input['cookie'], 'raw-cookie-value')
  assert.equal(input['token'], 'raw-token-value')
})

test('redact 处理循环引用不抛错并截断', () => {
  const cyclic: Record<string, unknown> = { name: 'x' }
  cyclic['self'] = cyclic
  const out = asRecord(redact(cyclic))
  assert.equal(out['name'], 'x')
  assert.equal(out['self'], TRUNCATED)
})

test('redact 超出深度返回 truncated', () => {
  let node: unknown = 'leaf'
  for (let i = 0; i < 8; i += 1) node = { next: node }
  const shallow = JSON.stringify(redact(node, 1))
  assert.ok(shallow.includes(TRUNCATED))
  assert.ok(!shallow.includes('leaf'))
})

test('redact 特殊值：Date 转 ISO、Error 取消息、函数截断', () => {
  const out = asRecord(redact({ at: new Date(0), err: new Error('boom'), fn: () => 1 }))
  assert.equal(out['at'], '1970-01-01T00:00:00.000Z')
  const err = asRecord(out['err'])
  assert.equal(err['message'], 'boom')
  assert.equal(out['fn'], TRUNCATED)
})
test('redactString 保留结构 id（UUID）不被长串规则误掩', () => {
  const taskId = '9f1c2b3a-4d5e-4f60-8a1b-2c3d4e5f6a7b'
  const out = redactString('任务不存在：' + taskId)
  assert.ok(out.includes(taskId), 'UUID 必须原样保留，否则客户端拿不到可回查的 id')
  assert.ok(!out.includes(REDACTED))
})

test('redact 保留对象里的 UUID，同时仍然掩掉真正的长随机串', () => {
  const id = '00000000-1111-4222-8333-444444444444'
  const secret = 'AbCdEf0123456789AbCdEf0123456789'
  const out = redact({ taskId: id, note: secret }) as { taskId: string; note: string }
  assert.equal(out.taskId, id)
  assert.equal(out.note, REDACTED)
})
