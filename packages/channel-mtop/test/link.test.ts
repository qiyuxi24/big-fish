import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XianyuError } from '@bigfish/core'
import { parseXianyuLink } from '../src/index.ts'

/** 断言同步调用抛指定 code 的 XianyuError。 */
function expectSyncCode(code: string, fn: () => unknown): XianyuError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, code)
    return error
  }
  assert.fail('预期抛出 XianyuError')
}

const ITEM_URL = 'https://www.goofish.com/item?id=1091933071728&categoryId=50023914&spm=a21ybx'
const SELLER_URL = 'https://www.goofish.com/personal?userId=2206569289277&spm=a21ybx'

test('parseXianyuLink：商品链接取 id，categoryId 有就带', () => {
  assert.deepEqual(parseXianyuLink(ITEM_URL), { kind: 'item', itemId: '1091933071728', categoryId: '50023914' })
  assert.deepEqual(parseXianyuLink('https://www.goofish.com/item?id=42'), { kind: 'item', itemId: '42' })
})

test('parseXianyuLink：商家主页链接取 userId（就是商家唯一 ID）', () => {
  assert.deepEqual(parseXianyuLink(SELLER_URL), { kind: 'seller', sellerId: '2206569289277' })
  // 移动端/老域名同样只按 query 判断。
  assert.deepEqual(parseXianyuLink('https://h5.m.goofish.com/personal?userId=7'), { kind: 'seller', sellerId: '7' })
  assert.deepEqual(parseXianyuLink('https://2.taobao.com/personal?userId=8'), { kind: 'seller', sellerId: '8' })
})

test('parseXianyuLink：App 分享文案里抠 URL', () => {
  const share = '【闲鱼】我在闲鱼发布了宝贝 ' + ITEM_URL + ' 点击链接直接打开'
  assert.deepEqual(parseXianyuLink(share), { kind: 'item', itemId: '1091933071728', categoryId: '50023914' })
})

test('parseXianyuLink：两个 id 都在时以商家为准，非法 id 不猜', () => {
  assert.deepEqual(
    parseXianyuLink('https://www.goofish.com/item?id=1&userId=2'),
    { kind: 'seller', sellerId: '2' },
  )
  // id 不是纯数字 → 当作没有，继续找不到就报错，而不是把 'abc' 当 id。
  expectSyncCode('VALIDATION', () => parseXianyuLink('https://www.goofish.com/item?id=abc'))
})

test('parseXianyuLink：纯数字 / 非闲鱼域名 / 短链分别给出可操作错误', () => {
  const plain = expectSyncCode('VALIDATION', () => parseXianyuLink('1091933071728'))
  assert.match(plain.message, /纯数字无法判断/)
  expectSyncCode('VALIDATION', () => parseXianyuLink('https://example.com/item?id=1'))
  const short = expectSyncCode('UNSUPPORTED', () => parseXianyuLink('https://m.tb.cn/h.5abcdef'))
  assert.match(short.message, /浏览器打开/)
})

test('parseXianyuLink：空输入与非字符串直接 VALIDATION', () => {
  expectSyncCode('VALIDATION', () => parseXianyuLink('   '))
  expectSyncCode('VALIDATION', () => parseXianyuLink(42))
  expectSyncCode('VALIDATION', () => parseXianyuLink(undefined))
})
