import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createPanelRoute, endpointFromPath, assertRpcChannel } from '../src/host-route.js'

/**
 * 起一个真实 HTTP server 直接挂 route.handler，请求走 node:http，
 * 这样 URL 原样保留（不会被 fetch 归一化）——路由的边界校验才测得到。
 */
async function startRouteServer(route) {
  const server = createServer((request, response) => {
    route.handler(request, response).catch((error) => {
      response.destroy(error)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: 'http://127.0.0.1:' + String(address.port),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 发一条原始请求，返回 {status, headers, text}。 */
function send(baseUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, baseUrl), {
      method: options.method ?? 'POST',
      headers: options.headers ?? { 'content-type': 'application/json' },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end(options.body)
  })
}

/** 客户端请求体：合法信封。 */
function envelope(rpcId, method, payload) {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload })
}

/** 假 connection：只提供鉴权判定，rejection 由用例拨动。 */
function createConnection(state) {
  return {
    requestRejection: () => state.rejection,
  }
}

/** 假 bridge：记录调用参数，默认回 ok 信封。 */
function createBridge(handler) {
  const calls = []
  const bridge = {
    calls,
    async handle(endpoint, payload, signal) {
      calls.push({ endpoint, payload, signal })
      if (typeof handler === 'function') return await handler(endpoint, payload, signal)
      return { ok: true, value: { endpoint, payload } }
    },
  }
  return bridge
}

/** 起好 server 并返回断言常用件；t.after 里关 server。 */
async function mount(t, options = {}) {
  const state = { rejection: options.rejection }
  const bridge = createBridge(options.handler)
  const connection = options.connection ?? createConnection(state)
  const route = createPanelRoute({ channel: '/bigfish', bridge, connection, ...options.route })
  const server = await startRouteServer(route)
  t.after(server.close)
  return { route, bridge, state, connection, ...server }
}

test('channel / endpoint 解析与宿主 rpc-host 的规则一致', () => {
  assert.doesNotThrow(() => assertRpcChannel('/bigfish'))
  assert.throws(() => assertRpcChannel('/api'), /非法的 rpc channel/)
  assert.throws(() => assertRpcChannel('bigfish'), /非法的 rpc channel/)
  assert.throws(() => assertRpcChannel('/big fish'), /非法的 rpc channel/)

  assert.equal(endpointFromPath('/bigfish', '/bigfish/health'), 'health')
  assert.equal(endpointFromPath('/bigfish', '/bigfish/tasks.list'), 'tasks.list')
  assert.equal(endpointFromPath('/bigfish', '/bigfish/a/b'), 'a/b')
  assert.equal(endpointFromPath('/bigfish', '/bigfish'), undefined)
  assert.equal(endpointFromPath('/bigfish', '/bigfish/'), undefined)
  assert.equal(endpointFromPath('/bigfish', '/bigfish//health'), undefined)
  assert.equal(endpointFromPath('/bigfish', '/bigfish/health/'), undefined)
  assert.equal(endpointFromPath('/bigfish', '/bigfish/health%20x'), undefined)
  assert.equal(endpointFromPath('/bigfish', '/other/health'), undefined)
})

test('创建路由必须给鉴权入口（无鉴权不暴露 daemon 数据）', () => {
  const bridge = createBridge()
  assert.throws(
    () => createPanelRoute({ channel: '/bigfish', bridge, connection: {} }),
    /requestRejection/,
  )
  assert.throws(
    () => createPanelRoute({ channel: '/bigfish', bridge: undefined, connection: createConnection({}) }),
    /bridge\.handle/,
  )
})

test('鉴权拒绝：requestRejection 返回 401/403 时原样回，且不触达 bridge', async (t) => {
  const mounted = await mount(t)
  mounted.state.rejection = 401
  const unauthorized = await send(mounted.baseUrl, '/bigfish/health', { body: envelope('r1', 'health', {}) })
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.text, 'unauthorized')

  mounted.state.rejection = 403
  const forbidden = await send(mounted.baseUrl, '/bigfish/health', { body: envelope('r2', 'health', {}) })
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.text, 'forbidden')
  assert.equal(mounted.bridge.calls.length, 0)
})

