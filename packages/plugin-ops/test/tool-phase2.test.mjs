/**
 * 阶段二回归：参数名归一 + fail loud、列表收敛、内联草稿、导航文本收敛。
 *
 * 只测 buildTools 产出的规格与公开导出，不碰 daemon / 文件 / 生成物；
 * 与 tools.test.mjs 一样走 createFakeClient，保持零依赖。
 * @module @bigfish/plugin-ops/test/tool-phase2
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../src/tools.js'
import { createFakeClient } from './helpers.mjs'
import { DaemonError } from '../src/client.js'
import { formatTaskLine, formatTaskListNextSteps } from '../src/tool-format.js'
import { requireString, requireEnum, readLimit, requireAnyOf } from '../src/tool-kit.js'

const config = { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' }

function toolOf(name, overrides = {}, extra = {}) {
  const spec = buildTools({ client: createFakeClient(overrides), config, ...extra })
    .find((candidate) => candidate.definition.name === name)
  assert.ok(spec, `缺少工具 ${name}`)
  return spec.definition
}

/** 一条合法草稿：价格是整数分、图片是 Windows 绝对路径。 */
const validDraft = { title: '阶段二测试商品', desc: '这是一段足够长的描述文本用于校验通过', priceCents: 1990, images: ['D:\\pics\\a.png'] }

// —— ① 参数名归一 + fail loud ——

test('xy_task_retry 同时接受 taskId 与 id，taskId 优先', async () => {
  const client = createFakeClient({ request: () => ({}) })
  const tool = buildTools({ client, config }).find(s => s.definition.name === 'xy_task_retry').definition
  assert.deepEqual(tool.parameters.anyOf, [{ required: ['taskId'] }, { required: ['id'] }])

  await tool.execute({ id: 'aced28d9' }, {})
  assert.equal(client.calls.at(-1).args[0], '/tasks/aced28d9/retry')
  await tool.execute({ taskId: 'task-1', id: 'ignored' }, {})
  assert.equal(client.calls.at(-1).args[0], '/tasks/task-1/retry')
  // 斜杠必须被编码，不能拼进路径分段。
  await tool.execute({ taskId: 'a/b' }, {})
  assert.equal(client.calls.at(-1).args[0], '/tasks/a%2Fb/retry')
})

test('xy_task_retry 缺参/非字符串/空串一律 VALIDATION，不再有静默空结果', async () => {
  const tool = toolOf('xy_task_retry')
  for (const args of [{}, { id: '' }, { id: '   ' }, { id: 42 }, { taskId: null }]) {
    const text = (await tool.execute(args, {})).text
    assert.match(text, /\[VALIDATION\]/, JSON.stringify(args))
    assert.doesNotMatch(text, /已重新排队/)
  }
})

test('formatTaskLine 空对象/缺字段返回人话，不拼四个空竖线', () => {
  assert.equal(formatTaskLine({}), '(未返回任务详情)')
  assert.equal(formatTaskLine(null), '(未返回任务详情)')
  assert.equal(formatTaskLine({ id: 'x', kind: 'publish' }), '(未返回任务详情)')
  // id/kind/state 齐全但 attempts 缺失时用 'attempt ?'，不吐 undefined。
  assert.equal(formatTaskLine({ id: 'x', kind: 'publish', state: 'queued' }), 'x | publish | queued | attempt ?')
  assert.doesNotMatch(formatTaskLine({}), /\|/)
})

test('其它工具缺必填参数直接 VALIDATION，绝不静默出空结果', async () => {
  const cases = [
    ['xy_task_enqueue', {}],
    ['xy_task_action', {}],
    ['xy_circuit_reset', {}],
    ['xy_reference_collect', {}],
    ['xy_publish_draft', {}],
  ]
  for (const [name, args] of cases) {
    const text = (await toolOf(name).execute(args, {})).text
    assert.match(text, /\[VALIDATION\]/, `${name} 缺参没有 fail loud`)
  }
})

