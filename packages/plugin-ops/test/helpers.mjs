/**
 * 测试替身：假 Cordis ctx、假 daemon 客户端、临时 HTTP 服务。
 * @module @bigfish/plugin-ops/test/helpers
 */
import { createServer } from 'node:http'

/** 假 ctx：记录 register 的工具与 on 注册的监听器。 */
export function createFakeCtx() {
  const tools = []
  const listeners = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    get(name) {
      if (name === 'launchEnvironment') return { get: () => undefined }
      return undefined
    },
  }
  return { ctx, tools, listeners }
}

/** 假客户端：所有方法返回注入的固定数据或抛出注入的错误。 */
export function createFakeClient(overrides = {}) {
  const calls = []
  const record = (method) => async (...args) => {
    calls.push({ method, args })
    const impl = overrides[method]
    if (typeof impl === 'function') return impl(...args)
    if (impl instanceof Error) throw impl
    return impl
  }
  return {
    calls,
    health: record('health'),
    status: record('status'),
    listTasks: record('listTasks'),
    enqueue: record('enqueue'),
    taskAction: record('taskAction'),
    request: record('request'),
    listItems: record('listItems'),
    listAccounts: record('listAccounts'),
    importAccount: record('importAccount'),
    collectReferences: record('collectReferences'),
  }
}

/**
 * 启一个最小 HTTP 服务，按 pathname 返回预设响应。
 * @param {Record<string, {status?: number, body: unknown, headers?: Record<string,string>, hang?: boolean}>} routes
 */
export async function startStubServer(routes) {
  const server = createServer((req, res) => {
    const route = routes[new URL(req.url ?? '/', 'http://localhost').pathname]
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'VALIDATION', message: 'not found', retryable: false } }))
      return
    }
    if (route.hang) return // 不响应，用来触发客户端超时
    res.writeHead(route.status ?? 200, { 'content-type': 'application/json', ...route.headers })
    res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = /** @type {{port: number}} */ (server.address())
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}
