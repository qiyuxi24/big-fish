/**
 * 工具注册中间件单测：校验、注册次数、门禁分支、dispose、访问级别分类。
 *
 * 原 gate.test.mjs 的语义全部保留在这里（写类判定、ask 的 reason、非写工具 next()、
 * task_enqueue 的 kind 白名单、dry-run 豁免），只是判定入口从 gate.js 换成
 * 「由同一份 specs 生成的 buildWritePolicy / 中间件监听」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildWritePolicy, createToolMiddleware, DEFAULT_TIMEOUT_MS } from '../src/tool-middleware.js'
import { buildTools } from '../src/tools.js'
import { createFakeClient, createFakeCtx } from './helpers.mjs'

const config = { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' }

/** 14 个真实工具的规格（定义 + access + reason/writeWhen）。 */
function makeSpecs() {
  return buildTools({ client: createFakeClient({}), config })
}

/** 找一条规格并返回其 definition（测试主要关心 definition 内容）。 */
function findDefinition(specs, name) {
  const spec = specs.find((candidate) => candidate.definition.name === name)
  assert.ok(spec, `缺少工具 ${name}`)
  return spec.definition
}

/** 起一套假 ctx + 中间件，返回注册结果与门禁监听。 */
function setup(specs = makeSpecs(), options = {}) {
  const { ctx, tools, listeners } = createFakeCtx()
  const result = createToolMiddleware(options).register(ctx, specs)
  return { ctx, tools, listeners, result, gate: listeners.get('tools/pre-execute') }
}

/** 最小合法规格；patch.definition 覆盖单个字段，patch 其余字段覆盖规格本身。 */
function makeSpec(patch = {}) {
  const base = {
    definition: {
      name: 'xy_demo',
      description: '演示工具',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' } },
      async execute() { return { text: 'ok' } },
    },
    access: 'read',
  }
  return { ...base, ...patch, definition: { ...base.definition, ...patch.definition } }
}

test('写类判定：只有 publish/deliver/polish 入队需要确认', () => {
  const isWriteCall = buildWritePolicy(makeSpecs())
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'publish' }), true)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'deliver' }), true)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'polish' }), true)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'probe' }), false)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'reply' }), false)
  assert.equal(isWriteCall('xy_tasks_list', {}), false)
  // 文案请求只产出提示词，不写队列/凭据，属于读类。
  assert.equal(isWriteCall('xy_copy_plan', { productName: 'x', condition: 'new', priceYuan: '10' }), false)
  // 参考采集只读统计（mtop 详情/主页列表），不写队列、不落文件，属于读类。
  assert.equal(isWriteCall('xy_reference_collect', { accountId: 'acc-1', itemIds: ['1'] }), false)
  // 参数形态无法判断时按最保守处理：要确认（宁可多问一次，也不静默放行写操作）。
  assert.equal(isWriteCall('xy_task_enqueue', null), true)
})

test('登录态导入永远是写操作；发布只有 enqueue 才拦', () => {
  const isWriteCall = buildWritePolicy(makeSpecs())
  assert.equal(isWriteCall('xy_import_account', {}), true)
  assert.equal(isWriteCall('xy_import_account', null), true)
  assert.equal(isWriteCall('xy_publish_draft', { draftPath: 'a.json' }), false)
  assert.equal(isWriteCall('xy_publish_draft', { draftPath: 'a.json', mode: 'dry-run' }), false)
  assert.equal(isWriteCall('xy_publish_draft', { draftPath: 'a.json', mode: 'enqueue' }), true)
  assert.equal(isWriteCall('xy_publish_draft', null), true)
})

test('批量发布：只有 enqueue 才拦，dry-run 放行', () => {
  const isWriteCall = buildWritePolicy(makeSpecs())
  assert.equal(isWriteCall('xy_publish_batch', { drafts: [{ title: 'x' }] }), false)
  assert.equal(isWriteCall('xy_publish_batch', { draftPaths: ['a.json'], mode: 'dry-run' }), false)
  assert.equal(isWriteCall('xy_publish_batch', { drafts: [{ title: 'x' }], mode: 'enqueue' }), true)
  // 参数形态无法判断时按最保守处理。
  assert.equal(isWriteCall('xy_publish_batch', null), true)
})

