import test from 'node:test'
import assert from 'node:assert/strict'
import { XianyuError } from '@bigfish/core'
import { assertLoginCookies, CdpCookieSource, selectGoofishCookies } from '../src/cookies.ts'
import type { BrowserCookie, CdpRequestConnection } from '../src/cookies.ts'
import { FakeConnection } from './harness.ts'

/** 造一条 cookie；默认落在 .goofish.com 的根路径。 */
function cookie(over: Partial<BrowserCookie> & { name: string; value: string }): BrowserCookie {
  return { domain: '.goofish.com', path: '/', ...over }
}

/** 连接失败的替身：用来验证 #call 的异常归一。 */
class FailingConnection implements CdpRequestConnection {
  readonly #error: unknown

  constructor(error: unknown) {
    this.#error = error
  }

  send(): Promise<unknown> {
    return Promise.reject(this.#error)
  }
}

function loginJar(goofish: Record<string, string>): { goofish: Record<string, string>; others: number } {
  return { goofish, others: 0 }
}

function assertCode(error: unknown, code: string, includes: string): boolean {
  assert.ok(error instanceof XianyuError)
  assert.equal(error.code, code)
  assert.ok(error.message.includes(includes), '消息里应包含「' + includes + '」：' + error.message)
  return true
}

test('selectGoofishCookies 收集 goofish/taobao 域（含子域），其它域只计数', () => {
  const jar = selectGoofishCookies([
    cookie({ name: '_m_h5_tk', value: 'tk' }),
    cookie({ name: 'unb', value: '123', domain: 'goofish.com' }),
    cookie({ name: 'x', value: 'v', domain: '.taobao.com' }),
    cookie({ name: 'cna', value: 'c', domain: 'uland.goofish.com' }),
    cookie({ name: '__cf_bm', value: 'z', domain: '.example.com' }),
    cookie({ name: 'evil', value: 'e', domain: 'evilgoofish.com' }),
  ])
  assert.deepEqual(jar.goofish, { _m_h5_tk: 'tk', unb: '123', x: 'v', cna: 'c' })
  assert.equal(jar.others, 2)
})

test('selectGoofishCookies 域名匹配大小写不敏感，且容忍前导点与空白', () => {
  const jar = selectGoofishCookies([
    cookie({ name: 'a', value: '1', domain: '.GOOFISH.COM' }),
    cookie({ name: 'b', value: '2', domain: '  Taobao.com ' }),
    cookie({ name: 'c', value: '3', domain: 'GOOFISH.COM' }),
  ])
  assert.deepEqual(jar.goofish, { a: '1', b: '2', c: '3' })
  assert.equal(jar.others, 0)
})

test('selectGoofishCookies 同名取 path 更长者（与出现顺序无关）', () => {
  const longFirst = selectGoofishCookies([
    cookie({ name: 'cookie2', value: 'long', path: '/h5' }),
    cookie({ name: 'cookie2', value: 'short', path: '/' }),
  ])
  assert.equal(longFirst.goofish['cookie2'], 'long')
  const longLast = selectGoofishCookies([
    cookie({ name: 'cookie2', value: 'short', path: '/' }),
    cookie({ name: 'cookie2', value: 'long', path: '/h5' }),
  ])
  assert.equal(longLast.goofish['cookie2'], 'long')
})

test('selectGoofishCookies path 等长时后出现者覆盖', () => {
  const jar = selectGoofishCookies([
    cookie({ name: 'unb', value: 'old' }),
    cookie({ name: 'unb', value: 'new' }),
  ])
  assert.equal(jar.goofish['unb'], 'new')
})

test('selectGoofishCookies 空名 cookie 计入 others 且不进程', () => {
  const jar = selectGoofishCookies([cookie({ name: '', value: 'x' })])
  assert.deepEqual(jar.goofish, {})
  assert.equal(jar.others, 1)
})

test('assertLoginCookies 两个登录 cookie 齐全时不抛', () => {
  assertLoginCookies(loginJar({ _m_h5_tk: 'tk_token_1700000000000', unb: '2200' }))
})

test('assertLoginCookies 缺 _m_h5_tk 只报它，并给修复步骤', () => {
  assert.throws(
    () => assertLoginCookies(loginJar({ unb: '2200' })),
    (error: unknown) => {
      assertCode(error, 'UNAUTHORIZED', '_m_h5_tk')
      assert.ok(error instanceof XianyuError)
      assert.equal(error.message.includes('unb'), false, '只报缺的那个')
      assert.ok(error.message.includes('https://www.goofish.com/'), '消息要带可执行的修复步骤')
      return true
    },
  )
})

test('assertLoginCookies 缺 unb 报 unb（且不可重试）', () => {
  assert.throws(
    () => assertLoginCookies(loginJar({ _m_h5_tk: 'tk_1' })),
    (error: unknown) => {
      assertCode(error, 'UNAUTHORIZED', 'unb')
      assert.ok(error instanceof XianyuError)
      assert.equal(error.retryable, false)
      assert.equal(error.message.includes('_m_h5_tk'), false)
      return true
    },
  )
})

test('assertLoginCookies 空白值按缺失处理', () => {
  assert.throws(
    () => assertLoginCookies(loginJar({ _m_h5_tk: '   ', unb: '2200' })),
    (error: unknown) => assertCode(error, 'UNAUTHORIZED', '_m_h5_tk'),
  )
})
test('CdpCookieSource 首选 Storage.getCookies（新版浏览器），参数为空对象、不带 sessionId', async () => {
  const conn = new FakeConnection()
  conn.responder = () => ({ cookies: [] })
  const source = new CdpCookieSource(conn)
  assert.deepEqual(await source.getAllCookies(), [])
  assert.deepEqual(conn.calls, [{ method: 'Storage.getCookies', params: {} }])
})

test('Storage.getCookies 不存在时降级到 Network.getAllCookies', async () => {
  const conn = new FakeConnection()
  conn.responder = (method) => {
    if (method === 'Storage.getCookies') {
      throw new XianyuError({ code: 'NETWORK', message: "CDP 错误：'Storage.getCookies' wasn't found" })
    }
    return { cookies: [] }
  }
  assert.deepEqual(await new CdpCookieSource(conn).getAllCookies(), [])
  assert.deepEqual(conn.methods(), ['Storage.getCookies', 'Network.getAllCookies'])
})

test('非「方法不存在」的失败不降级，避免把断连当成版本差异', async () => {
  const conn = new FakeConnection()
  conn.responder = () => {
    throw new XianyuError({ code: 'NETWORK', message: 'socket closed' })
  }
  await assert.rejects(
    new CdpCookieSource(conn).getAllCookies(),
    (error: unknown) => assertCode(error, 'NETWORK', 'socket closed'),
  )
  assert.deepEqual(conn.methods(), ['Storage.getCookies'])
})

test('getAllCookies 映射 CDP 字段：expires 秒值保留、-1 与空 sameSite 丢弃', async () => {
  const conn = new FakeConnection()
  conn.responder = () => ({
    cookies: [
      {
        name: '_m_h5_tk',
        value: 'tk_x',
        domain: '.goofish.com',
        path: '/',
        expires: 1735689600,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      { name: '_m_h5_tk_enc', value: 'enc', domain: '.goofish.com', path: '/', expires: -1, sameSite: '' },
    ],
  })
  const cookies = await new CdpCookieSource(conn).getAllCookies()
  assert.deepEqual(cookies[0], {
    name: '_m_h5_tk',
    value: 'tk_x',
    domain: '.goofish.com',
    path: '/',
    expires: 1735689600,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  })
  const session = cookies[1]
  assert.ok(session !== undefined)
  assert.equal('expires' in session, false, 'expires=-1 表示会话 cookie，映射后不应保留')
  assert.equal('sameSite' in session, false, 'sameSite 为空字符串时不应保留')
})

test('getAllCookies 丢弃字段不全的脏条目，保留合法条目', async () => {
  const conn = new FakeConnection()
  conn.responder = () => ({
    cookies: [
      null,
      'not-a-cookie',
      { name: 'missing_value', domain: '.goofish.com', path: '/' },
      { name: '', value: 'x', domain: '.goofish.com', path: '/' },
      { name: 'unb', value: '2200', domain: '.goofish.com', path: '/' },
    ],
  })
  const cookies = await new CdpCookieSource(conn).getAllCookies()
  assert.deepEqual(cookies, [{ name: 'unb', value: '2200', domain: '.goofish.com', path: '/' }])
})

test('getAllCookies 响应结构非法时 fail(NETWORK)', async () => {
  const notObject = new FakeConnection()
  notObject.responder = () => null
  await assert.rejects(
    new CdpCookieSource(notObject).getAllCookies(),
    (error: unknown) => assertCode(error, 'NETWORK', 'CDP 取 cookie'),
  )

  const notArray = new FakeConnection()
  notArray.responder = () => ({ cookies: 'nope' })
  await assert.rejects(
    new CdpCookieSource(notArray).getAllCookies(),
    (error: unknown) => assertCode(error, 'NETWORK', 'cookies 不是数组'),
  )
})

test('getAllCookies 连接异常归一为 NETWORK，XianyuError 原样透传', async () => {
  await assert.rejects(
    new CdpCookieSource(new FailingConnection(new Error('socket closed'))).getAllCookies(),
    (error: unknown) => assertCode(error, 'NETWORK', 'socket closed'),
  )

  const original = new XianyuError({ code: 'NETWORK', message: 'CDP WebSocket 已关闭' })
  await assert.rejects(
    new CdpCookieSource(new FailingConnection(original)).getAllCookies(),
    (error: unknown) => error === original,
  )
})

test('readGoofishCookies 组合导出与校验：成功返回 goofish jar', async () => {
  const conn = new FakeConnection()
  conn.responder = () => ({
    cookies: [
      { name: '_m_h5_tk', value: 'tk_x', domain: '.goofish.com', path: '/' },
      { name: 'unb', value: '2200', domain: 'goofish.com', path: '/' },
      { name: '__cf_bm', value: 'z', domain: '.example.com', path: '/' },
    ],
  })
  const jar = await new CdpCookieSource(conn).readGoofishCookies()
  assert.deepEqual(jar, { goofish: { _m_h5_tk: 'tk_x', unb: '2200' }, others: 1 })
})

test('readGoofishCookies 缺 unb 时抛 UNAUTHORIZED（没登录就不要继续）', async () => {
  const conn = new FakeConnection()
  conn.responder = () => ({ cookies: [{ name: '_m_h5_tk', value: 'tk_x', domain: '.goofish.com', path: '/' }] })
  await assert.rejects(
    new CdpCookieSource(conn).readGoofishCookies(),
    (error: unknown) => assertCode(error, 'UNAUTHORIZED', 'unb'),
  )
})
