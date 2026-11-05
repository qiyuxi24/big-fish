/**
 * 面向 agent 的工具可用性回归：失败要能指导下一步、死链条要接上、描述不许撒谎。
 *
 * 这些用例对应 2026-11-03 审计里「agent 用起来不顺手」的那批问题：
 * ① `xy_circuit_reset` 被文案引用却不存在（熔断后无出口）；
 * ② `/status` 不告诉调用方「这条 daemon 到底能写什么」（入队必然 failed 却先回 201）；
 * ③ 合规问题拖到执行器才炸（dry-run 说「通过」，入队后任务 failed）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTools } from '../src/tools.js'
import { createFakeClient } from './helpers.mjs'

const config = { daemonUrl: 'http://127.0.0.1:47001', tokenPath: '/tmp/daemon.token' }

function findTool(specs, name) {
  const spec = specs.find((candidate) => candidate.definition.name === name)
  assert.ok(spec, `缺少工具 ${name}`)
  return spec.definition
}

function runTool(name, overrides, args = {}) {
  const tool = findTool(buildTools({ client: createFakeClient(overrides), config }), name)
  return tool.execute(args, {})
}

/** 合规预检的 daemon 替身：按需要返回 ok / issues。 */
function policyResult(ok, issues = []) {
  return () => ({ ok, issues })
}

test('xy_circuit_reset：复位成功要给出确认路径与「上次为什么被熔断」的追问', async () => {
  const value = await runTool('xy_circuit_reset', { resetCircuit: () => ({ accountId: 'acc-1', reset: true }) }, { accountId: 'acc-1' })
  assert.match(value.text, /已复位/)
  assert.match(value.text, /acc-1/)
  assert.match(value.text, /xy_status/)
  // 复位是解刹车，必须提醒先想清楚为什么被刹住。
  assert.match(value.text, /30 分钟/)
})

test('xy_circuit_reset：daemon 没装熔断器时要说清楚「不然你以为复位了」', async () => {
  const value = await runTool('xy_circuit_reset', { resetCircuit: () => ({ accountId: 'acc-1', reset: false }) }, { accountId: 'acc-1' })
  assert.match(value.text, /不在熔断表/)
  assert.match(value.text, /xy_ping/)
})

test('xy_circuit_reset 是写类操作：access=confirm 且 reason 说明为什么要问人', () => {
  const spec = buildTools({ client: createFakeClient({}), config }).find((item) => item.definition.name === 'xy_circuit_reset')
  assert.equal(spec.access, 'confirm')
  assert.match(spec.reason, /熔断/)
})

test('xy_status 把 capabilities 翻成一行能力说明（发布通道没开要明说）', async () => {
  const value = await runTool('xy_status', {
    status: {
      version: '0.1.0', uptimeMs: 1000, pid: 7,
      queue: { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 },
      accounts: ['acc-1'], circuits: {},
      capabilities: { publish: 'off', polish: true, deliver: false, reply: false },
    },
  })
  assert.match(value.text, /能力：publish=未开启/)
  assert.match(value.text, /polish=可用/)
  assert.match(value.text, /deliver=未实现/)
  assert.match(value.text, /BF_PUBLISH_SUBMIT=1/)
})

test('xy_status 队列空但发布没开时，不能再说「直接发新任务即可」', async () => {
  const value = await runTool('xy_status', {
    status: {
      version: '0.1.0', uptimeMs: 1000, pid: 7,
      queue: { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 },
      accounts: ['acc-1'], circuits: {},
      capabilities: { publish: 'off', polish: true, deliver: false, reply: false },
    },
  })
  const firstLine = value.text.split('\n')[0]
  assert.doesNotMatch(firstLine, /直接发新任务/)
  assert.match(firstLine, /发布通道没开/)
})

test('xy_status：dry-run 通道要说明「入队仍会失败」', async () => {
  const value = await runTool('xy_status', {
    status: {
      version: '0.1.0', uptimeMs: 1000, pid: 7,
      queue: { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 },
      accounts: ['acc-1'], circuits: {},
      capabilities: { publish: 'dry-run', polish: true, deliver: false, reply: false },
    },
  })
  assert.match(value.text.split('\n')[0], /只开了 dry-run/)
})

test('xy_status：publish=submit 时队列空才说「直接发新任务即可」', async () => {
  const value = await runTool('xy_status', {
    status: {
      version: '0.1.0', uptimeMs: 1000, pid: 7,
      queue: { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 },
      accounts: ['acc-1'], circuits: {},
      capabilities: { publish: 'submit', polish: true, deliver: false, reply: false },
    },
  })
  assert.match(value.text.split('\n')[0], /直接发新任务即可/)
  assert.match(value.text, /publish=真提交/)
})

