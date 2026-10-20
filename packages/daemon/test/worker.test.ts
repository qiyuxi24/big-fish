/**
 * worker 单测：租约循环、失败映射、账号串行、优雅停止、日志与统计。
 *
 * 全部用 FakeQueue（内存、可注入时钟）与假执行器，不起 HTTP、不连网络；
 * 自动轮询只用一个 5ms 的定时器用例，其余靠 tick() 手动驱动。
 * @module @bigfish/daemon/test/worker
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CircuitBreaker, XianyuError, createLogger } from '@bigfish/core'
import type { Logger, TaskKind, TaskRecord } from '@bigfish/core'

import { startWorker } from '../src/worker.ts'
import type { WorkerHandle } from '../src/worker.ts'
import type { ExecuteContext, ExecutorTable, TaskExecutor } from '../src/executor.ts'
import { FakeQueue } from './fake-queue.ts'

const CIRCUIT_DIR = fileURLToPath(new URL('../../../.scratch/daemon-worker/', import.meta.url))
let nowMs = 1_700_000_000_000
let circuitSeq = 0

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve): void => {
    resolveFn = resolve
  })
  return { promise, resolve: (value: T): void => resolveFn(value) }
}

/** 轮询等待条件成立；只用于「自动轮询」用例，间隔 5ms，超时 1s。 */
async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时：' + label)
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 5)
    })
  }
}

function executorFor(kind: TaskKind, execute: (task: TaskRecord, ctx: ExecuteContext) => Promise<void>): ExecutorTable {
  const entry: TaskExecutor = { kind, execute }
  const table: ExecutorTable = {}
  table[kind] = entry
  return table
}

interface WorkerFixtureOptions {
  concurrency?: number
  autoStart?: boolean
  pollIntervalMs?: number
  logger?: Logger
  circuits?: CircuitBreaker
}

