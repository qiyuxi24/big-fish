import test from 'node:test'
import assert from 'node:assert/strict'
import { createDaemonClient, DaemonError } from '../src/client.js'
import { startStubServer } from './helpers.mjs'

const readFileOk = async () => 'secret-token\n'

test('health 不要求 token；status 带 Bearer', async () => {
  const seen = []
  const server = await startStubServer({
    '/health': { body: { ok: true, data: { version: '1.2.3', uptimeMs: 1000, pid: 42 } } },
    '/status': { body: { ok: true, data: { version: '1.2.3', queue: { queued: 1 } } } },
  })
  try {
    const client = createDaemonClient({
      daemonUrl: server.url,
      tokenPath: 'ignored',
      readFileImpl: readFileOk,
      fetchImpl: (url, init) => {
        seen.push({ url: String(url), headers: init?.headers })
        return fetch(url, init)
      },
    })
    const health = await client.health()
    assert.equal(health.pid, 42)
    assert.equal(seen[0].headers.authorization, undefined)
    const status = await client.status()
    assert.equal(status.queue.queued, 1)
    assert.equal(seen[1].headers.authorization, 'Bearer secret-token')
  } finally {
    await server.close()
  }
})

test('缺 token 文件 → UNAUTHORIZED 且提示可操作', async () => {
  const client = createDaemonClient({
    daemonUrl: 'http://127.0.0.1:1',
    tokenPath: 'C:/nope/daemon.token',
    readFileImpl: async () => { throw new Error('ENOENT') },
  })
  await assert.rejects(client.status(), (error) => {
    assert.ok(error instanceof DaemonError)
    assert.equal(error.code, 'UNAUTHORIZED')
    assert.match(error.message, /daemon.token/)
    return true
  })
})

test('401 映射 UNAUTHORIZED；ok:false 透传 code；未知 code 收敛 INTERNAL', async () => {
  const server = await startStubServer({
    '/a': { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } } },
    '/b': { status: 400, body: { ok: false, error: { code: 'VALIDATION', message: 'kind 非法', retryable: false } } },
    '/c': { status: 500, body: { ok: false, error: { code: 'WAT', message: '?' } } },
  })
  try {
    const client = createDaemonClient({ daemonUrl: server.url, tokenPath: 'x', readFileImpl: readFileOk })
    await assert.rejects(client.request('/a'), (e) => e.code === 'UNAUTHORIZED')
    await assert.rejects(client.request('/b'), (e) => e.code === 'VALIDATION')
    await assert.rejects(client.request('/c'), (e) => e.code === 'INTERNAL')
  } finally {
    await server.close()
  }
})

test('连不上 → NETWORK；超时 → NETWORK(retryable)', async () => {
  const offline = createDaemonClient({ daemonUrl: 'http://127.0.0.1:1', tokenPath: 'x', readFileImpl: readFileOk, timeoutMs: 200 })
  await assert.rejects(offline.status(), (e) => e.code === 'NETWORK' && e.retryable === true)

  const server = await startStubServer({ '/status': { hang: true, body: {} } })
  try {
    const slow = createDaemonClient({ daemonUrl: server.url, tokenPath: 'x', readFileImpl: readFileOk, timeoutMs: 80 })
    await assert.rejects(slow.status(), (e) => e.code === 'NETWORK' && /超时/.test(e.message))
  } finally {
    await server.close()
  }
})

test('importAccount 以 POST /accounts/import 提交，带 Bearer 且 body 透传', async () => {
  const seen = []
  const server = await startStubServer({
    '/accounts/import': { body: { ok: true, data: { accountId: 'acc-9', savedFieldCount: 5, updatedAt: 1, source: 'chrome-cdp' } } },
  })
  try {
    const client = createDaemonClient({
      daemonUrl: server.url,
      tokenPath: 'x',
      readFileImpl: readFileOk,
      fetchImpl: (url, init) => {
        seen.push({ method: init?.method, body: init?.body, headers: init?.headers })
        return fetch(url, init)
      },
    })
    const imported = await client.importAccount({ accountId: 'acc-9', port: 9333 })
    assert.equal(imported.accountId, 'acc-9')
    assert.equal(imported.savedFieldCount, 5)
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].headers.authorization, 'Bearer secret-token')
    assert.deepEqual(JSON.parse(seen[0].body), { accountId: 'acc-9', port: 9333 })
    await client.importAccount()
    assert.deepEqual(JSON.parse(seen[1].body), {})
  } finally {
    await server.close()
  }
})

test('listEvents 把 since/limit/taskId/batchId 拼成查询串，缺省不带参数', async () => {
  const seen = []
  const server = await startStubServer({
    '/events': { body: { ok: true, data: { items: [], nextSince: 0 } } },
  })
  try {
    const client = createDaemonClient({
      daemonUrl: server.url,
      tokenPath: 'x',
      readFileImpl: readFileOk,
      fetchImpl: (url, init) => {
        seen.push(String(url))
        return fetch(url, init)
      },
    })
    await client.listEvents({ since: 0, limit: 200 })
    assert.equal(seen[0], server.url + '/events?since=0&limit=200')
    await client.listEvents({ since: 12, taskId: 't-1', batchId: 'b-1' })
    assert.equal(seen[1], server.url + '/events?since=12&taskId=t-1&batchId=b-1')
    await client.listEvents()
    assert.equal(seen[2], server.url + '/events')
  } finally {
    await server.close()
  }
})

test('非 JSON 响应 → INTERNAL', async () => {
  const server = await startStubServer({ '/status': { body: '<html>bad gateway</html>' } })
  try {
    const client = createDaemonClient({ daemonUrl: server.url, tokenPath: 'x', readFileImpl: readFileOk })
    await assert.rejects(client.status(), (e) => e.code === 'INTERNAL')
  } finally {
    await server.close()
  }
})