test('tool-kit 的四个必填助手边界', () => {
  assert.equal(requireString({ a: 'x' }, ['a', 'b'], 'id'), 'x')
  assert.throws(() => requireString({}, ['a', 'b'], 'id'), (e) => e instanceof DaemonError && e.code === 'VALIDATION')
  assert.throws(() => requireString({ a: '  ' }, ['a'], 'id'), (e) => e instanceof DaemonError && e.code === 'VALIDATION')
  assert.equal(requireEnum({ k: 'probe' }, 'k', ['publish', 'probe']), 'probe')
  assert.throws(() => requireEnum({ k: 'x' }, 'k', ['publish']), (e) => e instanceof DaemonError && e.code === 'VALIDATION')
  assert.equal(readLimit({}, 10, 200), 10)
  assert.equal(readLimit({ limit: 5 }, 10, 200), 5)
  assert.throws(() => readLimit({ limit: 201 }, 10, 200), (e) => e instanceof DaemonError && e.code === 'VALIDATION')
  assert.throws(() => readLimit({ limit: 1.5 }, 10, 200), (e) => e instanceof DaemonError && e.code === 'VALIDATION')
  assert.doesNotThrow(() => requireAnyOf({ sellerId: '7' }, ['itemIds', 'sellerId']))
  assert.throws(() => requireAnyOf({ itemIds: [] }, ['itemIds', 'sellerId']), (e) => e instanceof DaemonError && e.code === 'VALIDATION')
})

// —— ② 列表收敛 ——

test('xy_tasks_list 默认 limit=10、xy_items_list 默认 limit=20，上限保留', async () => {
  const tasksClient = createFakeClient({ listTasks: [] })
  const tSpec = buildTools({ client: tasksClient, config }).find(s => s.definition.name === 'xy_tasks_list').definition
  await tSpec.execute({}, {})
  assert.equal(tasksClient.calls.find(c => c.method === 'listTasks').args[0].limit, 10)
  assert.equal(tSpec.parameters.properties.limit.maximum, 200)

  const itemsClient = createFakeClient({ listItems: [] })
  const iSpec = buildTools({ client: itemsClient, config }).find(s => s.definition.name === 'xy_items_list').definition
  await iSpec.execute({}, {})
  assert.equal(itemsClient.calls.find(c => c.method === 'listItems').args[0].limit, 20)
  assert.equal(iSpec.parameters.properties.limit.maximum, 500)
})

test('formatTaskListNextSteps 末尾最多一行、按需出现', () => {
  const base = (state, availableAt = 0) => ({ id: 'x', kind: 'publish', state, availableAt })
  assert.equal(formatTaskListNextSteps([base('queued'), base('done')]), '')
  const failed = formatTaskListNextSteps([base('failed')])
  assert.match(failed, /^\n提示：/)
  assert.match(failed, /xy_task_retry/)
  assert.equal((failed.match(/xy_task_/g) ?? []).length, 1)
  const stuck = formatTaskListNextSteps([base('leased', Date.now() - 1)])
  assert.match(stuck, /xy_task_action release/)
  const both = formatTaskListNextSteps([base('failed'), base('leased', 0)])
  assert.equal(both.split('\n').length, 2) // 一个前导 \n = 一行汇总，不是逐条
  assert.match(both, /；/)
})

test('xy_tasks_list 十条任务里导航文本只出现一次', async () => {
  const list = Array.from({ length: 10 }, (_, i) => ({
    id: 'id-' + String(i), kind: 'publish', state: i % 2 === 0 ? 'failed' : 'queued',
    attempts: 1, maxAttempts: 3, availableAt: 0,
  }))
  const tool = toolOf('xy_tasks_list', { listTasks: list })
  const text = (await tool.execute({}, {})).text
  assert.equal((text.match(/xy_task_retry/g) ?? []).length, 1)
  assert.match(text, /\n提示：failed\/needs_review 用 xy_task_retry 重放。$/)
})

// —— ③ xy_publish_draft 内联草稿 ——

test('xy_publish_draft 内联 draft 走 dry-run：与文件同一套校验，不写队列', async () => {
  const client = createFakeClient({ health: { version: '1.2.3', pid: 1, uptimeMs: 5 } })
  const spec = buildTools({ client, config, readDraftFile: async () => { throw new Error('不该读文件') } })
    .find(s => s.definition.name === 'xy_publish_draft').definition
  const value = await spec.execute({ draft: validDraft }, {})
  assert.match(value.text, /草稿：\(内联 draft\)/)
  assert.match(value.text, /模式：dry-run/)
  assert.match(value.text, /阶段二测试商品/)
  assert.match(value.text, /注意：内联草稿没有落盘/)
  // 占位路径进校准命令，但明确告知不能直接用。
  assert.match(value.text, /替换此路径/)
  assert.equal(client.calls.some(c => c.method === 'enqueue'), false)
  assert.doesNotMatch(value.text, /读不到草稿文件/)
})

