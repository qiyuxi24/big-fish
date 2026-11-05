/**
 * IM 域路由测试：连接状态（未开启/已开启）与回复入队（校验、账号推断、幂等）。
 *
 * 不连 wss：回复路由只负责入队，真正的出站帧由 executors.ts 的 reply 执行器发，
 * ImRuntime 在这里用假实现，只提供 enabled/status。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ImAccountStatus, ImRuntime } from '../src/im-runtime.ts'
import { asRecord, createHarness, dataOf, errorOf } from './harness.ts'
import type { DaemonHarness, RawResponse } from './harness.ts'

function fakeIm(accounts: readonly ImAccountStatus[], enabled: boolean = true): ImRuntime {
  return {
    enabled,
    startAccount: (): void => {},
    startAll: (): void => {},
    sendReply: async (): Promise<void> => {},
    status: (): ImAccountStatus[] => [...accounts],
    stop: (): void => {},
  }
}

async function reply(harness: DaemonHarness, body: unknown): Promise<RawResponse> {
  return harness.rawRequest({ method: 'POST', path: '/im/reply', body: JSON.stringify(body) })
}

describe('GET /im/status', () => {
  it('未注入 IM 运行时 → enabled:false、accounts 为空（面板仍能渲染）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'GET', path: '/im/status' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { enabled: false, accounts: [] })
  })

  it('已注入 → 透出 enabled 与每个账号的连接状态', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([{ accountId: 'acc-1', state: 'ready' }]) })
    const response = await harness.rawRequest({ method: 'GET', path: '/im/status' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { enabled: true, accounts: [{ accountId: 'acc-1', state: 'ready' }] })
  })

  it('默认关闭（enabled:false）时如实报告，不伪装成已连接', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([], false) })
    const response = await harness.rawRequest({ method: 'GET', path: '/im/status' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), { enabled: false, accounts: [] })
  })
})

describe('POST /im/reply', () => {
  it('IM 未开启 → UNSUPPORTED，且不留下注定失败的任务', async (t) => {
    const harness = await createHarness(t)
    const response = await reply(harness, { cid: 'cid-1', text: '在的' })
    assert.equal(response.status, 500)
    const error = errorOf(response)
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /BF_IM=1/)
    assert.deepEqual(harness.queue.list(), [])
  })

  it('缺 cid / 缺 text → 400 VALIDATION，不入队', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([]) })
    for (const body of [{ text: '在的' }, { cid: 'cid-1' }, { cid: '', text: '在的' }]) {
      const response = await reply(harness, body)
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal(errorOf(response).code, 'VALIDATION')
    }
    assert.deepEqual(harness.queue.list(), [])
  })

  it('没有已保存账号且未指定 accountId → 400 VALIDATION，不改猜账号', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([]) })
    const response = await reply(harness, { cid: 'cid-1', text: '在的' })
    assert.equal(response.status, 400)
    assert.match(errorOf(response).message, /accountId/)
    assert.deepEqual(harness.queue.list(), [])
  })

  it('只有一个已保存账号时自动用它，入队一条 reply 任务（202）', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([]), accounts: (): string[] => ['acc-1'] })
    const response = await reply(harness, { cid: 'cid-1', text: '在的，今天发货' })
    assert.equal(response.status, 202)
    const data = asRecord(dataOf(response))
    assert.equal(data['kind'], 'reply')
    assert.equal(data['created'], true)
    const tasks = harness.queue.list()
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]?.kind, 'reply')
    assert.deepEqual(tasks[0]?.payload, { accountId: 'acc-1', cid: 'cid-1', text: '在的，今天发货' })
    assert.match(tasks[0]?.dedupeKey ?? '', /^im-reply:acc-1:cid-1:/)
  })

  it('同一时间桶内重复提交同一句话 → 幂等命中，只有一条任务', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([]), accounts: (): string[] => ['acc-1'] })
    const first = await reply(harness, { cid: 'cid-1', text: '在的' })
    const second = await reply(harness, { cid: 'cid-1', text: '在的' })
    assert.equal(first.status, 202)
    assert.equal(asRecord(dataOf(first))['created'], true)
    assert.equal(asRecord(dataOf(second))['created'], false)
    assert.equal(harness.queue.list().length, 1)
  })

  it('跨过 5 分钟桶后同一句话算新消息（重复是正常业务）', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([]), accounts: (): string[] => ['acc-1'] })
    await reply(harness, { cid: 'cid-1', text: '在的' })
    harness.setNow(harness.now() + 5 * 60_000)
    const second = await reply(harness, { cid: 'cid-1', text: '在的' })
    assert.equal(asRecord(dataOf(second))['created'], true)
    assert.equal(harness.queue.list().length, 2)
  })

  it('多个已保存账号且未指定 → 400，消息说明无法推断', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([]), accounts: (): string[] => ['acc-1', 'acc-2'] })
    const response = await reply(harness, { cid: 'cid-1', text: '在的' })
    assert.equal(response.status, 400)
    assert.match(errorOf(response).message, /2 个账号/)
  })

  it('显式 accountId 优先于已保存账号', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([]), accounts: (): string[] => ['acc-1'] })
    const response = await reply(harness, { accountId: 'acc-9', cid: 'cid-1', text: '在的' })
    assert.equal(response.status, 202)
    assert.equal(harness.queue.list()[0]?.payload['accountId'], 'acc-9')
  })

  it('显式 dedupeKey 生效：不同文本但同键只入队一次', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([]), accounts: (): string[] => ['acc-1'] })
    await reply(harness, { cid: 'cid-1', text: '第一句', dedupeKey: 'biz-42' })
    const second = await reply(harness, { cid: 'cid-1', text: '第二句', dedupeKey: 'biz-42' })
    assert.equal(asRecord(dataOf(second))['created'], false)
    assert.equal(harness.queue.list().length, 1)
  })

  it('dedupeKey 不是字符串 → 400 VALIDATION', async (t) => {
    const harness = await createHarness(t, { im: fakeIm([]), accounts: (): string[] => ['acc-1'] })
    const response = await reply(harness, { cid: 'cid-1', text: '在的', dedupeKey: 7 })
    assert.equal(response.status, 400)
    assert.equal(errorOf(response).code, 'VALIDATION')
  })
})
