import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { XianyuError } from '@bigfish/core'
import { attachChrome, attachChromePage, launchChrome, resolveChromePath } from '../src/launch.ts'
import type { FetchLike } from '../src/launch.ts'
import { FakeSocket, jsonResponse, makeFakeFetch, makeFakeSpawn, scratchPath, writeScratch } from './harness.ts'

const WS_URL = 'ws://127.0.0.1:9333/devtools/browser/abc-123'

function assertNetworkError(error: unknown): true {
  assert.ok(error instanceof XianyuError)
  assert.equal(error.code, 'NETWORK')
  return true
}

test('resolveChromePath 优先用 BF_CHROME 指向的已存在文件', async () => {
  const exe = await writeScratch('fake-chrome.exe', '#!/bin/sh\n')
  assert.equal(resolveChromePath({ BF_CHROME: exe }), exe)
  assert.equal(resolveChromePath({ BF_CHROME: '' }), resolveChromePath({}))
})

test('launchChrome：拼 /json/version、传端口与 headless 参数、close 杀进程', async () => {
  const { fetcher, urls } = makeFakeFetch(() => jsonResponse({ webSocketDebuggerUrl: WS_URL }))
  const spawn = makeFakeSpawn()
  const userDataDir = scratchPath('profile-launch')
  const result = await launchChrome({
    execPath: 'C:/fake/chrome.exe',
    userDataDir,
    port: 9333,
    fetchImpl: fetcher,
    spawnImpl: spawn.spawnImpl,
  })

  assert.equal(result.port, 9333)
  assert.equal(result.target.browserWsUrl, WS_URL)
  assert.deepEqual(urls, ['http://127.0.0.1:9333/json/version'])
  assert.equal(spawn.spawns.length, 1)
  const launched = spawn.spawns[0]
  assert.ok(launched !== undefined)
  assert.equal(launched.command, 'C:/fake/chrome.exe')
  assert.ok(launched.args.includes('--remote-debugging-port=9333'))
  assert.ok(launched.args.includes('--headless=new'))
  assert.ok(launched.args.includes('--user-data-dir=' + userDataDir))
  assert.equal(existsSync(userDataDir), true)

  await result.close()
  await result.close()
  assert.equal(spawn.killCount(), 1)
})

test('launchChrome：headless=false 不传 --headless', async () => {
  const { fetcher } = makeFakeFetch(() => jsonResponse({ webSocketDebuggerUrl: WS_URL }))
  const spawn = makeFakeSpawn()
  const result = await launchChrome({
    execPath: 'C:/fake/chrome.exe',
    port: 9444,
    headless: false,
    fetchImpl: fetcher,
    spawnImpl: spawn.spawnImpl,
  })
  const launched = spawn.spawns[0]
  assert.ok(launched !== undefined)
  assert.equal(launched.args.some((arg) => arg.startsWith('--headless')), false)
  await result.close()
})

test('launchChrome：DevTools 一直不就绪 → NETWORK 且杀掉进程', async () => {
  const { fetcher } = makeFakeFetch(() => jsonResponse({}, 503))
  const spawn = makeFakeSpawn()
  await assert.rejects(
    launchChrome({
      execPath: 'C:/fake/chrome.exe',
      port: 9555,
      timeoutMs: 80,
      pollMs: 10,
      fetchImpl: fetcher,
      spawnImpl: spawn.spawnImpl,
    }),
    (error: unknown) => {
      assertNetworkError(error)
      assert.ok((error as XianyuError).message.includes('端口 9555'))
      return true
    },
  )
  assert.equal(spawn.killCount(), 1)
})

test('launchChrome：DevTools 响应缺 webSocketDebuggerUrl → UNSUPPORTED', async () => {
  const { fetcher } = makeFakeFetch(() => jsonResponse({ Browser: 'Chrome/130' }))
  const spawn = makeFakeSpawn()
  await assert.rejects(
    launchChrome({
      execPath: 'C:/fake/chrome.exe',
      fetchImpl: fetcher,
      spawnImpl: spawn.spawnImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'UNSUPPORTED')
      return true
    },
  )
  assert.equal(spawn.killCount(), 1)
})