test('老 daemon 不带 capabilities 时不臆造能力行', async () => {
  const value = await runTool('xy_status', {
    status: {
      version: '0.0.9', uptimeMs: 1000, pid: 7,
      queue: { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 },
      accounts: ['acc-1'], circuits: {},
    },
  })
  assert.doesNotMatch(value.text, /能力：/)
})

test('xy_publish_draft dry-run 会把合规问题摆在台面上', async () => {
  const draft = { title: '测试商品', desc: '太短', priceCents: 1990, images: ['D:\\pics\\a.png'] }
  const tool = findTool(
    buildTools({
      client: createFakeClient({
        health: { version: '1.0.0' },
        checkPolicy: policyResult(false, [
          { code: 'DESC_TOO_SHORT', field: 'description', message: '描述至少 30 字，当前 2 字', severity: 'error' },
          { code: 'TITLE_TOO_LONG', field: 'title', message: '标题超过 30 字', severity: 'warn' },
        ]),
      }),
      config,
      readDraftFile: async () => JSON.stringify(draft),
    }),
    'xy_publish_draft',
  )
  const value = await tool.execute({ draftPath: 'D:/tmp/draft.json' }, {})
  assert.match(value.text, /合规预检：有会阻塞发布的问题/)
  assert.match(value.text, /✖ \[description\] 描述至少 30 字/)
  assert.match(value.text, /DESC_TOO_SHORT/)
  assert.match(value.text, /! \[title\]/)
  assert.match(value.text, /执行器里被 requirePolicy 拒掉/)
})

test('xy_publish_draft enqueue 遇到 error 级合规问题就本地挡掉，不入队', async () => {
  const draft = { title: '测试商品', desc: '太短', priceCents: 1990, images: ['D:\\pics\\a.png'] }
  const client = createFakeClient({
    checkPolicy: policyResult(false, [
      { code: 'DESC_TOO_SHORT', field: 'description', message: '描述至少 30 字，当前 2 字', severity: 'error' },
    ]),
    enqueue: () => { throw new Error('不应该走到入队') },
  })
  const tool = findTool(buildTools({ client, config, readDraftFile: async () => JSON.stringify(draft) }), 'xy_publish_draft')
  const value = await tool.execute({ draftPath: 'D:/tmp/draft.json', mode: 'enqueue', accountId: 'acc-1' }, {})
  assert.match(value.text, /合规预检/)
  assert.match(value.text, /描述至少 30 字/)
  assert.equal(client.calls.some((call) => call.method === 'enqueue'), false)
})

test('合规预检自身失败不阻断入队（执行器还会再查一遍）', async () => {
  const draft = { title: '测试商品', desc: '这是一段足够长的描述，用来确认预检失败时不误伤正常入队流程。', priceCents: 1990, images: ['D:\\pics\\a.png'] }
  const { DaemonError } = await import('../src/client.js')
  const client = createFakeClient({
    checkPolicy: () => { throw new DaemonError('NETWORK', '预检端点暂时不可用') },
    enqueue: (input) => ({ id: 'abcdef0123456789', kind: input.kind, state: 'queued', attempts: 0, maxAttempts: 3,
      dedupeKey: input.dedupeKey, payload: input.payload, availableAt: 0, createdAt: 0, updatedAt: 0 }),
  })
  const tool = findTool(buildTools({ client, config, readDraftFile: async () => JSON.stringify(draft) }), 'xy_publish_draft')
  const value = await tool.execute({ draftPath: 'D:/tmp/draft.json', mode: 'enqueue', accountId: 'acc-1' }, {})
  assert.match(value.text, /已入队/)
  assert.equal(client.calls.some((call) => call.method === 'enqueue'), true)
})

test('合规预检连不上 daemon 时 dry-run 只降级提示、不报错', async () => {
  const draft = { title: '测试商品', desc: '这是一段足够长的描述，用来确认预检失败时不误伤正常 dry-run。', priceCents: 1990, images: ['D:\\pics\\a.png'] }
  const { DaemonError } = await import('../src/client.js')
  const tool = findTool(
    buildTools({
      client: createFakeClient({
        health: () => { throw new DaemonError('NETWORK', '连不上 daemon') },
        checkPolicy: () => { throw new DaemonError('NETWORK', '连不上 daemon') },
      }),
      config,
      readDraftFile: async () => JSON.stringify(draft),
    }),
    'xy_publish_draft',
  )
  const value = await tool.execute({ draftPath: 'D:/tmp/draft.json' }, {})
  assert.match(value.text, /合规预检：跳过/)
  assert.match(value.text, /dry-run 仍可继续/)
  assert.match(value.text, /pnpm daemon:publish/)
})
