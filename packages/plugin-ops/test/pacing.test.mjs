/**
 * 账号级发布 pacing 单测：批量入队按账号错开 availableAt。
 *
 * 用假时钟 + 假 daemon 客户端，不连网、不等待真实时间（对应 core/test/pacing.test.ts 的纯函数口径）。
 * @module @bigfish/plugin-ops/test/pacing
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_PUBLISH_MIN_INTERVAL_MS,
  PUBLISH_MIN_INTERVAL_MAX_MS,
  PUBLISH_MIN_INTERVAL_MIN_MS,
  nextPublishAvailableAt,
  resolvePublishMinIntervalMs,
  runBatch,
} from '../src/batch.js'
import { DaemonError } from '../src/client.js'
import { createFakeClient } from './helpers.mjs'

const FIXED = 1_700_000_000_000
const draftA = { title: '测试商品', desc: '描述 A', priceCents: 1990, images: ['D:\\pics\\a.png'] }
const draftB = { title: '另一个商品', desc: '描述 B', priceCents: 2990, images: ['/abs/b.png'] }
const draftC = { title: '第三个商品', desc: '描述 C', priceCents: 3990, images: ['/abs/c.png'] }

/** 假 daemon 入队：回显入队体，便于断言 availableAt。 */
function makeEchoClient(overrides = {}) {
  return createFakeClient({
    enqueue: (input) => ({
      id: 'abcdef0123456789',
      kind: input.kind,
      state: 'queued',
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      availableAt: input.availableAt,
      createdAt: 0,
      updatedAt: 0,
    }),
    ...overrides,
  })
}

/** 取出实际入队体里的 availableAt 序列。 */
function availableAtSeq(client) {
  return client.calls.filter((call) => call.method === 'enqueue').map((call) => call.args[0].availableAt)
}

test('resolvePublishMinIntervalMs：默认 180s，数字/字符串都接受，非法值回退，超出范围夹取', () => {
  assert.equal(DEFAULT_PUBLISH_MIN_INTERVAL_MS, 180_000)
  assert.equal(resolvePublishMinIntervalMs(undefined), 180_000)
  assert.equal(resolvePublishMinIntervalMs(''), 180_000)
  assert.equal(resolvePublishMinIntervalMs('abc'), 180_000)
  assert.equal(resolvePublishMinIntervalMs(Number.NaN), 180_000)
  assert.equal(resolvePublishMinIntervalMs(60_000), 60_000)
  assert.equal(resolvePublishMinIntervalMs(' 90000 '), 90_000)
  assert.equal(resolvePublishMinIntervalMs(60_000.9), 60_000)
  assert.equal(resolvePublishMinIntervalMs(1000), PUBLISH_MIN_INTERVAL_MIN_MS)
  assert.equal(resolvePublishMinIntervalMs('999999999'), PUBLISH_MIN_INTERVAL_MAX_MS)
})

test('nextPublishAvailableAt：首条取当前时刻，后续按间隔排队，过期的上一条从当前时刻重算', () => {
  assert.equal(nextPublishAvailableAt(undefined, FIXED, 180_000), FIXED)
  assert.equal(nextPublishAvailableAt(FIXED, FIXED, 180_000), FIXED + 180_000)
  assert.equal(nextPublishAvailableAt(FIXED + 180_000, FIXED, 180_000), FIXED + 360_000)
  // 上一条预约时间已过期：不能把新任务排到过去。
  assert.equal(nextPublishAvailableAt(1234, FIXED, 180_000), FIXED)
  assert.throws(() => nextPublishAvailableAt(undefined, -1, 180_000), (error) => error instanceof DaemonError && error.code === 'VALIDATION')
  assert.throws(() => nextPublishAvailableAt(undefined, FIXED, 0), (error) => error instanceof DaemonError && error.code === 'VALIDATION')
  assert.throws(() => nextPublishAvailableAt(-5, FIXED, 180_000), (error) => error instanceof DaemonError && error.code === 'VALIDATION')
})

test('runBatch：同一账号 3 条按 180s 递增预约（now、now+180s、now+360s）', async () => {
  const client = makeEchoClient()
  const text = await runBatch(
    { drafts: [draftA, draftB, draftC], mode: 'enqueue', accountId: 'acc-1' },
    { client, now: () => FIXED, minIntervalMs: 180_000 },
  )
  assert.deepEqual(availableAtSeq(client), [FIXED, FIXED + 180_000, FIXED + 360_000])
  // 输出仍按原格式汇报三条已入队，pacing 不改变模型可见的摘要结构。
  assert.match(text, /入队 3 \/ 跳过重复 0 \/ 非法 0 \/ 失败 0/)
})

test('runBatch：间隔可配置（30s / 60s 环境变量），非法值回退默认', async () => {
  const client = makeEchoClient()
  await runBatch({ drafts: [draftA, draftB], mode: 'enqueue', accountId: 'acc-1' }, { client, now: () => FIXED, minIntervalMs: 30_000 })
  assert.deepEqual(availableAtSeq(client), [FIXED, FIXED + 30_000])

  const restores = process.env.BF_PUBLISH_MIN_INTERVAL_MS
  try {
    process.env.BF_PUBLISH_MIN_INTERVAL_MS = '60000'
    const viaEnv = makeEchoClient()
    await runBatch({ drafts: [draftA, draftB], mode: 'enqueue', accountId: 'acc-1' }, { client: viaEnv, now: () => FIXED })
    assert.deepEqual(availableAtSeq(viaEnv), [FIXED, FIXED + 60_000])
  } finally {
    if (restores === undefined) delete process.env.BF_PUBLISH_MIN_INTERVAL_MS
    else process.env.BF_PUBLISH_MIN_INTERVAL_MS = restores
  }

  const fallback = makeEchoClient()
  await runBatch({ drafts: [draftA, draftB], mode: 'enqueue', accountId: 'acc-1' }, { client: fallback, now: () => FIXED, minIntervalMs: 'abc' })
  assert.deepEqual(availableAtSeq(fallback), [FIXED, FIXED + DEFAULT_PUBLISH_MIN_INTERVAL_MS])
})

test('runBatch：入队失败不占用账号的预约位，下一条仍从当前时刻起算', async () => {
  let calls = 0
  const client = makeEchoClient({
    enqueue: (input) => {
      calls += 1
      if (calls === 1) throw new DaemonError('VALIDATION', '第一条被 daemon 拒绝')
      return { id: 'abcdef0123456789', kind: input.kind, state: 'queued', dedupeKey: input.dedupeKey, payload: input.payload, availableAt: input.availableAt, createdAt: 0, updatedAt: 0 }
    },
  })
  const text = await runBatch({ drafts: [draftA, draftB], mode: 'enqueue', accountId: 'acc-1' }, { client, now: () => FIXED, minIntervalMs: 180_000 })
  assert.deepEqual(availableAtSeq(client), [FIXED, FIXED])
  // 失败那条如实标 failed（第 2 条不因它被延后），第二行才是 queued。
  assert.match(text, /失败/)
  assert.match(text, /入队 1 \/ 跳过重复 0 \/ 非法 0 \/ 失败 1/)
})
