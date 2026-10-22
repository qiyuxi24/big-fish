/**
 * worker：队列租约循环 + 失败映射。
 *
 * 职责边界（为什么单独一层）：
 * - worker 只认 core 的 TaskQueue 契约与 executor.ts 的执行器契约，不碰通道实现；
 * - 执行器负责业务与通道错误（XianyuError），worker 负责把错误翻译成队列语义
 *   （ack / 可重试失败 / 不可重试失败 / 风控熔断后推迟）。
 *
 * 并发模型：
 * - 一个实例一个「在飞集合」；每个 tick 按 concurrency - 在飞数 领取任务。
 * - 同一 accountId 最多一个任务在飞：后领取到的同账号任务立刻 release，等下一个
 *   poll 周期再试（不忙等）。不同账号互不阻塞。
 * - tick 串行（ticking 标记），循环 await 本轮启动的任务，因此不会堆积 tick。
 *
 * @module @bigfish/daemon/worker
 */
import { XianyuError, redactString, toXianyuError } from '@bigfish/core'
import type { ErrorCode, FailTaskOptions, LogFields, Logger, TaskQueue, TaskRecord } from '@bigfish/core'

import type { ExecuteContext, ExecutorDeps, ExecutorTable } from './executor.ts'
import { emitTaskState } from './event-emit.ts'

const DEFAULT_LEASE_TTL_MS = 60_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_CONCURRENCY = 1
/** 兜底风控冷却：与 core CircuitBreaker 默认 cooldownMs 一致，取不到熔断器时用。 */
const CIRCUIT_COOLDOWN_MS = 600_000

/** 这些 code 重试没有意义，直接进 failed（等人工处理），不占用退避窗口。 */
const NON_RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'VALIDATION',
  'AUTH_EXPIRED',
  'UNSUPPORTED',
  'INTERNAL',
  'UNAUTHORIZED',
  'UNKNOWN',
])

/** 每任务一条 info 日志的 state 字段。 */
type WorkerLogState = 'done' | 'failed' | 'released' | 'skipped'

const LOG_MESSAGES: Record<WorkerLogState, string> = {
  done: '任务执行完成',
  failed: '任务执行失败',
  released: '任务已释放',
  skipped: '任务推迟（同账号有任务在飞）',
}

export interface WorkerOptions {
  queue: TaskQueue
  executors: ExecutorTable
  deps: ExecutorDeps
  /** 租约持有者（daemon 实例 id），写进 TaskRecord.leaseOwner。 */
  owner: string
  /** 租约时长，默认 60s；执行超过这个时长需要靠心跳续约，P1.1 暂不续。 */
  leaseTtlMs?: number
  /** 空闲轮询间隔，默认 1s。 */
  pollIntervalMs?: number
  /** 同时在飞的任务数上限，默认 1（同账号另有串行约束）。 */
  concurrency?: number
  now?: () => number
  logger?: Logger
  /**
   * 是否自动开始轮询，默认 true。
   * 测试里传 false 并用 tick() 手动驱动，避免依赖真实定时器。
   */
  autoStart?: boolean
}

export interface WorkerStats {
  /** 累计从队列领取到的任务数（含因账号占用被 release 的）。 */
  leased: number
  /** 成功 ack 的任务数。 */
  done: number
  /** 映射为失败（可重试或不可重试）的任务数。 */
  failed: number
  /** tick 循环内被捕获的异常次数（队列读写异常、熔断器异常等）。 */
  errors: number
  /** 最近一次内部异常（已脱敏）。 */
  lastError?: string
}

/** worker 句柄；tick() 供测试与「手动触发一次」使用。 */
export interface WorkerHandle {
  tick(): Promise<void>
  stop(): Promise<void>
  stats(): WorkerStats
}

interface InFlight {
  controller: AbortController
  promise: Promise<void>
}

/** 创建并启动 worker；返回句柄，stop() 后不再轮询。 */
export function startWorker(options: WorkerOptions): WorkerHandle {
  const worker = new Worker(options)
  worker.start()
  return worker
}

class Worker implements WorkerHandle {
  readonly #queue: TaskQueue
  readonly #executors: ExecutorTable
  readonly #deps: ExecutorDeps
  readonly #owner: string
  readonly #leaseTtlMs: number
  readonly #pollIntervalMs: number
  readonly #concurrency: number
  readonly #now: () => number
  readonly #logger: Logger
  readonly #autoStart: boolean
  readonly #inflight = new Map<string, InFlight>()
  /** accountId → 正在执行的任务 id；同账号串行的依据。 */
  readonly #busyAccounts = new Map<string, string>()
  #stats: WorkerStats
  #timer: ReturnType<typeof setTimeout> | undefined
  #stopPromise: Promise<void> | undefined
  #stopped = false
  #ticking = false

