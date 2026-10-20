/**
 * 测试用内存 TaskQueue：只实现 server/client 用到的契约，不依赖 core 的 SQLite 实现。
 *
 * 为什么不用真队列：task-8 的测试要验证 HTTP 语义（状态码、信封、幂等），内存实现让
 * 时钟、owner 冲突、重试次数都可控；真队列的行为由 data-queue 的测试负责。
 * @module @bigfish/daemon/test/fake-queue
 */
import { fail } from '@bigfish/core'
import type {
  EnqueueInput,
  FailTaskOptions,
  LeaseOptions,
  TaskFilter,
  TaskKind,
  TaskQueue,
  TaskRecord,
  TaskState,
} from '@bigfish/core'

const KINDS: readonly TaskKind[] = ['publish', 'deliver', 'polish', 'reply', 'probe']
const STATES: readonly TaskState[] = ['queued', 'leased', 'done', 'failed', 'needs_review']
const DEFAULT_MAX_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 1000

/** 假队列构造参数。 */
export interface FakeQueueOptions {
  /** 注入时钟（整数毫秒），默认 Date.now。 */
  now?: () => number
}

/** 内存任务队列。 */
export class FakeQueue implements TaskQueue {
  private readonly now: () => number
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly order: string[] = []
  private nextId = 1
  private closed = false

  constructor(options: FakeQueueOptions = {}) {
    this.now = options.now ?? ((): number => Date.now())
  }

  enqueue(input: EnqueueInput): TaskRecord {
    this.requireOpen()
    if (!KINDS.includes(input.kind)) fail('VALIDATION', 'kind 非法：' + JSON.stringify(input.kind))
    if (typeof input.dedupeKey !== 'string' || input.dedupeKey.trim().length === 0) {
      fail('VALIDATION', 'dedupeKey 必须是非空字符串')
    }
    if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload)) {
      fail('VALIDATION', 'payload 必须是对象')
    }
    const existing = this.findByDedupeKey(input.dedupeKey)
    if (existing !== undefined) return clone(existing)
    const now = this.now()
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    if (!isPositiveInt(maxAttempts)) fail('VALIDATION', 'maxAttempts 必须是正整数')
    const availableAt = input.availableAt ?? now
    if (!Number.isSafeInteger(availableAt)) fail('VALIDATION', 'availableAt 必须是整数毫秒')
    const record: TaskRecord = {
      id: 'task-' + String(this.nextId++),
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      payload: clone(input.payload),
      state: 'queued',
      attempts: 0,
      maxAttempts,
      availableAt,
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(record.id, record)
    this.order.push(record.id)
    return clone(record)
  }

  lease(options: LeaseOptions): TaskRecord[] {
    this.requireOpen()
    const now = options.now ?? this.now()
    if (!isPositiveInt(options.limit)) fail('VALIDATION', 'limit 必须是正整数')
    if (!isPositiveInt(options.ttlMs)) fail('VALIDATION', 'ttlMs 必须是正整数')
    if (options.owner.trim().length === 0) fail('VALIDATION', 'owner 必须是非空字符串')
    const leased: TaskRecord[] = []
    for (const id of this.order) {
      if (leased.length >= options.limit) break
      const record = this.tasks.get(id)
      if (record === undefined || record.state !== 'queued') continue
      if (record.availableAt > now) continue
      record.state = 'leased'
      record.leaseOwner = options.owner
      record.leaseUntil = now + options.ttlMs
      record.attempts += 1
      record.updatedAt = now
      leased.push(clone(record))
    }
    return leased
  }

  ack(id: string, owner: string): void {
    this.requireOpen()
    const record = this.requireLease(id, owner)
    record.state = 'done'
    delete record.leaseOwner
    delete record.leaseUntil
    record.updatedAt = this.now()
  }

  fail(id: string, owner: string, error: string | Error, options?: FailTaskOptions): void {
    this.requireOpen()
    const record = this.requireLease(id, owner)
    record.lastError = error instanceof Error ? error.message : error
    delete record.leaseOwner
    delete record.leaseUntil
    if (options?.nonRetryable === true) record.state = 'failed'
    else if (record.attempts >= record.maxAttempts) record.state = 'needs_review'
    else {
      record.state = 'queued'
      record.availableAt = this.now() + RETRY_BACKOFF_MS
    }
    record.updatedAt = this.now()
  }

  release(id: string, owner: string): void {
    this.requireOpen()
    const record = this.requireLease(id, owner)
    record.state = 'queued'
    delete record.leaseOwner
    delete record.leaseUntil
    record.updatedAt = this.now()
  }

  get(id: string): TaskRecord | undefined {
    this.requireOpen()
    const record = this.tasks.get(id)
    return record === undefined ? undefined : clone(record)
  }

  list(filter: TaskFilter = {}): TaskRecord[] {
    this.requireOpen()
    if (filter.limit !== undefined && !isPositiveInt(filter.limit)) fail('VALIDATION', 'limit 必须是正整数')
    const records: TaskRecord[] = []
    for (const id of this.order) {
      if (filter.limit !== undefined && records.length >= filter.limit) break
      const record = this.tasks.get(id)
      if (record === undefined) continue
      if (filter.state !== undefined && record.state !== filter.state) continue
      if (filter.kind !== undefined && record.kind !== filter.kind) continue
      records.push(clone(record))
    }
    return records
  }

  stats(): Record<TaskState, number> {
    const counts = { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 } satisfies Record<TaskState, number>
    for (const state of STATES) counts[state] = 0
    for (const record of this.tasks.values()) counts[record.state] += 1
    return counts
  }

  close(): void {
    this.closed = true
  }

  private requireOpen(): void {
    if (this.closed) fail('INTERNAL', '队列已关闭')
  }

  private findByDedupeKey(key: string): TaskRecord | undefined {
    for (const record of this.tasks.values()) {
      if (record.dedupeKey === key) return record
    }
    return undefined
  }

  private requireLease(id: string, owner: string): TaskRecord {
    const record = this.tasks.get(id)
    if (record === undefined) fail('VALIDATION', '任务不存在：' + id)
    if (record.state !== 'leased') fail('VALIDATION', '任务未处于租约状态：' + id)
    if (record.leaseOwner !== owner) fail('VALIDATION', '租约持有者不匹配：' + id)
    return record
  }
}

function isPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
