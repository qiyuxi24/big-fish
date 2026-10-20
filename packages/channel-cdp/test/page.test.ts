import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { XianyuError } from '@bigfish/core'
import { CdpPage } from '../src/page.ts'
import type { CdpPageOptions } from '../src/page.ts'
import { FakeConnection, scratchPath, tick } from './harness.ts'

/** 打开一个页面；responder 默认应答 enable/navigate（并触发 load）。 */
async function openPage(opts: CdpPageOptions = {}, conn = new FakeConnection()): Promise<CdpPage> {
  conn.responder = (method) => {
    if (method === 'Page.navigate') conn.emit('Page.loadEventFired', {})
    return undefined
  }
  const page = await CdpPage.open(conn, 'https://www.goofish.com/', { settleMs: 0, ...opts })
  return page
}

test('CdpPage.open 依次 enable 页面域、导航，并等 load 事件', async () => {
  const conn = new FakeConnection()
  await openPage({}, conn)
  assert.deepEqual(conn.methods(), ['Page.enable', 'Runtime.enable', 'Page.navigate'])
  assert.deepEqual(conn.calls[2]?.params, { url: 'https://www.goofish.com/' })
})

test('evaluate 返回 JSON 值；页面异常转 INTERNAL', async () => {
  const conn = new FakeConnection()
  const page = await openPage({}, conn)
  conn.responder = () => ({ result: { value: 42 } })
  assert.equal(await page.evaluate<number>('1+41'), 42)

  conn.responder = () => ({ exceptionDetails: { exception: { description: 'ReferenceError: foo is not defined' } } })
  await assert.rejects(page.evaluate('foo'), (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'INTERNAL')
    assert.ok(error.message.includes('ReferenceError'))
    return true
  })
})

test('waitFor 轮询到真值即返回；超时抛 NETWORK 且 message 带 label', async () => {
  const conn = new FakeConnection()
  const page = await openPage({}, conn)
  let calls = 0
  conn.responder = () => {
    calls += 1
    return { result: { value: calls >= 3 } }
  }
  await page.waitFor('window.ready === true', { timeoutMs: 200, intervalMs: 5, label: '页面就绪' })
  assert.equal(calls, 3)

  conn.responder = () => ({ result: { value: false } })
  await assert.rejects(
    page.waitFor('never()', { timeoutMs: 30, intervalMs: 5, label: '永不出现' }),
    (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'NETWORK')
      assert.ok(error.message.includes('永不出现'))
      return true
    },
  )
})

test('captureJson：responseReceived 认出请求 → 等 loadingFinished → getResponseBody 解析 JSON', async () => {
  const conn = new FakeConnection()
  const page = await openPage({}, conn)
  conn.responder = (method) => {
    if (method === 'Network.enable') return {}
    if (method === 'Network.getResponseBody') return { body: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { itemId: 1 } }) }
    return undefined
  }

  const pending = page.captureJson({ urlContains: '/h5/mtop.taobao.idle.item/' })
  await tick(10)
  // 先来一个不匹配的响应，必须被忽略。
  conn.emit('Network.responseReceived', { requestId: 'r0', response: { url: 'https://example.test/other' } })
  conn.emit('Network.responseReceived', {
    requestId: 'r1',
    response: { url: 'https://h5api.m.goofish.com/h5/mtop.taobao.idle.item/1.0/?v=1' },
  })
  await tick(10)
  // 响应体还没收完：不能读 body。
  assert.ok(!conn.methods().includes('Network.getResponseBody'))
  // 别的请求收完不算，必须等同一个 requestId。
  conn.emit('Network.loadingFinished', { requestId: 'r0' })
  await tick(10)
  assert.ok(!conn.methods().includes('Network.getResponseBody'))
  conn.emit('Network.loadingFinished', { requestId: 'r1' })
  assert.deepEqual(await pending, { ret: ['SUCCESS::调用成功'], data: { itemId: 1 } })
  assert.ok(conn.methods().includes('Network.getResponseBody'))
})

test('captureJson：没等到 loadingFinished 时宽限到期兜底读取一次', async () => {
  const conn = new FakeConnection()
  const page = await openPage({}, conn)
  conn.responder = (method) => (method === 'Network.getResponseBody' ? { body: '{"ok":true}' } : {})
  const pending = page.captureJson({ urlContains: '/api/', loadingGraceMs: 5 })
  await tick(10)
  conn.emit('Network.responseReceived', { requestId: 'r2', response: { url: 'https://example.test/api/x' } })
  assert.deepEqual(await pending, { ok: true })
})

test('captureJson：URL 一直不匹配 → NETWORK 超时，且事件监听被摘掉', async () => {
  const conn = new FakeConnection()
  const page = await openPage({}, conn)
  conn.responder = () => ({})
  await assert.rejects(
    page.captureJson({ urlContains: 'never-appears', timeoutMs: 20 }),
    (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'NETWORK')
      return true
    },
  )
  assert.equal(conn.handlerCount('Network.responseReceived'), 0)
})

test('captureJson：响应体不是 JSON → VALIDATION', async () => {
  const conn = new FakeConnection()
  const page = await openPage({}, conn)
  conn.responder = (method) => (method === 'Network.getResponseBody' ? { body: '<html>not json</html>' } : {})
  const pending = page.captureJson({ urlContains: '/api/' })
  await tick(10)
  conn.emit('Network.responseReceived', { requestId: 'r1', response: { url: 'https://example.test/api/x' } })
  conn.emit('Network.loadingFinished', { requestId: 'r1' })
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'VALIDATION')
    return true
  })
})

test('screenshot 把 base64 写成文件并自动建目录', async () => {
  const conn = new FakeConnection()
  const page = await openPage({}, conn)
  conn.responder = () => ({ data: Buffer.from('png-bytes').toString('base64') })
  const filePath = scratchPath('shots/deep/shot.png')
  await page.screenshot(filePath)
  assert.equal(await readFile(filePath, 'utf8'), 'png-bytes')
})

test('navigate 等不到 load 事件时按超时失败', async () => {
  const conn = new FakeConnection()
  let navigations = 0
  conn.responder = (method) => {
    if (method === 'Page.navigate') {
      navigations += 1
      if (navigations === 1) conn.emit('Page.loadEventFired', {})
    }
    return undefined
  }
  const page = await CdpPage.open(conn, 'https://www.goofish.com/', { settleMs: 0, timeoutMs: 30 })
  await assert.rejects(page.navigate('https://www.goofish.com/second'), (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'NETWORK')
    assert.ok(error.message.includes('30ms'))
    return true
  })
})

test('close 幂等；关闭后再操作抛 NETWORK', async () => {
  const page = await openPage()
  await page.close()
  await page.close()
  await assert.rejects(page.evaluate('1'), (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'NETWORK')
    return true
  })
})