  constructor(options: WorkerOptions) {
    if (typeof options.owner !== 'string' || options.owner.trim() === '') {
      throw new TypeError('worker owner 必须是非空字符串')
    }
    this.#queue = options.queue
    this.#executors = options.executors
    this.#deps = options.deps
    this.#owner = options.owner
    this.#leaseTtlMs = requirePositiveInt(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, 'leaseTtlMs')
    this.#pollIntervalMs = requirePositiveInt(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs')
    this.#concurrency = requirePositiveInt(options.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency')
    this.#now = options.now ?? Date.now
    this.#logger = options.logger ?? options.deps.logger ?? createNoopLogger()
    this.#autoStart = options.autoStart ?? true
    this.#stats = { leased: 0, done: 0, failed: 0, errors: 0 }
  }

  start(): void {
    if (this.#stopped || !this.#autoStart || this.#timer !== undefined) return
    this.#arm()
  }

  /** 领取并执行一轮；返回时本轮启动的任务都已 settle（便于测试串行断言）。 */
  async tick(): Promise<void> {
    if (this.#stopped || this.#ticking) return
    this.#ticking = true
    try {
      const capacity = this.#concurrency - this.#inflight.size
      if (capacity <= 0) return
      const leased = this.#lease(capacity)
      if (leased === undefined) return
      const started: Promise<void>[] = []
      for (const task of leased) {
        const pending = this.#accept(task)
        if (pending !== undefined) started.push(pending)
      }
      if (started.length > 0) await Promise.allSettled(started)
    } finally {
      this.#ticking = false
    }
  }

  /** 幂等：重复调用返回同一个 Promise；abort 在飞任务后等它们 release 完。 */
  stop(): Promise<void> {
    const existing = this.#stopPromise
    if (existing !== undefined) return existing
    this.#stopped = true
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    const pending: Promise<void>[] = []
    for (const entry of this.#inflight.values()) {
      entry.controller.abort()
      pending.push(entry.promise)
    }
    const settled = (async (): Promise<void> => {
      await Promise.allSettled(pending)
    })()
    this.#stopPromise = settled
    return settled
  }

  stats(): WorkerStats {
    return { ...this.#stats }
  }

  #lease(capacity: number): TaskRecord[] | undefined {
    try {
      return this.#queue.lease({
        owner: this.#owner,
        limit: capacity,
        ttlMs: this.#leaseTtlMs,
        now: this.#now(),
      })
    } catch (error) {
      this.#recordError(error)
      return undefined
    }
  }