test('attachChrome：按端口拼 URL 并返回 browserWsUrl', async () => {
  const { fetcher, urls } = makeFakeFetch(() => jsonResponse({ webSocketDebuggerUrl: WS_URL }))
  const target = await attachChrome(9333, { fetchImpl: fetcher })
  assert.deepEqual(urls, ['http://127.0.0.1:9333/json/version'])
  assert.equal(target.browserWsUrl, WS_URL)
  await target.close()
})

test('attachChrome：连不上与 HTTP 非 200 都是 NETWORK', async () => {
  const refusing: FetchLike = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:9222')
  }
  await assert.rejects(attachChrome(9222, { fetchImpl: refusing }), (error: unknown) => {
    assertNetworkError(error)
    assert.ok((error as XianyuError).message.includes('9222'))
    return true
  })

  const badStatus = await attachChrome(9222, { fetchImpl: async () => jsonResponse({}, 400) })
    .then(() => undefined, (error: unknown) => error)
  assert.ok(badStatus instanceof XianyuError)
  assert.equal(badStatus.code, 'NETWORK')
})

/** 建连后自动回包的假 socket：attachChromePage 的 Target.createTarget 需要结果才能继续。 */
class AutoReplySocket extends FakeSocket {
  #replies: Record<string, unknown | Error>

  constructor(replies: Record<string, unknown | Error>) {
    super()
    this.#replies = replies
  }

  override send(data: string): void {
    super.send(data)
    const frame = JSON.parse(data) as { id: number; method: string }
    const planned = this.#replies[frame.method]
    queueMicrotask(() => {
      if (planned instanceof Error) this.replyError(frame.id, planned.message)
      else this.reply(frame.id, planned ?? {})
    })
  }
}

function autoReplyFactory(replies: Record<string, unknown | Error>): {
  factory: (url: string) => FakeSocket
  sockets: FakeSocket[]
} {
  const sockets: FakeSocket[] = []
  const factory = (): FakeSocket => {
    const socket = new AutoReplySocket(replies)
    sockets.push(socket)
    queueMicrotask(() => socket.open())
    return socket
  }
  return { factory, sockets }
}

test('attachChromePage：建页面 target、拼 page ws 地址、close 关 target', async () => {
  const { fetcher } = makeFakeFetch(() => jsonResponse({ webSocketDebuggerUrl: WS_URL }))
  const { factory, sockets } = autoReplyFactory({ 'Target.createTarget': { targetId: 'page-1' } })
  const handle = await attachChromePage(9333, { fetchImpl: fetcher, webSocketFactory: factory })
  assert.equal(handle.pageWsUrl, 'ws://127.0.0.1:9333/devtools/page/page-1')
  assert.equal(handle.targetId, 'page-1')
  const socket = sockets[0]
  assert.ok(socket !== undefined)
  const first = JSON.parse(socket.sent[0] ?? '{}') as { method: string; params: Record<string, unknown> }
  assert.equal(first.method, 'Target.createTarget')
  assert.deepEqual(first.params, { url: 'about:blank' })

  await handle.close()
  await handle.close()
  assert.ok(socket.sent.some((raw: string) => raw.includes('Target.closeTarget')))
  assert.equal(socket.closed, true)
})

test('attachChromePage：createTarget 失败转 NETWORK，且断开连接', async () => {
  const { fetcher } = makeFakeFetch(() => jsonResponse({ webSocketDebuggerUrl: WS_URL }))
  const { factory, sockets } = autoReplyFactory({ 'Target.createTarget': new Error('no target') })
  await assert.rejects(
    attachChromePage(9333, { fetchImpl: fetcher, webSocketFactory: factory }),
    (error: unknown) => {
      assertNetworkError(error)
      assert.ok((error as XianyuError).message.includes('no target'))
      return true
    },
  )
  assert.equal(sockets[0]?.closed, true)
})

test('attachChromePage：browser ws 地址不符合预期 → UNSUPPORTED', async () => {
  const { fetcher } = makeFakeFetch(() => jsonResponse({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/cdp' }))
  const { factory } = autoReplyFactory({ 'Target.createTarget': { targetId: 'page-1' } })
  await assert.rejects(
    attachChromePage(9333, { fetchImpl: fetcher, webSocketFactory: factory }),
    (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'UNSUPPORTED')
      return true
    },
  )
})
