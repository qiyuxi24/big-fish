import test from 'node:test'
import assert from 'node:assert/strict'
import { XianyuError } from '@bigfish/core'
import {
  ACK_DIFF_LWP,
  CONTENT_TYPE_CUSTOM,
  CONVERSATION_TYPE_SINGLE,
  CUSTOM_TEXT_TYPE,
  HEARTBEAT_LWP,
  IM_APP_KEY,
  IM_UA,
  REG_LWP,
  SEND_LWP,
  SEND_TEXT_MAX_LENGTH,
  buildAckDiffFrame,
  buildAckFrame,
  buildHeartbeatFrame,
  buildImTokenRequest,
  buildRegFrame,
  buildSendMessageFrame,
  decodeBase64Json,
  encodeFrame,
  generateDeviceId,
  generateMid,
  parseFrameText,
  readInteger,
  readPath,
  readText,
  toGoofishId,
} from '../src/frames.ts'

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const NOW = 1_700_000_000_123

function expectValidation(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'VALIDATION')
    return true
  })
}

test('generateMid 照抄参考实现格式且接受注入随机数', () => {
  assert.equal(generateMid(NOW, () => 0.5), '500' + String(NOW) + ' 0')
  expectValidation(() => generateMid(1.5))
  expectValidation(() => generateMid(NOW, () => 1))
  expectValidation(() => generateMid(NOW, () => Number.NaN))
})

test('generateDeviceId 是 UUID + "-" + userId，参数非法抛 VALIDATION', () => {
  assert.equal(generateDeviceId('user-1', UUID), UUID + '-user-1')
  expectValidation(() => generateDeviceId('', UUID))
  expectValidation(() => generateDeviceId('user-1', 'not-a-uuid'))
})

test('取 IM token 请求：紧凑 JSON data + mtop 额外参数', () => {
  const request = buildImTokenRequest({ deviceId: 'device-9', smToken: 'h5-token' })
  assert.equal(request.api, 'mtop.taobao.idlemessage.pc.login.token')
  assert.equal(request.version, '1.0')
  assert.equal(request.data.includes(' '), false, 'data 必须是紧凑 JSON，空格会签名不过')
  const data: unknown = JSON.parse(request.data)
  assert.deepEqual(data, { appKey: IM_APP_KEY, deviceId: 'device-9' })
  assert.deepEqual(request.extraParams, {
    sessionOption: 'AutoLoginOnly',
    accountSite: 'xianyu',
    queryToken: 'sm',
    sm: 'sm',
    spm_cnt: 'a21ybx.im.0.0',
    smToken: 'h5-token',
  })
  const withoutToken = buildImTokenRequest({ deviceId: 'device-9' })
  assert.equal(Object.hasOwn(withoutToken.extraParams, 'smToken'), false)
  expectValidation(() => buildImTokenRequest(null))
  expectValidation(() => buildImTokenRequest({}))
  expectValidation(() => buildImTokenRequest({ deviceId: '' }))
})

test('/reg 帧 headers 字段齐全', () => {
  const frame = buildRegFrame({ accessToken: 'access-1', deviceId: 'device-1', mid: 'mid-1' })
  assert.equal(frame.lwp, REG_LWP)
  assert.deepEqual(frame.headers, {
    'cache-header': 'app-key token ua wv',
    'app-key': IM_APP_KEY,
    token: 'access-1',
    ua: IM_UA,
    dt: 'j',
    wv: 'im:3,au:3,sy:6',
    sync: '0,0;0;0;',
    did: 'device-1',
    mid: 'mid-1',
  })
  assert.ok(IM_UA.includes('DingTalk(2.1.5)'))
  assert.ok(IM_UA.includes('DingWeb/2.1.5'))
  const generated = buildRegFrame({ accessToken: 'access-1', deviceId: 'device-1', nowMs: NOW })
  assert.match(readText(readPath(generated, ['headers', 'mid'])) ?? '', /^[0-9]+1700000000123 0$/)
  expectValidation(() => buildRegFrame({ deviceId: 'device-1' }))
  expectValidation(() => buildRegFrame({ accessToken: 'access-1', deviceId: '' }))
  expectValidation(() => buildRegFrame('not-object'))
})

test('ackDiff 帧提交同步游标：pts 是毫秒×1000，timestamp 是秒', () => {
  const frame = buildAckDiffFrame({ nowMs: NOW, mid: 'mid-2' })
  assert.equal(frame.lwp, ACK_DIFF_LWP)
  assert.deepEqual(frame.headers, { mid: 'mid-2' })
  assert.deepEqual(frame.body, [
    {
      pipeline: 'sync',
      channel: 'sync',
      topic: 'sync',
      tooLong2Tag: 'PNM,1',
      highPts: 0,
      pts: NOW * 1000,
      seq: 0,
      timestamp: Math.floor(NOW / 1000),
    },
  ])
  expectValidation(() => buildAckDiffFrame({ nowMs: 0 }))
  expectValidation(() => buildAckDiffFrame({ nowMs: 1.5 }))
  expectValidation(() => buildAckDiffFrame(null))
})

test('心跳帧与 ACK 帧', () => {
  const heartbeat = buildHeartbeatFrame('mid-3')
  assert.equal(heartbeat.lwp, HEARTBEAT_LWP)
  assert.deepEqual(heartbeat.headers, { mid: 'mid-3' })
  expectValidation(() => buildHeartbeatFrame(''))

  const ack = buildAckFrame({
    code: 200,
    headers: { mid: 'down-1', sid: 'sid-1', 'app-key': 'k', ua: 'ua', dt: 'j', extra: '丢掉' },
  })
  assert.deepEqual(ack, {
    code: 200,
    headers: { mid: 'down-1', sid: 'sid-1', 'app-key': 'k', ua: 'ua', dt: 'j' },
  })
  assert.equal(buildAckFrame({ headers: { sid: 'sid-1' } }), undefined)
  assert.equal(buildAckFrame({}), undefined)
  assert.equal(buildAckFrame(null), undefined)
})

