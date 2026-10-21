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

test('注册 14 个 xy_ 工具，schema 形态合法', () => {
  const tools = buildTools({ client: createFakeClient({}), config })
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'xy_accounts_list', 'xy_copy_plan', 'xy_daemon_health', 'xy_import_account', 'xy_items_list', 'xy_ping',
    'xy_publish_batch', 'xy_publish_draft', 'xy_reference_collect', 'xy_status', 'xy_task_action',
    'xy_task_enqueue', 'xy_task_retry', 'xy_tasks_list',
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
  const batch = findTool(tools, 'xy_publish_batch')
  assert.deepEqual(batch.parameters.properties.mode.enum, ['dry-run', 'enqueue'])
  assert.deepEqual(batch.parameters.anyOf, [{ required: ['drafts'] }, { required: ['draftPaths'] }])
  assert.equal(batch.parameters.properties.maxItems.maximum, 20)
  // 批量最多 20 条串行入队，单条 daemon 超时 15s，工具总超时必须比单条工具宽。
  assert.ok(batch.timeoutMs > 25_000)
})

test('xy_accounts_list 空库/可用/损坏三种文案', async () => {
  const empty = findTool(buildTools({ client: createFakeClient({ listAccounts: [] }), config }), 'xy_accounts_list')
  assert.match((await empty.execute({}, {})).text, /还没有可用账号/)
  assert.match((await empty.execute({}, {})).text, /xy_import_account/)

  const accounts = [
    { accountId: '2206569289277', updatedAt: 1_700_000_000_000, savedFieldCount: 18, ready: true, unb: '2206569289277', ageMs: 120_000 },
    { accountId: 'legacy', updatedAt: 1_700_000_000_000, savedFieldCount: 2, ready: false, ageMs: 3 * 3600_000 },
    { accountId: 'broken-one', updatedAt: 0, savedFieldCount: 0, ready: false, ageMs: 0, broken: true, brokenReason: '凭据文件无法读取或解密（STORAGE）' },
  ]
  const tool = findTool(buildTools({ client: createFakeClient({ listAccounts: accounts }), config }), 'xy_accounts_list')
  const text = (await tool.execute({}, {})).text
  assert.match(text, /共 3 个账号/)
  assert.match(text, /2206569289277 \| ✅ 可写/)
  assert.match(text, /2 分钟前/)
  assert.match(text, /legacy \| ⚠️ 不可写/)
  assert.match(text, /3 小时前/)
  assert.match(text, /broken-one \| ❌ 凭据损坏/)
  assert.match(text, /AUTH_EXPIRED/)
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

test('xy_task_retry 走 POST /tasks/:id/retry，参数与返回文案可读', async () => {
  const client = createFakeClient({
    request: () => ({ id: 'abcdef0123456789', kind: 'publish', state: 'queued', attempts: 0, maxAttempts: 3, dedupeKey: 'k', payload: {}, availableAt: 0, createdAt: 0, updatedAt: 0 }),
  })
  const tool = findTool(buildTools({ client, config }), 'xy_task_retry')
  assert.deepEqual(tool.parameters.required, ['taskId'])
  const value = await tool.execute({ taskId: 'abc/def' }, {})
  const [pathname, init] = client.calls.at(-1).args
  assert.equal(client.calls.at(-1).method, 'request')
  assert.equal(pathname, '/tasks/abc%2Fdef/retry')
  assert.equal(init.method, 'POST')
  assert.match(value.text, /已重新排队：abcdef01… \| publish \| queued/)
})

test('xy_task_action 撞 VALIDATION 时提示改走 xy_task_retry', async () => {
  const client = createFakeClient({ taskAction: new DaemonError('VALIDATION', '任务未被 owner 持有') })
  const tool = findTool(buildTools({ client, config }), 'xy_task_action')
  const value = await tool.execute({ id: 'x', action: 'release' }, {})
  assert.match(value.text, /\[VALIDATION\]/)
  assert.match(value.text, /xy_task_retry/)
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
/** 发布草稿样例：价格是整数分、图片是 Windows 绝对路径。 */
const validDraft = { title: '测试商品', desc: '这是一段描述', priceCents: 1990, images: ['D:\\pics\\a.png'] }

test('xy_import_account 调 daemon 导入并渲染摘要', async () => {
  const client = createFakeClient({
    importAccount: () => ({ accountId: 'acc-9', savedFieldCount: 12, updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5), source: 'chrome-cdp' }),
  })
  const tool = findTool(buildTools({ client, config }), 'xy_import_account')
  const value = await tool.execute({ accountId: 'acc-9', port: 9333 }, {})
  assert.match(value.text, /已导入账号 acc-9/)
  assert.match(value.text, /12 条登录态字段/)
  assert.match(value.text, /2026-01-02/)
  assert.deepEqual(client.calls.at(-1).args[0], { accountId: 'acc-9', port: 9333 })
})

test('xy_import_account 对结构异常的 daemon 返回报 INTERNAL', async () => {
  const client = createFakeClient({ importAccount: () => ({ savedFieldCount: 'x' }) })
  const value = await findTool(buildTools({ client, config }), 'xy_import_account').execute({}, {})
  assert.match(value.text, /\[INTERNAL\]/)
  assert.match(value.text, /accountId/)
})

test('xy_publish_draft 默认 dry-run：只给命令，不写队列', async () => {
  const client = createFakeClient({ health: { version: '1.2.3', pid: 1, uptimeMs: 5 } })
  const tool = findTool(buildTools({ client, config, readDraftFile: async () => JSON.stringify(validDraft) }), 'xy_publish_draft')
  const value = await tool.execute({ draftPath: 'C:/tmp/draft.json', screenshotsDir: 'C:/tmp/shots' }, {})
  assert.match(value.text, /dry-run/)
  assert.match(value.text, /npm run daemon:publish -- --draft C:\/tmp\/draft.json --screenshots C:\/tmp\/shots/)
  assert.match(value.text, /不点提交/)
  assert.match(value.text, /daemon：在线/)
  assert.equal(client.calls.some((call) => call.method === 'enqueue'), false)
})

test('xy_publish_draft enqueue：带 accountId 入队并按内容生成幂等键', async () => {
  const client = createFakeClient({
    enqueue: (input) => ({ id: 'abcdef0123456789', kind: input.kind, state: 'queued', attempts: 0, maxAttempts: 3,
      dedupeKey: input.dedupeKey, payload: input.payload, availableAt: 0, createdAt: 0, updatedAt: 0 }),
  })
  const tool = findTool(buildTools({ client, config, readDraftFile: async () => JSON.stringify(validDraft) }), 'xy_publish_draft')
  const value = await tool.execute({ draftPath: 'C:/tmp/draft.json', mode: 'enqueue', accountId: 'acc-1' }, {})
  const input = client.calls.at(-1).args[0]
  assert.equal(input.kind, 'publish')
  assert.match(input.dedupeKey, /^publish:[0-9a-f]{8}$/)
  assert.deepEqual(input.payload, {
    accountId: 'acc-1', title: '测试商品', desc: '这是一段描述', priceCents: 1990, images: ['D:\\pics\\a.png'],
  })
  assert.match(value.text, /已入队/)
  assert.match(value.text, /BF_PUBLISH_SUBMIT=1/)
})

test('xy_publish_draft 入队前挡住缺 accountId / quantity / 非法 JSON', async () => {
  const client = createFakeClient({})
  const toolFor = (text) => findTool(buildTools({ client, config, readDraftFile: async () => text }), 'xy_publish_draft')
  const missingAccount = await toolFor(JSON.stringify(validDraft)).execute({ draftPath: 'a.json', mode: 'enqueue' }, {})
  assert.match(missingAccount.text, /accountId/)
  const withQuantity = await toolFor(JSON.stringify({ ...validDraft, quantity: 2 }))
    .execute({ draftPath: 'a.json', mode: 'enqueue', accountId: 'acc-1' }, {})
  assert.match(withQuantity.text, /quantity/)
  const broken = await toolFor('{not json').execute({ draftPath: 'a.json' }, {})
  assert.match(broken.text, /合法 JSON/)
})

test('xy_publish_batch 走 dry-run 计划表，不调 daemon', async () => {
  const client = createFakeClient({})
  const tool = findTool(buildTools({ client, config }), 'xy_publish_batch')
  const value = await tool.execute({ drafts: [validDraft, { ...validDraft }] }, {})
  assert.match(value.text, /批量发布计划：dry-run/)
  assert.match(value.text, /#2 \[skipped-duplicate\]/)
  assert.equal(client.calls.length, 0)
})

test('xy_copy_plan 给出注入后的提示词，且完全不碰 daemon', async () => {
  const client = createFakeClient({})
  const tool = findTool(buildTools({ client, config }), 'xy_copy_plan')
  const value = await tool.execute({
    styleId: 'warm', productName: '索尼 WH-1000XM4', condition: 'light-wear', priceYuan: '650',
  }, {})
  assert.match(value.text, /亲切安利/)
  assert.match(value.text, /"priceCents": 65000/)
  assert.match(value.text, /"tone": "warm"/)
  assert.match(value.text, /【待补】imagePaths/)
  assert.equal(client.calls.length, 0)
})

test('xy_reference_collect 渲染只读统计，不出现图片直链', async () => {
  const report = {
    accountId: 'acc-1',
    items: [{ itemId: '1' }, { itemId: '2' }],
    summary: {
      count: 2,
      priceCents: { min: 1500, median: 4200, max: 6900, avg: 4200 },
      titleLength: { min: 8, max: 12, avg: 10 },
      imageCountAvg: 2.5,
      descRatio: 0.5,
      categories: [{ categoryId: 50023914, count: 2 }],
      keywords: [{ word: '机械键盘', count: 2 }, { word: '九成新', count: 1 }],
    },
    seller: { sellerId: '7', displayName: '某商家', city: '西安', itemCount: 12 },
    sellers: [{ sellerId: '7' }],
    skipped: ['3'],
  }
  const client = createFakeClient({ collectReferences: () => report })
  const tool = findTool(buildTools({ client, config }), 'xy_reference_collect')
  assert.equal(tool.parameters.properties.itemIds.maxItems, 20)
  assert.deepEqual(tool.parameters.anyOf, [{ required: ['itemIds'] }, { required: ['sellerId'] }])
  const value = await tool.execute({ accountId: 'acc-1', itemIds: ['1', '2'] }, {})
  assert.match(value.text, /参考分析：2 件/)
  assert.match(value.text, /¥15\.00 ~ ¥69\.00/)
  assert.match(value.text, /中位 ¥42\.00/)
  assert.match(value.text, /图片均 2\.5 张/)
  assert.match(value.text, /有描述占 50%/)
  assert.match(value.text, /50023914 ×2/)
  assert.match(value.text, /机械键盘\(2\)/)
  assert.match(value.text, /某商家 · 西安 · 在售 12 件/)
  assert.match(value.text, /1 件读取失败已跳过/)
  assert.match(value.text, /不下载他人图片/)
  assert.equal(/https?:\/\//.test(value.text), false)
  assert.deepEqual(client.calls.at(-1).args[0], { accountId: 'acc-1', itemIds: ['1', '2'] })
})

test('xy_reference_collect 对缺少 summary 的返回报 INTERNAL', async () => {
  const client = createFakeClient({ collectReferences: () => ({ items: [] }) })
  const tool = findTool(buildTools({ client, config }), 'xy_reference_collect')
  const value = await tool.execute({ accountId: 'acc-1', sellerId: '7' }, {})
  assert.match(value.text, /\[INTERNAL\]/)
  assert.match(value.text, /summary/)
})

test('xy_copy_plan 参数非法时给 VALIDATION 文本而不是抛错', async () => {
  const tool = findTool(buildTools({ client: createFakeClient({}), config }), 'xy_copy_plan')
  const value = await tool.execute({ productName: 'x', condition: 'mint', priceYuan: '10' }, {})
  assert.match(value.text, /\[VALIDATION\]/)
  assert.match(value.text, /成色/)
})
