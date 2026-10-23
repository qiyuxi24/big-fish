/**
 * 发布侧风控的 worker 集成：CDP 发布抛 RISK_CONTROL 后必须
 * ①trip 账号级熔断（冷却 600s）②冷却期内同账号后续任务被 CIRCUIT_OPEN 拦下、不再打账号
 * ③冷却结束后恢复执行。用 FakeQueue + 注入时钟，不 sleep、不触网。
 * 另建测试文件是为了避免与 task-8 正在改的 worker.test.ts 冲突。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CircuitBreaker, RateLimiter, XianyuError } from '@bigfish/core'
import type { CredentialRecord } from '@bigfish/core'

import { startWorker } from '../src/worker.ts'
import type { OperationPort } from '../src/executors.ts'
import { createExecutors } from '../src/executors.ts'
import { FakeQueue } from './fake-queue.ts'

const CIRCUIT_DIR = fileURLToPath(new URL('../../../.scratch/daemon-worker/', import.meta.url))
const COOLDOWN_MS = 600_000
let nowMs = 1_700_000_000_000
let seq = 0

function makePort(onPublish: (call: number) => Promise<{ itemId?: string }>): OperationPort & { calls: number } {
  const port: OperationPort & { calls: number } = {
    calls: 0,
    async fetchItemDetail(input) {
      return { itemId: input.itemId, title: '标题', priceCents: 1990, state: 'online' }
    },
    async polishItem() {
      return undefined
    },
    async publishItem() {
      port.calls += 1
      return onPublish(port.calls)
    },
    async deliverOrder() {
      return { delivered: true }
    },
    async sendReply() {
      return undefined
    },
    async verifySession() {
      return undefined
    },
  }
  return port
}

async function makeCircuit(): Promise<CircuitBreaker> {
  await mkdir(CIRCUIT_DIR, { recursive: true })
  seq += 1
  // 路径必须每次运行都唯一：熔断状态会落盘，复用文件名会让上一次运行的冷却状态污染本次测试。
  const file = 'circuit-publish-risk-' + String(process.pid) + '-' + String(Date.now()) + '-' + String(seq) + '.json'
  return new CircuitBreaker({ path: join(CIRCUIT_DIR, file), now: () => nowMs })
}

function credentialsStore(): { load(accountId: string): Promise<CredentialRecord | undefined> } {
  const record: CredentialRecord = { accountId: 'a1', cookies: { unb: 'a1' }, updatedAt: 1 }
  return {
    async load(accountId: string): Promise<CredentialRecord | undefined> {
      return accountId === 'a1' ? record : undefined
    },
  }
}

/** 与 executors.test.ts 同款最小合法发布载荷。 */
function publishPayload(): Record<string, unknown> {
  return { accountId: 'a1', title: '测试商品', desc: '描述', priceCents: 1990, images: ['D:\\pics\\a.png'], category: '学习笔记' }
}

test('发布 RISK_CONTROL：trip 熔断、冷却期内拦下同账号后续任务、冷却后恢复', async () => {
  const port = makePort(async (call) => {
    if (call === 1) throw new XianyuError({ code: 'RISK_CONTROL', message: '发布页触发风控：页面出现「人机验证」' })
    return { itemId: 'item-' + String(call) }
  })
  const credentials = credentialsStore()
  const circuits = await makeCircuit()
  const limiter = new RateLimiter({ now: () => nowMs })
  const queue = new FakeQueue({ now: () => nowMs })
  const executors = createExecutors({ ports: port })
  const worker = startWorker({
    queue,
    executors,
    deps: { circuits, credentials, limiter, now: () => nowMs },
    owner: 'worker-risk-test',
    now: () => nowMs,
    autoStart: false,
    concurrency: 1,
  })

  const first = queue.enqueue({ kind: 'publish', dedupeKey: 'risk-1', payload: publishPayload() })
  const second = queue.enqueue({ kind: 'publish', dedupeKey: 'risk-2', payload: publishPayload() })

  // 第一次：发布抛 RISK_CONTROL → trip 熔断 + 按冷却期推迟重试。
  await worker.tick()
  assert.equal(port.calls, 1)
  assert.equal(circuits.isOpen('a1', nowMs), true)
  assert.equal(queue.get(first.id)?.state, 'queued')
  assert.equal(queue.failCalls[0]?.options?.retryAfterMs, COOLDOWN_MS)
  assert.match(String(queue.failCalls[0]?.error), /发布页触发风控/)

  // 冷却期内：同账号的第二条任务被 checkCircuit 拦下，发布通道不会再被调用。
  await worker.tick()
  assert.equal(port.calls, 1, '冷却期内不能再打发布接口')
  assert.equal(queue.failCalls[1]?.options?.retryAfterMs, COOLDOWN_MS)
  assert.match(String(queue.failCalls[1]?.error), /账号处于风控冷却中/)
  assert.equal(queue.get(second.id)?.state, 'queued')

  // 冷却结束后：第一条重试成功。
  nowMs += COOLDOWN_MS
  assert.equal(circuits.isOpen('a1', nowMs), false)
  await worker.tick()
  assert.equal(queue.get(first.id)?.state, 'done')
  assert.equal(port.calls, 2)

  // 写桶仍是 1 次/60s：第二条要再等一个写桶窗口，避免同一账号两条发布贴在一起。
  nowMs += 60_001
  await worker.tick()
  assert.equal(queue.get(second.id)?.state, 'done')
  assert.equal(port.calls, 3)
  await worker.stop()
})

test('发布失败但不是风控：不 trip 熔断，按原失败码处理', async () => {
  const port = makePort(async () => {
    throw new XianyuError({ code: 'VALIDATION', message: '分类下拉里没有「学习笔记」这个选项' })
  })
  const circuits = await makeCircuit()
  const queue = new FakeQueue({ now: () => nowMs })
  const worker = startWorker({
    queue,
    executors: createExecutors({ ports: port }),
    deps: { circuits, credentials: credentialsStore(), limiter: new RateLimiter({ now: () => nowMs }), now: () => nowMs },
    owner: 'worker-risk-test',
    now: () => nowMs,
    autoStart: false,
  })
  const task = queue.enqueue({ kind: 'publish', dedupeKey: 'risk-plain', payload: publishPayload() })
  await worker.tick()
  assert.equal(circuits.isOpen('a1', nowMs), false)
  assert.equal(queue.get(task.id)?.state, 'failed')
  assert.equal(queue.failCalls[0]?.options?.nonRetryable, true)
  await worker.stop()
})