test('encodeFrame / parseFrameText 往返，非法帧返回 undefined', () => {
  const frame = buildRegFrame({ accessToken: 'access-1', deviceId: 'device-1', mid: 'mid-1' })
  assert.deepEqual(parseFrameText(encodeFrame(frame)), frame)
  for (const bad of [undefined, null, 123, {}, '', 'not-json', '[]', '"text"', '{"lwp":123}']) {
    assert.equal(parseFrameText(bad), undefined)
  }
})

test('decodeBase64Json：明文 JSON 成功，坏 base64 返回 undefined 不抛', () => {
  assert.deepEqual(decodeBase64Json(Buffer.from('{"a":1}').toString('base64')), { a: 1 })
  assert.deepEqual(decodeBase64Json(Buffer.from('[1,2]').toString('base64')), [1, 2])
  assert.equal(decodeBase64Json(Buffer.from('hello').toString('base64')), undefined)
  assert.equal(decodeBase64Json('!!!'), undefined)
  assert.equal(decodeBase64Json(''), undefined)
  assert.equal(decodeBase64Json(123), undefined)
})

test('窄化工具：readText / readInteger / readPath', () => {
  assert.equal(readText('x'), 'x')
  assert.equal(readText(''), undefined)
  assert.equal(readText(1), undefined)
  assert.equal(readInteger(NOW), NOW)
  assert.equal(readInteger(NOW + 0.5), undefined)
  assert.equal(readInteger('1'), undefined)
  assert.equal(readPath({ a: { b: 1 } }, ['a', 'b']), 1)
  assert.equal(readPath({ a: null }, ['a', 'b']), undefined)
  assert.equal(readPath({ a: 1 }, ['missing']), undefined)
})

test('buildSendMessageFrame：cid/接收人补 @goofish，custom.data 是 base64(内层 JSON)', () => {
  const frame = buildSendMessageFrame({
    cid: '671234567',
    text: '在的，这个还能便宜',
    peerId: '2206569289277',
    selfId: '111222333',
    nowMs: NOW,
    mid: '500' + String(NOW) + ' 0',
    uuid: UUID,
  })
  assert.equal(frame.lwp, SEND_LWP)
  assert.deepEqual(frame.headers, { mid: '500' + String(NOW) + ' 0' })
  const body = frame.body as Record<string, any>[]
  assert.equal(body.length, 2)
  const message = body[0]!
  assert.equal(message.cid, '671234567@goofish')
  assert.equal(message.uuid, UUID)
  assert.equal(message.conversationType, CONVERSATION_TYPE_SINGLE)
  assert.equal(message.redPointPolicy, 0)
  assert.equal(message.msgReadStatusSetting, 1)
  assert.deepEqual(message.extension, { extJson: '{}' })
  assert.deepEqual(message.ctx, { appVersion: '1.0', platform: 'web' })
  const content = message.content
  assert.equal(content.contentType, CONTENT_TYPE_CUSTOM)
  assert.equal(content.custom.type, CUSTOM_TEXT_TYPE)
  const inner = JSON.parse(Buffer.from(content.custom.data, 'base64').toString('utf8'))
  assert.deepEqual(inner, { contentType: 1, text: { text: '在的，这个还能便宜' } })
  assert.deepEqual(body[1], { actualReceivers: ['2206569289277@goofish', '111222333@goofish'] })
})

test('buildSendMessageFrame：已带 @goofish 不重复拼，空白 id 与空正文拒绝', () => {
  assert.equal(toGoofishId('671234567@goofish', 'cid'), '671234567@goofish')
  assert.equal(toGoofishId(' 671234567 ', 'cid'), '671234567@goofish')
  expectValidation(() => toGoofishId('   ', 'cid'))
  expectValidation(() => toGoofishId(123, 'cid'))
  expectValidation(() => buildSendMessageFrame({ cid: '1', text: '', peerId: '2', selfId: '3', nowMs: NOW }))
  expectValidation(() => buildSendMessageFrame({ cid: '1', text: '   ', peerId: '2', selfId: '3', nowMs: NOW }))
  expectValidation(() =>
    buildSendMessageFrame({ cid: '1', text: 'x'.repeat(SEND_TEXT_MAX_LENGTH + 1), peerId: '2', selfId: '3', nowMs: NOW }),
  )
  expectValidation(() => buildSendMessageFrame(null))
})

test('buildSendMessageFrame：默认生成 uuid 与 mid，且能 JSON 往返成合法帧', () => {
  const first = buildSendMessageFrame({ cid: '1', text: 'hi', peerId: '2', selfId: '3', nowMs: NOW })
  const second = buildSendMessageFrame({ cid: '1', text: 'hi', peerId: '2', selfId: '3', nowMs: NOW })
  const firstBody = first.body as Record<string, any>[]
  const secondBody = second.body as Record<string, any>[]
  assert.match(String(firstBody[0]!.uuid), /^[0-9a-f-]{36}$/)
  assert.notEqual(firstBody[0]!.uuid, secondBody[0]!.uuid)
  assert.match(String(first.headers!.mid), /^\d+ 0$/)
  assert.deepEqual(parseFrameText(encodeFrame(first)), first)
})

