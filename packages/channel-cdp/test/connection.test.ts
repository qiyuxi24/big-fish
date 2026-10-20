import test from 'node:test'
import assert from 'node:assert/strict'
import { XianyuError } from '@bigfish/core'
import { CdpConnection } from '../src/connection.ts'
import type { CdpConnectionOptions } from '../src/connection.ts'
import { FakeSocket, tick } from './harness.ts'

/** 建连：假 socket 收到 open 事件后 connect 才 resolve。 */
async function connectFake(opts: CdpConnectionOptions = {}): Promise<{ conn: CdpConnection; socket: FakeSocket }> {
  const socket = new FakeSocket()
  const pending = CdpConnection.connect('ws://127.0.0.1:9222/devtools/browser/x', {
    ...opts,
    webSocketFactory: () => socket,
  })
  socket.open()
  const conn = await pending
  return { conn, socket }
}

test('connect 在 open 后 resolve，close 幂等', async () => {
  const { conn, socket } = await connectFake()
  await conn.close()
  assert.equal(socket.closed, true)
  await conn.close()
  assert.equal(socket.closed, true)
})

test('send 按 id 匹配结果，id 自增', async () => {
  const { conn, socket } = await connectFake()
  const first = conn.send<{ value: number }>('Runtime.evaluate', { expression: '1+1' })
  const request = socket.lastRequest()
  assert.equal(request.id, 1)
  assert.equal(request.method, 'Runtime.evaluate')
  assert.deepEqual(request.params, { expression: '1+1' })
  socket.reply(1, { value: 2 })
  assert.deepEqual(await first, { value: 2 })

  const second = conn.send('Page.enable')
  assert.equal(socket.lastRequest().id, 2)
  socket.reply(2, {})
  await second
})

test('错误响应转 XianyuError(NETWORK)', async () => {
  const { conn, socket } = await connectFake()
  const pending = conn.send('Page.navigate', { url: 'about:blank' })
  socket.replyError(socket.lastRequest().id, 'Target closed')
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'NETWORK')
    assert.ok(error.message.includes('Target closed'))
    return true
  })
})

test('send 超时抛 NETWORK 且不挂住', async () => {
  const { conn } = await connectFake({ requestTimeoutMs: 20 })
  await assert.rejects(conn.send('Bogus.method'), (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'NETWORK')
    assert.ok(error.message.includes('超时'))
    return true
  })
})

test('CDP 事件按 method 分发，off 后不再触发', async () => {
  const { conn, socket } = await connectFake()
  const seen: unknown[] = []
  const off = conn.on('Page.loadEventFired', (params) => seen.push(params))
  socket.emitEvent('Page.loadEventFired', { timestamp: 1 })
  assert.deepEqual(seen, [{ timestamp: 1 }])
  off()
  socket.emitEvent('Page.loadEventFired', { timestamp: 2 })
  assert.equal(seen.length, 1)
})

test('close 会拒绝所有在途请求', async () => {
  const { conn } = await connectFake()
  const pending = conn.send('Runtime.evaluate')
  await conn.close()
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'NETWORK')
    return true
  })
  await assert.rejects(conn.send('Runtime.evaluate'))
})

test('connect 握手失败与超时都是 NETWORK', async () => {
  const failing = new FakeSocket()
  const failed = CdpConnection.connect('ws://127.0.0.1:1/x', { webSocketFactory: () => failing, timeoutMs: 200 })
  failing.emit({ type: 'error' })
  await assert.rejects(failed, (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'NETWORK')
    return true
  })

  const silent = new FakeSocket()
  const timedOut = CdpConnection.connect('ws://127.0.0.1:1/y', { webSocketFactory: () => silent, timeoutMs: 20 })
  await assert.rejects(timedOut, (error: unknown) => {
    assert.ok(error instanceof XianyuError)
    assert.equal(error.code, 'NETWORK')
    assert.ok(error.message.includes('超时'))
    return true
  })
  await tick(5)
})

test('非 JSON / 非字符串帧被忽略，不影响后续响应', async () => {
  const { conn, socket } = await connectFake()
  socket.emit({ type: 'message', data: 'not-json' })
  socket.emit({ type: 'message', data: 123 })
  const pending = conn.send('Page.enable')
  socket.reply(socket.lastRequest().id, { ok: true })
  assert.deepEqual(await pending, { ok: true })
})