test('xy_publish_draft 内联 draft 走 enqueue：正常入队并带 accountId', async () => {
  const client = createFakeClient({
    enqueue: (input) => ({ id: 'abcdef0123456789', kind: input.kind, state: 'queued', attempts: 0,
      maxAttempts: 3, dedupeKey: input.dedupeKey, payload: input.payload, availableAt: 0, createdAt: 0, updatedAt: 0 }),
  })
  const spec = buildTools({ client, config }).find(s => s.definition.name === 'xy_publish_draft').definition
  const value = await spec.execute({ draft: validDraft, mode: 'enqueue', accountId: 'acc-1' }, {})
  const input = client.calls.find(c => c.method === 'enqueue').args[0]
  assert.equal(input.kind, 'publish')
  assert.equal(input.payload.title, '阶段二测试商品')
  assert.equal(input.payload.priceCents, 1990)
  assert.match(value.text, /已入队/)
  assert.match(value.text, /注意：内联草稿没有落盘/)
})

test('draftPath 与 draft 都给时以 draftPath 为准', async () => {
  let readCount = 0
  const spec = buildTools({
    client: createFakeClient({ health: { version: '1', pid: 1, uptimeMs: 1 } }),
    config,
    readDraftFile: async () => { readCount += 1; return JSON.stringify({ ...validDraft, title: '来自文件的标题' }) },
  }).find(s => s.definition.name === 'xy_publish_draft').definition
  const value = await spec.execute({ draftPath: 'C:/tmp/draft.json', draft: { ...validDraft, title: '内联的标题' } }, {})
  assert.equal(readCount, 1)
  assert.match(value.text, /草稿：C:\/tmp\/draft.json/)
  assert.match(value.text, /来自文件的标题/)
  assert.doesNotMatch(value.text, /内联的标题/)
})

test('内联 draft 字段非法时 VALIDATION，且不说成读不到文件', async () => {
  const spec = buildTools({ client: createFakeClient({}), config })
    .find(s => s.definition.name === 'xy_publish_draft').definition
  const bad = await spec.execute({ draft: { title: 'x', desc: 'y', priceCents: 1.5, images: ['D:\\a.png'] } }, {})
  assert.match(bad.text, /\[VALIDATION\]/)
  assert.match(bad.text, /priceCents/)
  assert.doesNotMatch(bad.text, /读不到草稿文件/)
  const wrongType = await spec.execute({ draft: '不是对象' }, {})
  assert.match(wrongType.text, /draft 必须是草稿对象/)
  const emptyPath = await spec.execute({ draftPath: '   ' }, {})
  assert.match(emptyPath.text, /draftPath 不能是空字符串/)
  const bothMissing = await spec.execute({}, {})
  assert.match(bothMissing.text, /缺少草稿/)
})

// —— ④ 导航收敛 & 16 工具不变 ——

test('VALIDATION 错误提示里不再常驻 leased/release 话术', async () => {
  const { nextStepFor } = await import('../src/tool-format.js')
  const hint = nextStepFor('VALIDATION')
  assert.doesNotMatch(hint, /xy_task_action release/)
  assert.doesNotMatch(hint, /xy_task_retry/)
})

test('16 个工具名字/数量/access 分布不变（read=10 / confirm=6）', () => {
  const specs = buildTools({ client: createFakeClient({}), config })
  const names = specs.map(s => s.definition.name).sort()
  assert.equal(names.length, 16)
  assert.deepEqual(names, [
    'xy_accounts_list', 'xy_circuit_reset', 'xy_copy_plan', 'xy_daemon_health', 'xy_import_account', 'xy_items_list',
    'xy_market_brief', 'xy_ping', 'xy_publish_batch', 'xy_publish_draft', 'xy_reference_collect', 'xy_status',
    'xy_task_action', 'xy_task_enqueue', 'xy_task_retry', 'xy_tasks_list',
  ])
  const confirm = specs.filter(s => s.access === 'confirm')
  const read = specs.filter(s => s.access === 'read')
  assert.equal(confirm.length, 6)
  assert.equal(read.length, 10)
  // 门禁 reason 不能被删：6 个 confirm 工具都得有非空审批理由（含新增参数的 publish_draft）。
  for (const spec of confirm) {
    assert.equal(typeof spec.reason, 'string')
    assert.ok(spec.reason.trim() !== '', `${spec.definition.name} 丢了 reason`)
  }
})
