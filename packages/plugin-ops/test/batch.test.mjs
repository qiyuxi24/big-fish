import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../src/tools.js'
import {
  DEFAULT_MAX_ITEMS,
  DEFAULT_PUBLISH_MIN_INTERVAL_MS,
  MAX_ITEMS_LIMIT,
  formatBatchResult,
  normalizeBatchArgs,
  prepareBatch,
} from '../src/batch.js'
import { draftDedupeKey, validatePublishDraft } from '../src/draft.js'
import { DaemonError } from '../src/client.js'
import { createFakeClient } from './helpers.mjs'

// 让默认 pacing 可预测：测试进程不继承外部配置（显式用例会自己传 minIntervalMs）。
delete process.env.BF_PUBLISH_MIN_INTERVAL_MS

const config = { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' }
const validDraft = { title: '测试商品', desc: '描述 A', priceCents: 1990, images: ['D:\\pics\\a.png'] }
const otherDraft = { title: '另一个商品', desc: '描述 B', priceCents: 2990, images: ['/abs/b.png'] }
const thirdDraft = { title: '第三个商品', desc: '描述 C', priceCents: 3990, images: ['/abs/c.png'] }

function keyOf(draft) {
  return draftDedupeKey(validatePublishDraft(draft))
}

function makeTool(deps = {}) {
  const client = deps.client ?? createFakeClient({})
  const tools = buildTools({ client, config, ...deps })
  const spec = tools.find((candidate) => candidate.definition.name === 'xy_publish_batch')
  assert.ok(spec, '缺少工具 xy_publish_batch')
  return { client, tool: spec.definition }
}

/** 假 enqueue：原样回显入队体，模拟 daemon 的 201 + TaskRecord。 */
const echoEnqueue = (input) => ({
  id: 'abcdef0123456789', kind: input.kind, state: 'queued', attempts: 0, maxAttempts: 3,
  dedupeKey: input.dedupeKey, payload: input.payload, availableAt: 0, createdAt: 0, updatedAt: 0,
})

test('xy_publish_batch 默认 dry-run：逐条计划表，完全不碰 daemon', async () => {
  const { client, tool } = makeTool({})
  const value = await tool.execute({ drafts: [validDraft, { ...validDraft, priceCents: -1 }, { ...validDraft }] }, {})
  const text = value.text
  assert.match(text, /批量发布计划：dry-run/)
  assert.match(text, /共 3 条/)
  assert.match(text, /#1 \[plan\] drafts\[0\] key=publish:[0-9a-f]{8} 标题=测试商品 价格=¥19.90/)
  assert.match(text, /#2 \[invalid\] drafts\[1\]：\[VALIDATION\] 草稿的 priceCents 必须是正整数/)
  assert.match(text, /#3 \[skipped-duplicate\] drafts\[2\]/)
  assert.match(text, /与第 1 条幂等键相同/)
  assert.ok(text.includes('合计：可入队 1 / 批内重复 1 / 非法 1'))
  assert.match(text, /BF_PUBLISH_SUBMIT=1/)
  assert.equal(client.calls.length, 0, 'dry-run 不应调 daemon 任何接口')
})

test('xy_publish_batch 单条非法不拖垮整批：内联 + 文件路径混合', async () => {
  const files = { 'ok.json': JSON.stringify(otherDraft), 'bad.json': '{not json' }
  const readDraftFile = async (path) => {
    if (!(path in files)) throw new Error('ENOENT')
    return files[path]
  }
  const { client, tool } = makeTool({ readDraftFile })
  const value = await tool.execute({
    drafts: [validDraft, '不是对象'],
    draftPaths: ['ok.json', 'bad.json', 'missing.json'],
  }, {})
  const text = value.text
  assert.match(text, /共 5 条/)
  assert.match(text, /#1 \[plan\] drafts\[0\]/)
  assert.match(text, /#2 \[invalid\] drafts\[1\]：\[VALIDATION\] 草稿必须是 JSON 对象/)
  assert.match(text, /#3 \[plan\] draftPaths\[0\] key=publish:[0-9a-f]{8} 标题=另一个商品/)
  assert.match(text, /#4 \[invalid\] draftPaths\[1\].*合法 JSON/)
  assert.match(text, /#5 \[invalid\] draftPaths\[2\].*读不到草稿文件/)
  assert.ok(text.includes('合计：可入队 2 / 批内重复 0 / 非法 3'))
  assert.equal(client.calls.length, 0)
})

test('prepareBatch：幂等键按草稿内容生成，批内重复标 skipped-duplicate', async () => {
  const plan = await prepareBatch({ drafts: [validDraft, { ...validDraft }] })
  assert.equal(plan.mode, 'dry-run')
  assert.equal(plan.items.length, 2)
  assert.equal(plan.items[0].dedupeKey, keyOf(validDraft))
  assert.equal(plan.items[0].status, 'ok')
  assert.equal(plan.items[1].status, 'skipped-duplicate')
  assert.equal(plan.items[1].duplicateOf, 1)
  // 改价格就是另一份草稿，不能复用幂等键。
  const changed = await prepareBatch({ drafts: [validDraft, { ...validDraft, priceCents: 2090 }] })
  assert.equal(changed.items[1].status, 'ok')
  assert.notEqual(changed.items[1].dedupeKey, changed.items[0].dedupeKey)
})

test('enqueue：逐条调 daemon 入队，payload 与幂等键按单条口径，汇总入队/跳过', async () => {
  const { client, tool } = makeTool({ client: createFakeClient({ enqueue: echoEnqueue }) })
  const value = await tool.execute({ drafts: [validDraft, otherDraft, { ...validDraft }], mode: 'enqueue', accountId: 'acc-1' }, {})
  const text = value.text
  const enqueues = client.calls.filter((call) => call.method === 'enqueue')
  assert.equal(enqueues.length, 2, '批内重复的第三条不应重复入队')
  const firstInput = enqueues[0].args[0]
  assert.equal(firstInput.kind, 'publish')
  assert.equal(firstInput.dedupeKey, keyOf(validDraft))
  assert.deepEqual(firstInput.payload, { accountId: 'acc-1', title: '测试商品', desc: '描述 A', priceCents: 1990, images: ['D:\\pics\\a.png'] })
  // enqueue 入队体带账号级预约时间（availableAt），同账号第二条自动错开一个最小间隔。
  assert.equal(Number.isSafeInteger(firstInput.availableAt), true)
  const secondInput = enqueues[1].args[0]
  assert.equal(secondInput.kind, 'publish')
  assert.equal(secondInput.dedupeKey, keyOf(otherDraft))
  assert.deepEqual(secondInput.payload, { accountId: 'acc-1', title: '另一个商品', desc: '描述 B', priceCents: 2990, images: ['/abs/b.png'] })
  assert.equal(secondInput.availableAt, firstInput.availableAt + DEFAULT_PUBLISH_MIN_INTERVAL_MS)
  assert.match(text, /#1 \[queued\] drafts\[0\].*task=abcdef01…/)
  assert.match(text, /#3 \[skipped-duplicate\]/)
  assert.ok(text.includes('合计：新入队 2 / 已在队列 0 / 批内重复 1 / 非法 0 / 失败 0'))
  assert.match(text, /下一步：xy_tasks_list/)
  assert.match(text, /BF_PUBLISH_SUBMIT=1/)
  assert.equal(client.calls.some((call) => call.method === 'health'), false)
})

test('enqueue：category 有值才入 payload，未知字段不泄漏', async () => {
  const { client, tool } = makeTool({ client: createFakeClient({ enqueue: echoEnqueue }) })
  await tool.execute({
    drafts: [{ ...validDraft, category: '电子资料', 未知字段: 'x' }],
    mode: 'enqueue', accountId: 'acc-1',
  }, {})
  const input = client.calls.at(-1).args[0]
  assert.equal(input.payload.category, '电子资料')
  assert.equal(Object.hasOwn(input.payload, '未知字段'), false)
  await tool.execute({ drafts: [otherDraft], mode: 'enqueue', accountId: 'acc-1' }, {})
  assert.equal(Object.hasOwn(client.calls.at(-1).args[0].payload, 'category'), false)
})

test('enqueue：address/shipping 一起入 payload（daemon 执行队列任务时读不到草稿文件）', async () => {
  const { client, tool } = makeTool({ client: createFakeClient({ enqueue: echoEnqueue }) })
  await tool.execute({
    drafts: [{ ...validDraft, address: '西北工业大学长安校区星天苑', shipping: 'free' }],
    mode: 'enqueue', accountId: 'acc-1',
  }, {})
  const payload = client.calls.at(-1).args[0].payload
  assert.equal(payload.address, '西北工业大学长安校区星天苑')
  assert.equal(payload.shipping, 'free')
  await tool.execute({ drafts: [otherDraft], mode: 'enqueue', accountId: 'acc-1' }, {})
  const bare = client.calls.at(-1).args[0].payload
  assert.equal(Object.hasOwn(bare, 'address'), false)
  assert.equal(Object.hasOwn(bare, 'shipping'), false)
})

test('enqueue：单条缺 title / 带 quantity 标 invalid，不影响其他条目', async () => {
  const { client, tool } = makeTool({ client: createFakeClient({ enqueue: echoEnqueue }) })
  const value = await tool.execute({
    drafts: [validDraft, { title: '', desc: '无标题', priceCents: 100, images: ['/abs/x.png'] }, { ...otherDraft, quantity: 2 }],
    mode: 'enqueue', accountId: 'acc-1',
  }, {})
  const text = value.text
  assert.match(text, /#2 \[invalid\].*title 非空/)
  assert.match(text, /#3 \[invalid\].*quantity/)
  assert.ok(text.includes('合计：新入队 1 / 已在队列 0 / 批内重复 0 / 非法 2 / 失败 0'))
  assert.equal(client.calls.filter((call) => call.method === 'enqueue').length, 1)
})

test('enqueue：单条 daemon 错误标 failed，其余条目继续入队', async () => {
  const client = createFakeClient({
    enqueue: (input) => {
      if (input.payload.title === '测试商品') throw new DaemonError('STORAGE', '本地队列写入失败')
      return echoEnqueue(input)
    },
  })
  const { tool } = makeTool({ client })
  const value = await tool.execute({
    drafts: [validDraft, otherDraft, thirdDraft], mode: 'enqueue', accountId: 'acc-1',
  }, {})
  const text = value.text
  assert.match(text, /#1 \[failed\].*\[STORAGE\] 本地队列写入失败/)
  assert.match(text, /#2 \[queued\]/)
  assert.match(text, /#3 \[queued\]/)
  assert.ok(text.includes('合计：新入队 2 / 已在队列 0 / 批内重复 0 / 非法 0 / 失败 1'))
})

test('enqueue：daemon 不可达时中止剩余条目，不把超时乘 N', async () => {
  const client = createFakeClient({
    enqueue: () => { throw new DaemonError('NETWORK', '连不上 daemon', { retryable: true }) },
  })
  const { tool } = makeTool({ client })
  const value = await tool.execute({
    drafts: [validDraft, otherDraft, thirdDraft], mode: 'enqueue', accountId: 'acc-1',
  }, {})
  const text = value.text
  assert.equal(client.calls.filter((call) => call.method === 'enqueue').length, 1)
  assert.match(text, /#1 \[failed\].*\[NETWORK\]/)
  assert.match(text, /#2 \[failed\].*未尝试/)
  assert.match(text, /#3 \[failed\].*未尝试/)
  assert.ok(text.includes('合计：新入队 0 / 已在队列 0 / 批内重复 0 / 非法 0 / 失败 3'))
})

test('maxItems 截断：只处理前 N 条，并说明截断数量', async () => {
  const { client, tool } = makeTool({})
  const value = await tool.execute({ drafts: [validDraft, otherDraft, thirdDraft], maxItems: 2 }, {})
  const text = value.text
  assert.match(text, /共 3 条（按 maxItems 截断 1 条，本批只处理前 2 条）/)
  assert.match(text, /#1 \[plan\]/)
  assert.match(text, /#2 \[plan\]/)
  assert.equal(text.includes('#3 '), false)
  assert.equal(client.calls.length, 0)
})

test('参数校验：缺来源 / 类型错 / mode 非法 / maxItems 越界都是 VALIDATION', async () => {
  const { client, tool } = makeTool({})
  const empty = await tool.execute({}, {})
  assert.match(empty.text, /\[VALIDATION\]/)
  assert.match(empty.text, /至少/)
  const emptyArrays = await tool.execute({ drafts: [], draftPaths: [] }, {})
  assert.match(emptyArrays.text, /\[VALIDATION\]/)
  const badMode = await tool.execute({ drafts: [validDraft], mode: 'go' }, {})
  assert.match(badMode.text, /mode 只能是/)
  const badDrafts = await tool.execute({ drafts: 'x' }, {})
  assert.match(badDrafts.text, /drafts 必须是数组/)
  const badPaths = await tool.execute({ draftPaths: [42] }, {})
  assert.match(badPaths.text, /draftPaths\[0\]/)
  const badMax = await tool.execute({ drafts: [validDraft], maxItems: MAX_ITEMS_LIMIT + 1 }, {})
  assert.match(badMax.text, /maxItems 必须是 1\.\.20/)
  assert.equal(client.calls.length, 0)
})

test('normalizeBatchArgs：默认值与上限', () => {
  const normalized = normalizeBatchArgs({ drafts: [validDraft] })
  assert.equal(normalized.mode, 'dry-run')
  assert.equal(normalized.maxItems, DEFAULT_MAX_ITEMS)
  assert.equal(normalized.accountId, undefined)
  assert.equal(DEFAULT_MAX_ITEMS, MAX_ITEMS_LIMIT)
  assert.equal(normalizeBatchArgs({ draftPaths: ['a.json'], mode: 'enqueue', accountId: 'acc' }).mode, 'enqueue')
  assert.throws(() => normalizeBatchArgs({ draftPaths: ['a.json'], mode: 'enqueue' }), /accountId/)
  assert.throws(() => normalizeBatchArgs(null), /参数必须是对象/)
})

test('formatBatchResult：全非法批次仍给出汇总而不是空输出', async () => {
  const plan = await prepareBatch({ drafts: [{ desc: '缺价格', images: ['/abs/a.png'] }] })
  const text = formatBatchResult(plan)
  assert.match(text, /#1 \[invalid\]/)
  assert.ok(text.includes('合计：可入队 0 / 批内重复 0 / 非法 1'))
})
