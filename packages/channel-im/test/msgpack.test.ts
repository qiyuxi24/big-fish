import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeMsgpack, decodeMsgpackStream } from '../src/msgpack.ts'
import { encodeMsgpack, encodeMsgpackStream } from './msgpack-codec.ts'

test('标量与字符串往返：nil/布尔/正负整数/长短字符串', () => {
  const string = '闲鱼 IM 推送：我 已拍下，待付款'.repeat(3)
  const values: unknown[] = [
    undefined,
    true,
    false,
    0,
    127,
    128,
    255,
    256,
    65_535,
    65_536,
    4_294_967_295,
    4_294_967_296,
    -1,
    -32,
    -33,
    -128,
    -129,
    -32_769,
    -2_147_483_648,
    '',
    'a',
    'x'.repeat(31),
    'y'.repeat(32),
    'z'.repeat(300),
    string,
    1.5,
  ]
  for (const value of values) {
    assert.deepEqual(decodeMsgpack(encodeMsgpack(value)), value, JSON.stringify(value))
  }
})

test('嵌套 map / array / 二进制数据', () => {
  const value = {
    '1': { '2': 'cid-1@goofish', '3': 'msg-1', '5': 1_742_458_817_389 },
    '6': { '1': 101, '3': { '1': '', '2': '[我已拍下，待付款]', '4': 26 } },
    list: [1, 'two', true, { deep: [3, 4] }],
    bin: Uint8Array.from([1, 2, 3]),
  }
  const decoded = decodeMsgpack(encodeMsgpack(value)) as Record<string, unknown>
  assert.equal((decoded['6'] as Record<string, unknown>)['1'], 101)
  assert.equal(((decoded['1'] as Record<string, unknown>)['5']), 1_742_458_817_389)
  assert.deepEqual(decoded.list, [1, 'two', true, { deep: [3, 4] }])
  assert.deepEqual([...(decoded.bin as Uint8Array)], [1, 2, 3])
})

test('64 位时间戳在安全整数范围内返回 number', () => {
  const decoded = decodeMsgpack(encodeMsgpack(1_742_458_817_389))
  assert.equal(typeof decoded, 'number')
  assert.equal(decoded, 1_742_458_817_389)
})

test('流式解码：一个 data 里接连多条对象', () => {
  const values = [{ a: 1 }, { b: 'two' }, [3]]
  assert.deepEqual(decodeMsgpackStream(encodeMsgpackStream(values)), values)
  assert.equal(decodeMsgpack(encodeMsgpackStream(values)), undefined, '多个对象时 decodeMsgpack 不给唯一值')
})

test('截断数据只保留已解出的部分，不抛', () => {
  const bytes = encodeMsgpackStream([{ ok: 1 }, { broken: 'x'.repeat(64) }])
  const decoded = decodeMsgpackStream(bytes.subarray(0, bytes.length - 10))
  assert.deepEqual(decoded, [{ ok: 1 }])
})

test('不支持的 ext 类型让整条失败，不抛', () => {
  assert.deepEqual(decodeMsgpackStream(Uint8Array.from([0xc7, 0x01, 0xff, 0x00])), [])
})

test('嵌套超过深度上限按坏数据丢弃', () => {
  let nested: unknown = 1
  for (let index = 0; index < 40; index += 1) nested = [nested]
  assert.deepEqual(decodeMsgpackStream(encodeMsgpack(nested)), [])
})

test('空数据与非字节输入返回空数组', () => {
  for (const bad of [undefined, null, 'text', 123, {}, []]) {
    assert.deepEqual(decodeMsgpackStream(bad), [])
  }
  assert.deepEqual(decodeMsgpackStream(new Uint8Array(0)), [])
})

test('非法 UTF-8 字节不抛，按替换字符解出', () => {
  const bytes = Uint8Array.from([0xa2, 0xff, 0xfe])
  const decoded = decodeMsgpackStream(bytes)
  assert.equal(decoded.length, 1)
  assert.equal(typeof decoded[0], 'string')
})