test('任务重试属于写操作：会清零 attempts 并让 daemon 重放发布', () => {
  const isWriteCall = buildWritePolicy(makeSpecs())
  assert.equal(isWriteCall('xy_task_retry', { taskId: 'x' }), true)
  assert.equal(isWriteCall('xy_task_retry', null), true)
  // 只影响本地队列可达性的动作仍然放行。
  assert.equal(isWriteCall('xy_task_action', { id: 'x', action: 'release' }), false)
  // 不在 specs 里的名字一律当读类，交给宿主原样处理。
  assert.equal(isWriteCall('xy_not_registered', {}), false)
})

test('access 分类：14 个工具里 5 个 confirm、9 个 read', () => {
  const specs = makeSpecs()
  for (const spec of specs) {
    assert.ok(spec.access === 'read' || spec.access === 'confirm', spec.definition.name + ' 缺少合法 access')
  }
  const { result } = setup(specs)
  assert.deepEqual(result.counts, { read: 9, confirm: 5 })
  assert.deepEqual(
    specs.filter((spec) => spec.access === 'confirm').map((spec) => spec.definition.name).sort(),
    ['xy_import_account', 'xy_publish_batch', 'xy_publish_draft', 'xy_task_enqueue', 'xy_task_retry'],
  )
  assert.equal(result.names.length, 14)
})

test('register 为每条规格调用一次 ctx.tools.register，names 与定义顺序一致', () => {
  const specs = makeSpecs()
  const { tools, result } = setup(specs)
  assert.equal(tools.length, specs.length)
  assert.deepEqual(result.names, specs.map((spec) => spec.definition.name))
  assert.deepEqual(tools.map((definition) => definition.name), result.names)
})

test('timeoutMs 缺省补 25s，显式值原样保留', () => {
  const { tools } = setup([makeSpec({ definition: { name: 'xy_no_timeout' } })])
  assert.equal(tools[0].timeoutMs, DEFAULT_TIMEOUT_MS)
  const batch = findDefinition(makeSpecs(), 'xy_publish_batch')
  assert.equal(batch.timeoutMs, 60_000)
})

test('门禁为每种写操作给出各自的确认原因', () => {
  const { gate } = setup()
  const account = gate({ name: 'xy_import_account', arguments: {} }, () => ({ kind: 'allow' }))
  assert.equal(account.kind, 'ask')
  assert.match(account.reason, /凭据/)
  const publish = gate({ name: 'xy_publish_draft', arguments: { mode: 'enqueue' } }, () => ({ kind: 'allow' }))
  assert.match(publish.reason, /BF_PUBLISH_SUBMIT=1/)
  const dryRun = gate({ name: 'xy_publish_draft', arguments: { mode: 'dry-run' } }, () => ({ kind: 'allow' }))
  assert.equal(dryRun.kind, 'allow')

  const batch = gate({ name: 'xy_publish_batch', arguments: { mode: 'enqueue' } }, () => ({ kind: 'allow' }))
  assert.equal(batch.kind, 'ask')
  assert.match(batch.reason, /BF_PUBLISH_SUBMIT=1/)
  const batchDryRun = gate({ name: 'xy_publish_batch', arguments: { mode: 'dry-run' } }, () => ({ kind: 'allow' }))
  assert.equal(batchDryRun.kind, 'allow')

  const retry = gate({ name: 'xy_task_retry', arguments: { taskId: 'x' } }, () => ({ kind: 'allow' }))
  assert.equal(retry.kind, 'ask')
  assert.match(retry.reason, /BF_PUBLISH_SUBMIT=1/)
})

test('门禁：写调用返回 ask，读调用与未知工具走 next()', () => {
  const { gate } = setup()
  assert.equal(typeof gate, 'function')

  const asked = gate({ name: 'xy_task_enqueue', arguments: { kind: 'publish' } }, () => ({ kind: 'allow' }))
  assert.equal(asked.kind, 'ask')
  assert.match(asked.reason, /人工确认/)

  const allowed = gate({ name: 'xy_status', arguments: {} }, () => ({ kind: 'allow' }))
  assert.equal(allowed.kind, 'allow')
  assert.equal(gate({ name: 'xy_not_registered', arguments: {} }, () => ({ kind: 'allow' })).kind, 'allow')
  // 宿主传入的 exec 形态异常时也不该阻断：按读类放行。
  assert.equal(gate(undefined, () => ({ kind: 'allow' })).kind, 'allow')
})

