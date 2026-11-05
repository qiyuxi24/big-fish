/**
 * P0 端到端集成测试：真实 daemon（HTTP + SQLite 队列）+ 插件自己的 JS 客户端 + xy_* 工具。
 *
 * 为什么不放进 packages/*\/test：
 * 它同时跨 core / daemon / plugin-ops 三层，放进任何单个包都会制造反向依赖；
 * 这里用相对路径直接 import 三层的公开出口（integration/ 不参与构建与发布）。
 * 沙箱禁止 spawn 子进程，所以 daemon 用 startDaemon 在同一进程内起，端口 0。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createTaskQueue, loadDaemonConfig } from '../packages/core/src/index.ts'
import { startDaemon } from '../packages/daemon/src/index.ts'
import { createDaemonClient } from '../packages/plugin-ops/src/client.js'
import { buildWritePolicy } from '../packages/plugin-ops/src/tool-middleware.js'
import { buildTools } from '../packages/plugin-ops/src/tools.js'

/** 在 .scratch 下建一个用完即删的临时数据目录。 */
function scratchDir() {
  const base = fileURLToPath(new URL('../.scratch/integration/', import.meta.url))
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, 'run-'))
}

test('daemon ↔ 插件客户端：健康检查、入队幂等、敏感字段被打码、工具输出', async (t) => {
  const dir = scratchDir()
  const config = loadDaemonConfig({ BF_DATA_DIR: dir }, { port: 0 })
  const queue = createTaskQueue({ path: config.dbPath })
  const daemon = await startDaemon({ config, queue, version: 'test' })
  const client = createDaemonClient({ daemonUrl: daemon.url, tokenPath: config.tokenPath, timeoutMs: 5000 })
  t.after(async () => {
    await daemon.close()
    queue.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // 1) 健康检查免鉴权，status 带 Bearer —— 两者都经插件客户端走真实 HTTP。
  const health = await client.health()
  assert.equal(health.version, 'test')
  const status = await client.status()
  assert.equal(status.queue.queued, 0)

  // 2) 入队落库 + 出口 redact；同一 dedupeKey 再来一次必须返回同一条。
  // 载荷在入队那一刻就要合法（缺字段直接 400，不落库）——这里给全 publish 必填字段。
  const publishPayload = { accountId: 'acc-1', title: '测试商品', desc: '测试描述', priceCents: 990, images: ['C:/tmp/a.jpg'], cookies: 'SESSION=secret' }
  const first = await client.enqueue({
    kind: 'publish',
    dedupeKey: 'publish:item-1',
    payload: publishPayload,
  })
  assert.equal(first.state, 'queued')
  assert.notEqual(first.payload.cookies, 'SESSION=secret')
  const again = await client.enqueue({ kind: 'publish', dedupeKey: 'publish:item-1', payload: publishPayload })
  assert.equal(again.id, first.id)
  assert.equal((await client.listTasks()).length, 1)

  // 3) 工具层把 daemon 的返回渲染成模型可读文本。
  const tools = buildTools({
    client,
    config: { daemonUrl: daemon.url, tokenPath: config.tokenPath, timeoutMs: 5000, writeGate: true },
    version: 'test',
  })
  const byName = new Map(tools.map((spec) => [spec.definition.name, spec.definition]))
  const isWriteCall = buildWritePolicy(tools)
  const ping = await byName.get('xy_ping').execute({}, {})
  assert.match(ping.text, /health: OK/)
  assert.match(ping.text, /auth: OK/)
  const listText = await byName.get('xy_tasks_list').execute({}, {})
  assert.match(listText.text, /publish \| queued/)

  // 4) 写类工具的审批门禁判定（publish / reply 都会对外产生动作，必须问人）。
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'publish' }), true)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'reply' }), true)
  assert.equal(isWriteCall('xy_task_enqueue', { kind: 'probe' }), false)
})

test('daemon 无 token 文件时插件客户端报 UNAUTHORIZED 而不是 NETWORK', async (t) => {
  const dir = scratchDir()
  const config = loadDaemonConfig({ BF_DATA_DIR: dir }, { port: 0 })
  const queue = createTaskQueue({ path: config.dbPath })
  const daemon = await startDaemon({ config, queue })
  t.after(async () => {
    await daemon.close()
    queue.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const client = createDaemonClient({ daemonUrl: daemon.url, tokenPath: join(dir, 'missing.token'), timeoutMs: 5000 })
  await assert.rejects(client.status(), (error) => {
    assert.equal(error.code, 'UNAUTHORIZED')
    assert.match(error.message, /token/)
    return true
  })
})
