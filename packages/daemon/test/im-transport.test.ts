/**
 * ws 适配器测试：只验「生命周期 + 文本帧边界 + 失败归类」，不连真网。
 * 真实服务端行为由 P2.1 真机验收覆盖（docs/im-protocol.md）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'

import { createImTransport } from '../src/im-transport.ts'
import { FakeSocket } from './im-harness.ts'

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof XianyuError && error.code === code
}

describe('createImTransport', () => {
  it('未 open 时 send 直接 NETWORK（帧不发出去，也不静默吞）', () => {
    const socket = new FakeSocket('wss://example.invalid', {})
    const connection = createImTransport({ url: 'wss://example.invalid', factory: () => socket })
    assert.throws(() => connection.transport.send('x'), isCode('NETWORK'))
    assert.deepEqual(socket.sent, [])
    connection.close()
  })

  it('open 后 send 落到 socket；下行文本帧转给 onMessage', async () => {
    const socket = new FakeSocket('wss://example.invalid', {})
    const received: string[] = []
    const connection = createImTransport({
      url: 'wss://example.invalid',
      factory: () => socket,
      onOpen: () => received.push('opened'),
    })
    connection.transport.onMessage((text) => received.push(text))
    await connection.opened
    connection.transport.send('{"lwp":"/!"}')
    assert.deepEqual(socket.sent, ['{"lwp":"/!"}'])
    socket.emitMessage('{"lwp":"sync"}')
    assert.deepEqual(received, ['opened', '{"lwp":"sync"}'])
    connection.close()
  })

  it('二进制帧按 UTF-8 解出文本（协议目前只发文本，但 TLS 层可能给 bytes）', async () => {
    const socket = new FakeSocket('wss://example.invalid', {})
    const received: string[] = []
    const connection = createImTransport({ url: 'wss://example.invalid', factory: () => socket })
    connection.transport.onMessage((text) => received.push(text))
    await connection.opened
    socket.emitMessage(new Uint8Array(Buffer.from('{"lwp":"bin"}', 'utf8')))
    assert.deepEqual(received, ['{"lwp":"bin"}'])
    connection.close()
  })

  it('非文本帧按断链处理：onClose 一次，之后 send 变 NETWORK', async () => {
    const socket = new FakeSocket('wss://example.invalid', {})
    const reasons: string[] = []
    const connection = createImTransport({
      url: 'wss://example.invalid',
      factory: () => socket,
      onClose: (reason) => reasons.push(reason),
    })
    await connection.opened
    socket.emitMessage(42)
    assert.deepEqual(reasons, ['收到非文本帧'])
    assert.throws(() => connection.transport.send('x'), isCode('NETWORK'))
  })

  it('连接未建立就 close：opened reject NETWORK', async () => {
    const socket = new FakeSocket('wss://example.invalid', {})
    const connection = createImTransport({ url: 'wss://example.invalid', factory: () => socket })
    socket.emitClose(1006)
    await assert.rejects(connection.opened, isCode('NETWORK'))
    const caught = await connection.opened.catch((error: unknown) => error)
    assert.ok(caught instanceof XianyuError)
    assert.match(caught.message, /code 1006/)
  })

  it('open 之后 close/error 双发只通知一次，reason 带 code', async () => {
    const socket = new FakeSocket('wss://example.invalid', {})
    const reasons: string[] = []
    const connection = createImTransport({
      url: 'wss://example.invalid',
      factory: () => socket,
      onClose: (reason) => reasons.push(reason),
    })
    await connection.opened
    socket.emitClose(1006)
    socket.emitError()
    assert.equal(reasons.length, 1)
    assert.match(reasons[0] ?? '', /code 1006/)
    connection.close()
    assert.equal(reasons.length, 1, '主动 close 也是一次，且不重复')
  })

  it('工厂抛错：opened reject 同一个错误，send 抛同样错误', async () => {
    const boom = new XianyuError({ code: 'INTERNAL', message: 'factory boom' })
    const connection = createImTransport({
      url: 'wss://example.invalid',
      factory: () => {
        throw boom
      },
    })
    await assert.rejects(connection.opened, (error: unknown) => error === boom)
    assert.throws(() => connection.transport.send('x'), (error: unknown) => error === boom)
    connection.close()
  })

  it('运行时没有全局 WebSocket 时给 UNSUPPORTED，而不是 TypeError', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
    Object.defineProperty(globalThis, 'WebSocket', { value: undefined, configurable: true, writable: true })
    try {
      const connection = createImTransport({ url: 'wss://example.invalid' })
      await assert.rejects(connection.opened, isCode('UNSUPPORTED'))
    } finally {
      if (descriptor === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket
      else Object.defineProperty(globalThis, 'WebSocket', descriptor)
    }
  })
})
