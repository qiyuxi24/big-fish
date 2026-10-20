import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { XianyuError } from '@bigfish/core'
import { attachChrome, launchChrome, resolveChromePath } from '../src/launch.ts'
import type { FetchLike } from '../src/launch.ts'
import { jsonResponse, makeFakeFetch, makeFakeSpawn, scratchPath, writeScratch } from './harness.ts'

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