test('合法信封：200 + server-response 回显 rpcId，payload 与 signal 透传给 bridge', async (t) => {
  const mounted = await mount(t)
  const response = await send(mounted.baseUrl, '/bigfish/health', {
    body: envelope('probe-1', 'health', { deep: true }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /application\/json/)
  const parsed = JSON.parse(response.text)
  assert.equal(parsed.type, 'server-response')
  assert.equal(parsed.rpcId, 'probe-1')
  assert.deepEqual(parsed.result, { ok: true, value: { endpoint: 'health', payload: { deep: true } } })
  assert.equal(mounted.bridge.calls.length, 1)
  assert.equal(mounted.bridge.calls[0].endpoint, 'health')
  assert.deepEqual(mounted.bridge.calls[0].payload, { deep: true })
  assert.ok(mounted.bridge.calls[0].signal instanceof AbortSignal)
})

test('非 POST / 裸前缀 / 空段 / 非法字符一律 404', async (t) => {
  const mounted = await mount(t)
  const cases = [
    { path: '/bigfish/health', options: { method: 'GET' } },
    { path: '/bigfish', options: { body: envelope('r1', 'health', {}) } },
    { path: '/bigfish/', options: { body: envelope('r1', 'health', {}) } },
    { path: '/bigfish//health', options: { body: envelope('r1', 'health', {}) } },
    { path: '/bigfish/health%20x', options: { body: envelope('r1', 'health', {}) } },
  ]
  for (const entry of cases) {
    const response = await send(mounted.baseUrl, entry.path, entry.options)
    assert.equal(response.status, 404, entry.path + ' 应该是 404')
    assert.equal(response.text, 'not found')
  }
  assert.equal(mounted.bridge.calls.length, 0)
})

test('content-type 必须是 application/json（允许带 charset）', async (t) => {
  const mounted = await mount(t)
  const textPlain = await send(mounted.baseUrl, '/bigfish/health', {
    headers: { 'content-type': 'text/plain' },
    body: envelope('r1', 'health', {}),
  })
  assert.equal(textPlain.status, 415)
  assert.equal(textPlain.text, 'content type must be application/json')

  const withCharset = await send(mounted.baseUrl, '/bigfish/health', {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: envelope('r2', 'health', {}),
  })
  assert.equal(withCharset.status, 200)
  assert.equal(JSON.parse(withCharset.text).rpcId, 'r2')
})

test('body 不是 JSON：400 body is not JSON', async (t) => {
  const mounted = await mount(t)
  const response = await send(mounted.baseUrl, '/bigfish/health', { body: '{oops' })
  assert.equal(response.status, 400)
  assert.equal(response.text, 'body is not JSON')
  assert.equal(mounted.bridge.calls.length, 0)
})

test('信封不合法：200 + gateway/bad-request，rpcId 回显或 invalid-request', async (t) => {
  const mounted = await mount(t)
  const cases = [
    { body: '{}', expectedRpcId: 'invalid-request' },
    { body: JSON.stringify({ type: 'client-request', rpcId: 42, method: 'health' }), expectedRpcId: 'invalid-request' },
    { body: JSON.stringify({ type: 'server-response', rpcId: 'r9', method: 'health' }), expectedRpcId: 'r9' },
    { body: JSON.stringify({ type: 'client-request', method: 'health' }), expectedRpcId: 'invalid-request' },
  ]
  for (const entry of cases) {
    const response = await send(mounted.baseUrl, '/bigfish/health', { body: entry.body })
    assert.equal(response.status, 200)
    const parsed = JSON.parse(response.text)
    assert.equal(parsed.type, 'server-response')
    assert.equal(parsed.rpcId, entry.expectedRpcId)
    assert.equal(parsed.result.ok, false)
    assert.equal(parsed.result.error.code, 'gateway/bad-request')
    assert.equal(parsed.result.error.message, 'invalid client-request message')
    assert.deepEqual(parsed.result.error.details, { issues: [] })
  }
  assert.equal(mounted.bridge.calls.length, 0)
})

test('method 与 endpoint 不匹配：200 + 错误信封，不调 bridge', async (t) => {
  const mounted = await mount(t)
  const response = await send(mounted.baseUrl, '/bigfish/health', {
    body: envelope('r3', 'status', {}),
  })
  assert.equal(response.status, 200)
  const parsed = JSON.parse(response.text)
  assert.equal(parsed.rpcId, 'r3')
  assert.equal(parsed.result.ok, false)
  assert.equal(parsed.result.error.code, 'gateway/bad-request')
  assert.equal(parsed.result.error.message, 'method "status" does not match endpoint "health"')
  assert.equal(mounted.bridge.calls.length, 0)
})

test('bridge 抛错：500 handler failure，错误交给 onInternalError 记录', async (t) => {
  const seen = []
  const mounted = await mount(t, {
    handler: () => {
      throw new Error('boom')
    },
    route: { onInternalError: (error) => seen.push(error) },
  })
  const response = await send(mounted.baseUrl, '/bigfish/health', { body: envelope('r4', 'health', {}) })
  assert.equal(response.status, 500)
  assert.match(response.text, /handler failure: boom/)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].message, 'boom')
})

test('请求体超限：413 且不调 bridge', async (t) => {
  const mounted = await mount(t, { route: { maxRequestBodyBytes: 64 } })
  const response = await send(mounted.baseUrl, '/bigfish/health', { body: envelope('r5', 'health', { big: 'x'.repeat(200) }) })
  assert.equal(response.status, 413)
  assert.equal(response.text, 'payload too large')
  assert.equal(mounted.bridge.calls.length, 0)
})

test('客户端提前断开：bridge 的 signal 被 abort（不泄漏挂起请求）', async (t) => {
  let observed
  const mounted = await mount(t, {
    handler: (endpoint, payload, signal) => new Promise((resolve) => {
      observed = signal
      signal.addEventListener('abort', () => resolve({ ok: true, value: { aborted: true } }), { once: true })
    }),
  })
  const request = httpRequest(new URL('/bigfish/health', mounted.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  request.on('error', () => {})
  request.end(envelope('r6', 'health', {}))
  const started = Date.now()
  while (observed === undefined && Date.now() - started < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(observed instanceof AbortSignal, 'bridge 应收到 AbortSignal')
  request.destroy()
  const abortStarted = Date.now()
  while (!observed.aborted && Date.now() - abortStarted < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(observed.aborted, true)
})
