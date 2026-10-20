import test from 'node:test'
import assert from 'node:assert/strict'
import { GuanJiaClient } from '../src/client.ts'
import { assertCredentials, canonicalJson, computeSign, md5Hex, signRequest } from '../src/sign.ts'
import {
  TEST_CREDENTIALS,
  TEST_NOW,
  captureError,
  createFakeTransport
} from './helpers.ts'

// 文档示例向量：research/repos/xian-guanjia/references/api-docs.md:71-99
// 注意文档正文写 mch_id = 100，签名串用的是 1001（文档自相矛盾）；这里以签名串为准。
const DOC_CREDENTIALS = {
  appId: '677859093659717',
  appSecret: 'wK63PxlOBaY9NoqMksLeZySzGIW25ifA',
  mchId: '1001',
  mchSecret: 'o9wl81dncmvby3ijpq7eur456zhgtaxs'
}
const DOC_BODY = { goods_type: 1, goods_no: '12344532' }
const DOC_TIMESTAMP = 1724414553
const DOC_BODY_MD5 = '9b8030f5097d5ed123405b003dd247c5'
const DOC_SIGN = 'fda5954f48ab32b3b271c84450440ead'

test('md5Hex 与 canonicalJson 基础行为', () => {
  assert.equal(md5Hex('{}'), '99914b932bd37a50b983c5e7c90ae93b')
  assert.equal(canonicalJson(undefined), '{}')
  assert.equal(canonicalJson(null), '{}')
  assert.equal(canonicalJson({}), '{}')
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"b":2,"a":1}')
  assert.equal(canonicalJson({ goods_type: 1, goods_no: '12344532' }), '{"goods_type":1,"goods_no":"12344532"}')
})

test('文档示例：body 的 md5 与最终签名逐字节一致', () => {
  assert.equal(md5Hex(canonicalJson(DOC_BODY)), DOC_BODY_MD5)
  assert.equal(computeSign(DOC_CREDENTIALS, canonicalJson(DOC_BODY), DOC_TIMESTAMP), DOC_SIGN)
})

test('client.sign 在注入时钟下复现文档签名与四个鉴权头', () => {
  const fake = createFakeTransport(() => assert.fail('sign() 不应发起请求'))
  const client = new GuanJiaClient({
    credentials: DOC_CREDENTIALS,
    transport: fake.transport,
    now: () => DOC_TIMESTAMP * 1000
  })
  const signed = client.sign(DOC_BODY)
  assert.equal(fake.requests.length, 0)
  assert.equal(signed.timestamp, DOC_TIMESTAMP)
  assert.equal(signed.sign, DOC_SIGN)
  assert.deepEqual(signed.headers, {
    'Content-Type': 'application/json',
    'X-App-Id': DOC_CREDENTIALS.appId,
    'X-Mch-Id': DOC_CREDENTIALS.mchId,
    'X-Timestamp': String(DOC_TIMESTAMP),
    'X-Sign': DOC_SIGN
  })
})

test('空请求体按 "{}" 参与签名（含字面量向量）', () => {
  const fake = createFakeTransport(() => assert.fail('sign() 不应发起请求'))
  const client = new GuanJiaClient({
    credentials: TEST_CREDENTIALS,
    transport: fake.transport,
    now: () => TEST_NOW
  })
  assert.equal(client.sign(undefined).sign, 'c186f484ae1fb122bf331f355d77e2b4')
  assert.equal(client.sign(undefined).sign, computeSign(TEST_CREDENTIALS, '{}', 1724414553))
  assert.equal(client.sign({}).sign, client.sign(undefined).sign)
})

test('now 返回毫秒，timestamp 向下取整为秒', () => {
  const fake = createFakeTransport(() => assert.fail('sign() 不应发起请求'))
  const client = new GuanJiaClient({
    credentials: TEST_CREDENTIALS,
    transport: fake.transport,
    now: () => 1724414553999
  })
  assert.equal(client.sign({}).timestamp, 1724414553)
})

test('凭据缺失时抛 VALIDATION，且报错不回显密钥值', () => {
  const error = captureError(() =>
    assertCredentials({ appId: 'a', appSecret: '', mchId: '1', mchSecret: 'secret-value' })
  )
  assert.equal(error.code, 'VALIDATION')
  assert.match(error.message, /appSecret/)
  assert.ok(!error.message.includes('secret-value'))
})

test('凭据校验不通过时构造函数同步抛错', () => {
  const fake = createFakeTransport(() => assert.fail('不应发起请求'))
  const error = captureError(
    () =>
      new GuanJiaClient({
        credentials: { appId: 'a', appSecret: 'b', mchId: 'c', mchSecret: '' },
        transport: fake.transport
      })
  )
  assert.equal(error.code, 'VALIDATION')
})

test('时间源返回非法值抛 INTERNAL', () => {
  const fake = createFakeTransport(() => assert.fail('不应发起请求'))
  const client = new GuanJiaClient({
    credentials: TEST_CREDENTIALS,
    transport: fake.transport,
    now: () => Number.NaN
  })
  assert.equal(captureError(() => client.sign({})).code, 'INTERNAL')
})

test('signRequest 与 head 组合可直接复用', () => {
  const signed = signRequest(TEST_CREDENTIALS, '{}', 1724414553)
  assert.equal(signed.sign, 'c186f484ae1fb122bf331f355d77e2b4')
  assert.equal(signed.headers['X-Timestamp'], '1724414553')
})