  /** 决定任务是执行还是原地释放；返回 undefined 表示没有启动执行。 */
  #accept(task: TaskRecord): Promise<void> | undefined {
    this.#stats.leased += 1
    if (this.#stopped) {
      this.#releaseTask(task, 'released', 0)
      return undefined
    }
    const accountId = readAccountId(task)
    if (accountId !== undefined && this.#busyAccounts.has(accountId)) {
      // 不忙等：立刻释放回队列，让下一个 poll 周期再领；账号锁在下一次 tick 自然可用。
      this.#releaseTask(task, 'skipped', 0)
      return undefined
    }
    return this.#runTask(task, accountId)
  }

  #runTask(task: TaskRecord, accountId: string | undefined): Promise<void> {
    const controller = new AbortController()
    const running = this.#executeTask(task, accountId, controller.signal)
    this.#inflight.set(task.id, { controller, promise: running })
    if (accountId !== undefined) this.#busyAccounts.set(accountId, task.id)
    return running.finally((): void => {
      this.#inflight.delete(task.id)
      if (accountId !== undefined && this.#busyAccounts.get(accountId) === task.id) {
        this.#busyAccounts.delete(accountId)
      }
    })
  }

  async #executeTask(task: TaskRecord, accountId: string | undefined, signal: AbortSignal): Promise<void> {
    const startedAt = this.#now()
    const executor = this.#executors[task.kind]
    if (executor === undefined) {
      this.#failTask(
        task,
        new XianyuError({ code: 'VALIDATION', message: '没有注册执行器：' + task.kind }),
        { nonRetryable: true },
        startedAt,
      )
      return
    }
    try {
      await executor.execute(task, this.#context(task, accountId, signal))
    } catch (error) {
      if (signal.aborted) {
        // 停机打断不是业务失败，释放回队列让下个进程实例重跑。
        this.#releaseTask(task, 'released', 0)
        return
      }
      this.#mapFailure(task, accountId, error, startedAt)
      return
    }
    this.#ackTask(task, startedAt)
  }

  #context(task: TaskRecord, accountId: string | undefined, signal: AbortSignal): ExecuteContext {
    return {
      ...this.#deps,
      task,
      signal,
      ...(accountId === undefined ? {} : { accountId }),
    }
  }

  #mapFailure(task: TaskRecord, accountId: string | undefined, error: unknown, startedAt: number): void {
    const failure = toXianyuError(error, 'INTERNAL')
    const circuits = this.#deps.circuits
    if (failure.code === 'RISK_CONTROL' && accountId !== undefined && circuits !== undefined) {
      try {
        circuits.trip(accountId, failure.message)
      } catch (tripError) {
        // 熔断落盘失败不能阻止任务失败入队，否则会反复重试触发更严风控。
        this.#recordError(tripError)
      }
      this.#failTask(task, failure, { retryAfterMs: circuits.cooldownMs }, startedAt)
      return
    }
    if (NON_RETRYABLE_CODES.has(failure.code)) {
      this.#failTask(task, failure, { nonRetryable: true }, startedAt)
      return
    }
    const retryAfterMs = readRetryAfterMs(failure.details)
    this.#failTask(task, failure, retryAfterMs === undefined ? {} : { retryAfterMs }, startedAt)
  }

  #ackTask(task: TaskRecord, startedAt: number): void {
    try {
      this.#queue.ack(task.id, this.#owner)
    } catch (error) {
      this.#recordError(error)
      return
    }
    this.#stats.done += 1
    this.#log(task, 'done', this.#now() - startedAt)
    emitTaskState(this.#deps, task, 'done')
  }

  #failTask(task: TaskRecord, failure: XianyuError, options: FailTaskOptions, startedAt: number): void {
    try {
      this.#queue.fail(task.id, this.#owner, failure, options)
    } catch (error) {
      this.#recordError(error)
      return
    }
    this.#stats.failed += 1
    this.#log(task, 'failed', this.#now() - startedAt, { code: failure.code })
    // 状态以队列落地后为准：可重试失败可能是 queued，不可重试是 failed，超限是 needs_review。
    emitTaskState(this.#deps, task, this.#queue.get(task.id)?.state ?? 'failed', {
      code: failure.code,
      message: failure.message,
    })
  }

  #releaseTask(task: TaskRecord, state: 'released' | 'skipped', durationMs: number): void {
    try {
      this.#queue.release(task.id, this.#owner)
    } catch (error) {
      this.#recordError(error)
      return
    }
    this.#log(task, state, durationMs)
  }

  #recordError(error: unknown): void {
    const failure = toXianyuError(error, 'INTERNAL')
    this.#stats.errors += 1
    this.#stats.lastError = redactString(failure.message)
    this.#logger.error('worker 内部错误', { code: failure.code, message: failure.message })
  }

  #log(task: TaskRecord, state: WorkerLogState, durationMs: number, extra: LogFields = {}): void {
    this.#logger.info(LOG_MESSAGES[state], {
      taskId: task.id,
      kind: task.kind,
      state,
      durationMs: Math.max(0, Math.trunc(durationMs)),
      ...extra,
    })
  }

  #arm(): void {
    if (this.#stopped || this.#timer !== undefined) return
    this.#timer = setTimeout((): void => {
      void this.#loopOnce()
    }, this.#pollIntervalMs)
  }

  async #loopOnce(): Promise<void> {
    this.#timer = undefined
    if (this.#stopped) return
    try {
      await this.tick()
    } catch (error) {
      // tick 内部已兜底；这里是最后一道防线，保证循环永远不断。
      this.#recordError(error)
    }
    this.#arm()
  }
}

/** 从 payload 读 accountId；非字符串/空串视为「无账号约束」（串行只对账号任务生效）。 */
function readAccountId(task: TaskRecord): string | undefined {
  const value = task.payload['accountId']
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

/** 执行器可用 details.retryAfterMs 指定最早重试时间（限流、熔断冷却）。 */
function readRetryAfterMs(details: Record<string, unknown>): number | undefined {
  const value = details['retryAfterMs']
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return undefined
  return value
}

function requirePositiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('worker 参数 ' + name + ' 必须是正整数，实际为 ' + String(value))
  }
  return value
}

function createNoopLogger(): Logger {
  const logger: Logger = {
    debug: (): void => {},
    info: (): void => {},
    warn: (): void => {},
    error: (): void => {},
    child: (): Logger => logger,
  }
  return logger
}
