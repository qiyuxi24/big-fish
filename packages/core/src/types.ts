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
  /**
   * 批次归属（一次批量发布共享同一 id）；缺省表示单件任务，不属于任何批次。
   * 只做观察用的归属标记：不参与幂等判断，也不改变重试语义。
   */
  batchId?: string
}

/** enqueueWithReceipt 的返回：created=false 表示 dedupeKey 命中已有任务，没有新建、也没重置它。 */
export interface EnqueueReceipt {
  task: TaskRecord
  created: boolean
}

/** 一批任务的聚合视图：counts 覆盖全部状态，items 只是前 200 条明细（total 可能更大）。 */
export interface BatchStats {
  batchId: string
  /** 该批次的任务总数（真实计数，不受明细上限影响）。 */
  total: number
  counts: Record<TaskState, number>
  /** 明细，按 created_at 升序；最多 200 条。 */
  items: TaskRecord[]
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
  /** 批次归属；没有 batch_id 的历史任务/单件任务缺省。 */
  batchId?: string
  createdAt: number
  updatedAt: number
}

/** 标记失败时的额外语义。 */
export interface FailTaskOptions {
  /** 明确不可重试：跳过退避，直接进 failed（用于参数错误、账号无权限一类）。 */
  nonRetryable?: boolean
  /**
   * 指定最早可重试时间（毫秒，相对 now 的延迟）。与指数退避取较大者。
   * 用于平台风控冷却：熔断 10 分钟期间不应该按 60s 退避疯狂重试。
   */
  retryAfterMs?: number
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

/** 商品状态；unknown 表示最近一次抓取失败但历史记录仍在。 */
export type ItemState = 'online' | 'offline' | 'unknown'

/** 商品摘要（P0 只落库不抓取；P1.1 起由 probe 执行器写入）。 */
export interface ItemSummary {
  itemId: string
  accountId: AccountId
  title: string
  priceCents: number
  state: ItemState
  updatedAt: number
}

/** 写商品摘要的入参；updatedAt 缺省用当前时间。 */
export interface ItemUpsertInput {
  itemId: string
  accountId: AccountId
  title: string
  priceCents: number
  state: ItemState
  updatedAt?: number
}

/** 商品列表过滤条件。 */
export interface ItemFilter {
  accountId?: AccountId
  state?: ItemState
  /** 缺省 50，上限 500。 */
  limit?: number
}

/** 商品表读写接口；daemon 执行器与 HTTP 路由只依赖它，不直接碰 SQL。 */
export interface ItemRepository {
  /** 按 itemId 覆盖写；返回落库后的记录。 */
  upsert(input: ItemUpsertInput): ItemSummary
  /** 按 itemId 查；不存在返回 undefined。 */
  get(itemId: string): ItemSummary | undefined
  list(filter?: ItemFilter): ItemSummary[]
  count(accountId?: AccountId): number
}

/** IPC 响应信封：错误永远走 `ok:false`，不借用 HTTP 状态码表达业务错误。 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }

export interface ApiError {
  /** 稳定错误码，与 XianyuError.code 一致。 */
  code: string
  message: string
  /** 可重试提示；false 表示重试无意义。 */
  retryable: boolean
  /**
   * 结构化上下文（可选）：失败的字段名、在飞的任务 id、冷却剩余毫秒等。
   * 为什么要在信封里带上：agent 拿到 `code + message` 只能猜，拿到 details 才能自己修。
   * 出站前已过 redact，不得写入 cookie / token 一类凭据。
   */
  details?: Record<string, unknown>
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
  /** worker 计数（未注入 worker 时缺省）；让插件能判断"任务到底有没有人执行"。 */
  worker?: {
    leased: number
    done: number
    failed: number
    errors: number
  }
  /**
   * 这条 daemon 真实具备的写能力。
   *
   * 为什么要有：入队接口对所有 kind 都回 201，`deliver` 却必然 failed、`publish` 没开
   * BF_PUBLISH_SUBMIT 时也必然 failed。agent 拿不到这个信息就只能「先入队再等失败」，
   * 把一次确定性的拒绝变成一次脏任务。这里把「现在到底能做什么」在 /status 里说清楚。
   */
  capabilities?: DaemonCapabilities
}

/** daemon 当前装配了哪些写通道（读接口总是可用，不在此列）。 */
export interface DaemonCapabilities {
  /** publish: submit=真提交；dry-run=只填表；off=未装配。 */
  publish: 'submit' | 'dry-run' | 'off'
  /** polish 走 mtop 写接口，凭据齐备即可用。 */
  polish: boolean
  /** deliver 目前没有任何执行器实现，恒 false。 */
  deliver: boolean
  /** reply 需要 BF_IM=1 且账号 IM 连接 ready。 */
  reply: boolean
}