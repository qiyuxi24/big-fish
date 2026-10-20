import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../src/tools.js'
import { createFakeClient } from './helpers.mjs'
import { DaemonError } from '../src/client.js'

const config = { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' }

function findTool(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `缺少工具 ${name}`)
  return tool
}

test('注册 7 个 xy_ 工具，schema 形态合法', () => {
  const tools = buildTools({ client: createFakeClient({}), config })
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'xy_daemon_health', 'xy_items_list', 'xy_ping', 'xy_status',
    'xy_task_action', 'xy_task_enqueue', 'xy_tasks_list',
  ])
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.schema.type, 'object')
    assert.ok(tool.timeoutMs > 0)
  }
  const enqueue = findTool(tools, 'xy_task_enqueue')
  assert.deepEqual(enqueue.parameters.required, ['kind', 'dedupeKey'])
  assert.deepEqual(findTool(tools, 'xy_task_action').parameters.properties.action.enum, ['ack', 'fail', 'release'])
})

test('xy_status 把队列与熔断渲染成人话', async () => {
  const client = createFakeClient({
    status: {
      version: '0.1.0', uptimeMs: 65_000, pid: 7,
      queue: { queued: 2, leased: 1, done: 5, failed: 1, needs_review: 0 },
      accounts: ['acc-1'], circuits: { 'acc-2': 'RGV587' },
    },
  })
  const tool = findTool(buildTools({ client, config }), 'xy_status')
  const value = await tool.execute({}, {})
  assert.match(value.text, /queued=2/)
  assert.match(value.text, /acc-2\(RGV587\)/)
  assert.match(value.text, /65s/)
})

test('xy_tasks_list 无任务与有任务两种文案', async () => {
  const empty = findTool(buildTools({ client: createFakeClient({ listTasks: [] }), config }), 'xy_tasks_list')
  assert.match((await empty.execute({}, {})).text, /没有符合条件/)

  const task = {
    id: '0123456789abcdef', kind: 'publish', state: 'queued', attempts: 1, maxAttempts: 3,
    dedupeKey: 'publish:draft-1', lastError: 'RGV587', payload: {}, availableAt: 0, createdAt: 0, updatedAt: 0,
  }
  const client = createFakeClient({ listTasks: [task] })
  const value = await findTool(buildTools({ client, config }), 'xy_tasks_list').execute({ state: 'queued' }, {})
  assert.match(value.text, /publish \| queued \| attempt 1\/3/)
  assert.deepEqual(client.calls.at(-1).args[0], { state: 'queued', kind: undefined, limit: 20 })
})

test('xy_task_enqueue 传递 kind/dedupeKey/payload 并忽略未给的字段', async () => {
  const client = createFakeClient({
    enqueue: (input) => ({ id: 'abcdef0123456789', kind: input.kind, state: 'queued', attempts: 0, maxAttempts: 3, dedupeKey: input.dedupeKey, payload: input.payload, availableAt: 0, createdAt: 0, updatedAt: 0 }),
  })
  const tool = findTool(buildTools({ client, config }), 'xy_task_enqueue')
  await tool.execute({ kind: 'publish', dedupeKey: 'publish:draft-1' }, {})
  const input = client.calls.at(-1).args[0]
  assert.deepEqual(input, { kind: 'publish', dedupeKey: 'publish:draft-1', payload: {} })
  assert.equal(Object.hasOwn(input, 'availableAt'), false)
})

test('xy_task_action 默认 owner，并透传 nonRetryable', async () => {
  const client = createFakeClient({
    taskAction: (_id, _action, body) => ({ id: 'x', kind: 'publish', state: 'failed', attempts: 3, maxAttempts: 3, dedupeKey: 'k', payload: {}, availableAt: 0, createdAt: 0, updatedAt: 0, lastError: body.error }),
  })
  const tool = findTool(buildTools({ client, config, owner: 'host-x' }), 'xy_task_action')
  await tool.execute({ id: 'x', action: 'fail', error: 'boom' }, {})
  const [id, action, body] = client.calls.at(-1).args
  assert.equal(id, 'x')
  assert.equal(action, 'fail')
  assert.deepEqual(body, { owner: 'host-x', error: 'boom' })
})

test('DaemonError 变成模型可读文本而不是抛错', async () => {
  const client = createFakeClient({ status: new DaemonError('NETWORK', '连不上 daemon：http://127.0.0.1:47001', { retryable: true }) })
  const value = await findTool(buildTools({ client, config }), 'xy_status').execute({}, {})
  assert.match(value.text, /\[NETWORK\]/)
  assert.match(value.text, /可稍后重试/)
})

test('xy_ping 汇总健康与鉴权两段结论', async () => {
  const client = createFakeClient({
    health: { version: '1.0.0', uptimeMs: 2000, pid: 9 },
    status: { version: '1.0.0', uptimeMs: 2000, pid: 9, queue: { queued: 0 }, accounts: [], circuits: {} },
  })
  const value = await findTool(buildTools({ client, config }), 'xy_ping').execute({}, {})
  assert.match(value.text, /health: OK/)
  assert.match(value.text, /auth: OK/)
})

test('输出 schema 与 render 一致：render 读 value.text', () => {
  const tool = findTool(buildTools({ client: createFakeClient({}), config }), 'xy_status')
  assert.deepEqual(tool.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }])
})
