/**
 * 领域类型与跨包契约。所有包只依赖本文件的类型，不互相 import 实现。
 * 金额一律整数分（cent），时间一律整数毫秒（epoch ms）。
 * @module @bigfish/core/types
 */

/** 闲鱼账号标识：本地生成的稳定 id，不是 unb。 */
export type AccountId = string

/** 队列任务状态机：queued → leased → done | failed → (重试) queued | needs_review。 */
export type TaskState = 'queued' | 'leased' | 'done' | 'failed' | 'needs_review'

/** 任务种类，与 daemon 的执行器一一对应。 */
export type TaskKind = 'publish' | 'deliver' | 'polish' | 'reply' | 'probe'

/** 入队参数。 */
export interface EnqueueInput {
  kind: TaskKind
  /** 幂等键：同一 key 重复入队返回已有任务，不新建。 */
  dedupeKey: string
  /** 执行器私有载荷，必须可 JSON 序列化。 */
  payload: Record<string, unknown>
  /** 最早可执行时间；缺省立即。 */
  availableAt?: number
  maxAttempts?: number
}

/** 持久化后的任务记录。 */
export interface TaskRecord {
  id: string
  kind: TaskKind
  dedupeKey: string
  payload: Record<string, unknown>
  state: TaskState
  attempts: number
  maxAttempts: number
  /** 租约持有者（daemon 实例 id）。 */
  leaseOwner?: string
  /** 租约到期时间，过期任务可被重新领取。 */
  leaseUntil?: number
  /** 下次可尝试时间（失败退避）。 */
  availableAt: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

/** 标记失败时的额外语义。 */
export interface FailTaskOptions {
  /** 明确不可重试：跳过退避，直接进 failed（用于参数错误、账号无权限一类）。 */
  nonRetryable?: boolean
}

/** 任务队列的最小接口；daemon 与测试都只依赖它。 */
export interface TaskQueue {
  enqueue(input: EnqueueInput): TaskRecord
  lease(options: LeaseOptions): TaskRecord[]
  ack(id: string, owner: string): void
  fail(id: string, owner: string, error: string | Error, options?: FailTaskOptions): void
  release(id: string, owner: string): void
  get(id: string): TaskRecord | undefined
  list(filter?: TaskFilter): TaskRecord[]
  stats(): Record<TaskState, number>
  close(): void
}

export interface LeaseOptions {
  owner: string
  limit: number
  ttlMs: number
  now?: number
}

export interface TaskFilter {
  state?: TaskState
  kind?: TaskKind
  limit?: number
}

/** 商品摘要（P0 只落库不抓取）。 */
export interface ItemSummary {
  itemId: string
  accountId: AccountId
  title: string
  priceCents: number
  state: 'online' | 'offline' | 'unknown'
  updatedAt: number
}

/** IPC 响应信封：错误永远走 `ok:false`，不借用 HTTP 状态码表达业务错误。 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }

export interface ApiError {
  /** 稳定错误码，与 XianyuError.code 一致。 */
  code: string
  message: string
  /** 可重试提示；false 表示重试无意义。 */
  retryable: boolean
}

/** daemon 健康与状态快照。 */
export interface DaemonStatus {
  version: string
  uptimeMs: number
  pid: number
  queue: Record<TaskState, number>
  accounts: AccountId[]
  /** 已熔断账号 → 原因。 */
  circuits: Record<string, string>
}