function makeWorker(
  executors: ExecutorTable,
  options: WorkerFixtureOptions = {},
): { queue: FakeQueue; worker: WorkerHandle } {
  const queue = new FakeQueue({ now: (): number => nowMs })
  const worker = startWorker({
    queue,
    executors,
    deps: options.circuits === undefined ? {} : { circuits: options.circuits },
    owner: 'worker-test',
    now: (): number => nowMs,
    autoStart: options.autoStart ?? false,
    concurrency: options.concurrency ?? 1,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  return { queue, worker }
}

function enqueue(queue: FakeQueue, kind: TaskKind, dedupeKey: string, payload: Record<string, unknown> = {}): TaskRecord {
  return queue.enqueue({ kind, dedupeKey, payload })
}

function captureLogs(): { logger: Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = []
  const logger = createLogger({
    name: 'worker-test',
    level: 'debug',
    sink: (line: string): void => {
      entries.push(JSON.parse(line) as Record<string, unknown>)
    },
  })
  return { logger, entries }
}

async function makeCircuit(): Promise<CircuitBreaker> {
  await mkdir(CIRCUIT_DIR, { recursive: true })
  circuitSeq += 1
  return new CircuitBreaker({ path: join(CIRCUIT_DIR, 'circuit-' + String(circuitSeq) + '.json'), now: (): number => nowMs })
}

test('成功执行后 ack，统计 done 并透传 accountId', async () => {
  let seenAccount: string | undefined
  const { queue, worker } = makeWorker(executorFor('probe', async (_task, ctx): Promise<void> => {
    seenAccount = ctx.accountId
  }))
  const task = enqueue(queue, 'probe', 'ok-1', { accountId: 'a1' })
  await worker.tick()
  assert.equal(seenAccount, 'a1')
  assert.equal(queue.get(task.id)?.state, 'done')
  const stats = worker.stats()
  assert.equal(stats.leased, 1)
  assert.equal(stats.done, 1)
  assert.equal(stats.failed, 0)
  assert.equal(stats.errors, 0)
  await worker.stop()
})

test('NETWORK 失败可重试，并透传执行器给的 retryAfterMs', async () => {
  const { queue, worker } = makeWorker(executorFor('probe', async (): Promise<void> => {
    throw new XianyuError({ code: 'NETWORK', message: '网关超时', details: { retryAfterMs: 5000 } })
  }))
  const task = enqueue(queue, 'probe', 'net-1', { accountId: 'a1' })
  await worker.tick()
  const record = queue.get(task.id)
  assert.equal(record?.state, 'queued')
  assert.equal(record?.availableAt, nowMs + 5000)
  assert.equal(record?.lastError, '网关超时')
  assert.equal(queue.failCalls[0]?.options?.retryAfterMs, 5000)
  assert.equal(queue.failCalls[0]?.options?.nonRetryable, undefined)
  assert.equal(worker.stats().failed, 1)
  await worker.stop()
})

test('可重试失败没有 retryAfterMs 时走队列默认退避', async () => {
  const { queue, worker } = makeWorker(executorFor('probe', async (): Promise<void> => {
    throw new XianyuError({ code: 'RATE_LIMITED', message: '本地限流' })
  }))
  const task = enqueue(queue, 'probe', 'rate-1', { accountId: 'a1' })
  await worker.tick()
  assert.equal(queue.get(task.id)?.state, 'queued')
  assert.equal(queue.get(task.id)?.availableAt, nowMs + 1000)
  assert.equal(queue.failCalls[0]?.options?.retryAfterMs, undefined)
  assert.equal(queue.failCalls[0]?.options?.nonRetryable, undefined)
  await worker.stop()
})

test('VALIDATION 不可重试：直接 failed', async () => {
  const { queue, worker } = makeWorker(executorFor('publish', async (): Promise<void> => {
    throw new XianyuError({ code: 'VALIDATION', message: '标题过长' })
  }))
  const task = enqueue(queue, 'publish', 'bad-1', { accountId: 'a1' })
  await worker.tick()
  assert.equal(queue.get(task.id)?.state, 'failed')
  assert.equal(queue.failCalls[0]?.options?.nonRetryable, true)
  await worker.stop()
})

test('非 XianyuError 兜底为 INTERNAL 且不可重试', async () => {
  const { queue, worker } = makeWorker(executorFor('probe', async (): Promise<void> => {
    throw new Error('boom')
  }))
  const task = enqueue(queue, 'probe', 'boom-1', { accountId: 'a1' })
  await worker.tick()
  const record = queue.get(task.id)
  assert.equal(record?.state, 'failed')
  assert.equal(record?.lastError, 'boom')
  assert.equal(queue.failCalls[0]?.options?.nonRetryable, true)
  await worker.stop()
})

test('没有注册执行器：按不可重试失败处理', async () => {
  const { queue, worker } = makeWorker({})
  const task = enqueue(queue, 'deliver', 'no-exec-1', { accountId: 'a1' })
  await worker.tick()
  const record = queue.get(task.id)
  assert.equal(record?.state, 'failed')
  assert.ok((record?.lastError ?? '').includes('没有注册执行器'))
  assert.equal(queue.failCalls[0]?.options?.nonRetryable, true)
  await worker.stop()
})

test('RISK_CONTROL 会 trip 熔断器并按冷却时间推迟重试', async () => {
  const circuit = await makeCircuit()
  const { queue, worker } = makeWorker(executorFor('publish', async (): Promise<void> => {
    throw new XianyuError({ code: 'RISK_CONTROL', message: 'RGV587_ERROR 触发风控' })
  }), { circuits: circuit })
  const task = enqueue(queue, 'publish', 'risk-1', { accountId: 'a1' })
  await worker.tick()
  assert.equal(circuit.isOpen('a1'), true)
  assert.equal(queue.failCalls[0]?.options?.retryAfterMs, 600_000)
  assert.equal(queue.failCalls[0]?.options?.nonRetryable, undefined)
  assert.equal(queue.get(task.id)?.state, 'queued')
  await worker.stop()
})

test('同账号串行：第二个任务被释放，下一轮 tick 才执行', async () => {
  let active = 0
  let maxActive = 0
  const order: string[] = []
  const { queue, worker } = makeWorker(executorFor('probe', async (task): Promise<void> => {
    order.push(task.id)
    active += 1
    maxActive = Math.max(maxActive, active)
    await Promise.resolve()
    active -= 1
  }), { concurrency: 2 })
  const first = enqueue(queue, 'probe', 'serial-1', { accountId: 'a1' })
  const second = enqueue(queue, 'probe', 'serial-2', { accountId: 'a1' })
  await worker.tick()
  assert.deepEqual(order, [first.id])
  assert.equal(queue.get(second.id)?.state, 'queued')
  await worker.tick()
  assert.deepEqual(order, [first.id, second.id])
  assert.equal(maxActive, 1)
  assert.equal(queue.stats().done, 2)
  await worker.stop()
})

test('不同账号可以并发执行', async () => {
  const gate = deferred<void>()
  const bothStarted = deferred<void>()
  let started = 0
  const { queue, worker } = makeWorker(executorFor('probe', async (): Promise<void> => {
    started += 1
    if (started === 2) bothStarted.resolve()
    await gate.promise
  }), { concurrency: 2 })
  enqueue(queue, 'probe', 'conc-1', { accountId: 'a1' })
  enqueue(queue, 'probe', 'conc-2', { accountId: 'a2' })
  const tickPromise = worker.tick()
  await waitUntil(() => started === 2, '两个账号的任务同时在飞')
  gate.resolve()
  await tickPromise
  assert.equal(queue.stats().done, 2)
  await worker.stop()
})

test('concurrency 限制单轮领取数量', async () => {
  const gate = deferred<void>()
  let started = 0
  const { queue, worker } = makeWorker(executorFor('probe', async (): Promise<void> => {
    started += 1
    await gate.promise
  }), { concurrency: 2 })
  enqueue(queue, 'probe', 'cap-1', { accountId: 'a1' })
  enqueue(queue, 'probe', 'cap-2', { accountId: 'a2' })
  const task3 = enqueue(queue, 'probe', 'cap-3', { accountId: 'a3' })
  const tickPromise = worker.tick()
  await waitUntil(() => started === 2, '前两个任务开始')
  assert.equal(queue.stats().queued, 1)
  assert.equal(queue.get(task3.id)?.state, 'queued')
  gate.resolve()
  await tickPromise
  await worker.tick()
  assert.equal(started, 3)
  assert.equal(queue.stats().done, 3)
  await worker.stop()
})

test('stop 会 abort 在飞任务并 release，不计失败', async () => {
  const started = deferred<void>()
  const { queue, worker } = makeWorker(executorFor('probe', async (_task, ctx): Promise<void> => {
    started.resolve()
    await new Promise<never>((_resolve, reject): void => {
      ctx.signal.addEventListener('abort', (): void => {
        reject(new XianyuError({ code: 'NETWORK', message: '已取消' }))
      }, { once: true })
    })
  }))
  const task = enqueue(queue, 'probe', 'stop-1', { accountId: 'a1' })
  const tickPromise = worker.tick()
  await started.promise
  await worker.stop()
  await tickPromise
  assert.equal(queue.get(task.id)?.state, 'queued')
  assert.equal(worker.stats().failed, 0)
  assert.equal(worker.stats().done, 0)
})

test('stop 幂等，且停止后 tick 不再领取任务', async () => {
  const { queue, worker } = makeWorker(executorFor('probe', async (): Promise<void> => {}))
  const firstStop = worker.stop()
  const secondStop = worker.stop()
  await Promise.all([firstStop, secondStop])
  const task = enqueue(queue, 'probe', 'after-stop', { accountId: 'a1' })
  await worker.tick()
  assert.equal(queue.get(task.id)?.state, 'queued')
  assert.equal(worker.stats().leased, 0)
})

test('tick 内队列异常被兜底：errors/lastError 记录后循环继续', async () => {
  const { queue, worker } = makeWorker(executorFor('probe', async (): Promise<void> => {}))
  queue.leaseError = new Error('lease 挂了')
  await worker.tick()
  assert.equal(worker.stats().errors, 1)
  assert.equal(worker.stats().lastError, 'lease 挂了')
  queue.leaseError = undefined
  const task = enqueue(queue, 'probe', 'recover-1', { accountId: 'a1' })
  await worker.tick()
  assert.equal(queue.get(task.id)?.state, 'done')
  await worker.stop()
})

test('每任务一条 info 日志：taskId/kind/state/durationMs', async () => {
  const { logger, entries } = captureLogs()
  const { queue, worker } = makeWorker(executorFor('probe', async (task): Promise<void> => {
    if (task.dedupeKey === 'log-bad') throw new XianyuError({ code: 'VALIDATION', message: '参数非法' })
  }), { logger, concurrency: 2 })
  const okTask = enqueue(queue, 'probe', 'log-ok', { accountId: 'a1' })
  const badTask = enqueue(queue, 'probe', 'log-bad', { accountId: 'a2' })
  await worker.tick()
  const taskLogs = entries.filter((entry) => entry['msg'] === '任务执行完成' || entry['msg'] === '任务执行失败')
  assert.equal(taskLogs.length, 2)
  const okLog = taskLogs.find((entry) => entry['taskId'] === okTask.id)
  const badLog = taskLogs.find((entry) => entry['taskId'] === badTask.id)
  assert.equal(okLog?.['state'], 'done')
  assert.equal(badLog?.['state'], 'failed')
  assert.equal(badLog?.['code'], 'VALIDATION')
  assert.equal(okLog?.['kind'], 'probe')
  assert.equal(typeof okLog?.['durationMs'], 'number')
  await worker.stop()
})

test('autoStart 默认开启：定时轮询自动执行', async () => {
  let calls = 0
  const { queue, worker } = makeWorker(executorFor('probe', async (): Promise<void> => {
    calls += 1
  }), { autoStart: true, pollIntervalMs: 5 })
  enqueue(queue, 'probe', 'auto-1', { accountId: 'a1' })
  await waitUntil(() => queue.stats().done === 1, '自动轮询执行完毕')
  assert.equal(calls, 1)
  await worker.stop()
})
