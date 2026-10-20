/**
 * 运行时集成测试：真 HTTP + 真 SQLite 队列 + 真 worker，通道换成假 transport。
 *
 * 为什么必须集成测：单测分别证明了执行器、worker、HTTP 路由，但「HTTP 入队 → worker 租约 →
 * 执行器读凭据 → 通道 → 落库 → ack → HTTP 可查」这条链路只有拼起来才成立。
 * 不碰真实闲鱼：transport 是假的，cookie 也是假字符串。
 * @module @bigfish/daemon/test/runtime
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadDaemonConfig } from '@bigfish/core'
import type { DaemonConfig, TaskRecord } from '@bigfish/core'
import { MTOP_APIS } from '@bigfish/channel-mtop'
import type { MtopHttpRequest, MtopHttpResponse, MtopTransport } from '@bigfish/channel-mtop'

import { DaemonClient } from '../src/client.ts'
import { startDaemonRuntime } from '../src/runtime.ts'
import type { DaemonRuntime } from '../src/runtime.ts'

const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-runtime/', import.meta.url))

/** 假 mtop 传输：记录请求，按 api 返回固定信封；detail 的价格故意用元文本，验证解析链路。 */
function createFakeTransport(): { transport: MtopTransport; calls: MtopHttpRequest[] } {
  const calls: MtopHttpRequest[] = []
  const transport: MtopTransport = {
    async request(req: MtopHttpRequest): Promise<MtopHttpResponse> {
      calls.push(req)
      const api = req.url.slice(req.url.indexOf('/h5/') + 4, req.url.lastIndexOf('/1.0'))
      const data = api === MTOP_APIS.detail
        ? { itemDO: { itemId: '6677889900', title: '测试商品 A', price: '12.34', itemStatus: 0 } }
        : {}
      const text = JSON.stringify({ api, v: '1.0', ret: ['SUCCESS::调用成功'], data })
      return { status: 200, headers: { 'content-type': 'application/json' }, text }
    },
  }
  return { transport, calls }
}

interface Fixture {
  runtime: DaemonRuntime
  client: DaemonClient
  config: DaemonConfig
  /** 假通道收到的请求；用来断言「该调/不该调」通道。 */
  calls: MtopHttpRequest[]
}

/** 起一套完整运行时；t.after 负责关运行时并删目录。 */
async function createFixture(t: { after(fn: () => Promise<void>): void }, options: { autoStartWorker?: boolean } = {}): Promise<Fixture> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'run-'))
  const loaded = loadDaemonConfig({}, {
    dbPath: join(dir, 'bigfish.db'),
    credentialsDir: join(dir, 'credentials'),
    circuitPath: join(dir, 'circuits.json'),
    tokenPath: join(dir, 'daemon.token'),
    pollIntervalMs: 20,
  })
  const config: DaemonConfig = { ...loaded, port: 0 }
  const { transport, calls } = createFakeTransport()
  const runtime = await startDaemonRuntime({
    config,
    transport,
    owner: 'test-worker',
    autoStartWorker: options.autoStartWorker ?? true,
    version: '0.0.1-test',
  })
  t.after(async () => {
    await runtime.close()
    await rm(dir, { recursive: true, force: true })
  })
  const client = new DaemonClient({ baseUrl: runtime.daemon.url, tokenPath: config.tokenPath })
  return { runtime, client, config, calls }
}

/** 有界轮询：测试里不用无界 sleep，超时即失败（含最后状态，方便定位）。 */
async function waitForTask(client: DaemonClient, id: string, predicate: (task: TaskRecord) => boolean, timeoutMs = 8000): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs
  let last = await client.getTask(id)
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      assert.fail('等待任务超时：' + JSON.stringify({ id, state: last.state, lastError: last.lastError, attempts: last.attempts }))
    }
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    last = await client.getTask(id)
  }
  return last
}

test('集成：probe 任务走完整链路并落库到 /items', async (t) => {
  const { runtime, client } = await createFixture(t)
  await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'token_abc', unb: 'unb-1' } })
  await runtime.refreshAccounts()

  const task = await client.enqueue({
    kind: 'probe',
    dedupeKey: 'probe:6677889900',
    payload: { accountId: 'acc-1', itemId: '6677889900' },
  })
  const done = await waitForTask(client, task.id, record => record.state === 'done')
  assert.equal(done.attempts, 1)
  assert.equal(done.lastError, undefined)

  const items = await client.listItems()
  assert.equal(items.length, 1)
  assert.deepEqual(
    { itemId: items[0]?.itemId, accountId: items[0]?.accountId, title: items[0]?.title, priceCents: items[0]?.priceCents, state: items[0]?.state },
    { itemId: '6677889900', accountId: 'acc-1', title: '测试商品 A', priceCents: 1234, state: 'online' },
  )

  const status = await client.status()
  assert.deepEqual(status.accounts, ['acc-1'])
  assert.equal(status.worker?.done, 1)
})

test('集成：无凭据的 probe 不可重试，直接 failed 且不调通道', async (t) => {
  const { runtime, client, calls } = await createFixture(t)
  await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'token_abc', unb: 'unb-1' } })
  await runtime.refreshAccounts()

  const task = await client.enqueue({
    kind: 'probe',
    dedupeKey: 'probe:acc-missing',
    payload: { accountId: 'acc-missing', itemId: '1' },
  })
  const failed = await waitForTask(client, task.id, record => record.state === 'failed')
  assert.match(failed.lastError ?? '', /AUTH_EXPIRED|凭据|登录态/)
  assert.equal((await client.listItems()).length, 0)
  // 没凭据就不该花通道预算：假 transport 必须一次都没被调用。
  assert.equal(calls.length, 0)
})

test('集成：publish 走 UNSUPPORTED 占位，进 failed 而不是假成功', async (t) => {
  const { runtime, client } = await createFixture(t)
  await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'token_abc', unb: 'unb-1' } })
  await runtime.refreshAccounts()

  const task = await client.enqueue({
    kind: 'publish',
    dedupeKey: 'publish:draft-1',
    payload: {
      accountId: 'acc-1',
      title: '测试发布草稿',
      desc: '描述至少三十个字符才不会被策略校验拦下，这里随便写点内容凑够长度。',
      priceCents: 1990,
      images: ['/tmp/a.jpg'],
      quantity: 1,
    },
  })
  const failed = await waitForTask(client, task.id, record => record.state === 'failed')
  assert.match(failed.lastError ?? '', /UNSUPPORTED|尚未接入/)
  assert.equal((await client.listItems()).length, 0)
})

test('集成：同 dedupeKey 重复入队不产生第二个任务', async (t) => {
  const { runtime, client } = await createFixture(t, { autoStartWorker: false })
  await runtime.credentials.save({ accountId: 'acc-1', cookies: { _m_h5_tk: 'token_abc', unb: 'unb-1' } })
  await runtime.refreshAccounts()
  const input = { kind: 'probe' as const, dedupeKey: 'probe:dup', payload: { accountId: 'acc-1', itemId: '42' } }
  const first = await client.enqueue(input)
  const second = await client.enqueue(input)
  assert.equal(second.id, first.id)
  assert.equal((await client.listTasks()).length, 1)
})

test('集成：close 之后端口不可达', async (t) => {
  const { runtime, client } = await createFixture(t)
  const url = runtime.daemon.url
  await runtime.close()
  await assert.rejects(async () => {
    await fetch(url + '/health')
  })
  void client
})