test('confirm 且没有 reason 时用默认审批理由', () => {
  const specs = [makeSpec({ definition: { name: 'xy_custom_write' }, access: 'confirm' })]
  const { gate } = setup(specs)
  const asked = gate({ name: 'xy_custom_write', arguments: {} }, () => ({ kind: 'allow' }))
  assert.equal(asked.kind, 'ask')
  assert.match(asked.reason, /xy_custom_write/)
  assert.match(asked.reason, /人工确认/)
})

test('read 规格即使带 writeWhen 也放行', () => {
  const specs = [makeSpec({ access: 'read', writeWhen: () => true })]
  const { gate } = setup(specs)
  assert.equal(gate({ name: 'xy_demo', arguments: {} }, () => ({ kind: 'allow' })).kind, 'allow')
})

test('logger 打一条注册摘要；没有 logger 时静默', () => {
  const lines = []
  setup(makeSpecs(), { logger: (line) => lines.push(line) })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /共 14 个/)
  assert.match(lines[0], /read=9/)
  assert.match(lines[0], /confirm=5/)
  // 静默路径：不传 logger 不抛错，也不产生日志（调用方自己汇总）。
  assert.doesNotThrow(() => setup(makeSpecs()))
})

test('dispose 解绑门禁监听，之后不再触发', () => {
  const { listeners, result } = setup()
  assert.equal(typeof result.dispose, 'function')
  assert.equal(listeners.has('tools/pre-execute'), true)
  result.dispose()
  assert.equal(listeners.has('tools/pre-execute'), false)
})

test('gate=false 时不注册门禁监听，但工具照常注册', () => {
  const { listeners, tools, result } = setup(makeSpecs(), { gate: false })
  assert.equal(listeners.size, 0)
  assert.equal(tools.length, 14)
  assert.equal(typeof result.dispose, 'function')
})

test('宿主没有 on() 时 fail loud（校验先于副作用，不留半个插件）', () => {
  const registered = []
  const ctx = { tools: { register: (definition) => registered.push(definition) } }
  assert.throws(() => createToolMiddleware({}).register(ctx, makeSpecs()), /on\(\)/)
  assert.equal(registered.length, 0)
})

test('非法定义直接抛 TypeError（坏名字/缺 description/缺 execute/缺 schema/重名）', () => {
  const ctx = createFakeCtx()
  const middleware = createToolMiddleware({})
  const invalid = [
    [makeSpec({ definition: { name: 'bad-name' } }), /工具名不合法/],
    [makeSpec({ definition: { name: 'xy_Bad' } }), /工具名不合法/],
    [makeSpec({ definition: { description: '' } }), /description/],
    [makeSpec({ definition: { execute: 'not-a-function' } }), /execute/],
    [makeSpec({ definition: { output: undefined } }), /output\.schema/],
    [makeSpec({ definition: { output: { schema: null } } }), /output\.schema/],
    [makeSpec({ definition: { parameters: null } }), /parameters/],
    [makeSpec({ access: 'write' }), /access/],
    [makeSpec({ access: undefined }), /access/],
    [makeSpec({ reason: 42 }), /reason/],
    [makeSpec({ writeWhen: 'nope' }), /writeWhen/],
  ]
  for (const [spec, pattern] of invalid) {
    assert.throws(() => middleware.register(ctx.ctx, [spec]), TypeError)
    assert.throws(() => middleware.register(ctx.ctx, [spec]), pattern)
    assert.equal(ctx.tools.length, 0)
  }
})

test('重名工具抛 TypeError 并带工具名', () => {
  const ctx = createFakeCtx()
  const middleware = createToolMiddleware({ gate: false })
  const spec = makeSpec()
  assert.throws(() => middleware.register(ctx.ctx, [spec, makeSpec()]), (error) => {
    assert.ok(error instanceof TypeError)
    assert.match(error.message, /重复/)
    assert.match(error.message, /xy_demo/)
    return true
  })
  assert.equal(ctx.tools.length, 0)
})

test('specs 不是数组时抛 TypeError', () => {
  const ctx = createFakeCtx()
  assert.throws(() => createToolMiddleware({ gate: false }).register(ctx.ctx, {}), /数组/)
  assert.equal(ctx.tools.length, 0)
})
