/**
 * daemon 执行器契约：worker 只认这个接口，通道与业务解耦。
 *
 * 为什么单独抽一层：P0 的 worker 是「租约循环 + 失败映射」，执行器才是「发布 / 擦亮 /
 * 探测 / 发货」这些会随通道变化的东西。测试用假执行器覆盖 worker 的边界（成功、可重试
 * 失败、不可重试失败、风控熔断、优雅停止），真执行器在 executors.ts 里接通道。
 * @module @bigfish/daemon/executor
 */
import type {
  CircuitBreaker,
  CredentialRecord,
  ItemRepository,
  Logger,
  RateLimiter,
  TaskKind,
  TaskRecord,
} from '@bigfish/core'

/** 执行器可用到的横向能力；全部可注入，便于测试。 */
export interface ExecutorDeps {
  /** 商品表；probe 执行器写它，其它执行器通常不写。 */
  items?: ItemRepository
  /** 账号凭据；读 cookie / token。缺失时执行器应抛 UNAUTHORIZED。 */
  credentials?: {
    load(accountId: string): Promise<CredentialRecord | undefined>
  }
  /** 按账号 + 桶的限流器；写操作前必须 acquire。 */
  limiter?: RateLimiter
  /** 账号级熔断器；写操作前必须 isOpen 检查，命中风控后 trip。 */
  circuits?: CircuitBreaker
  logger?: Logger
  /** 可注入时钟（整数毫秒）。 */
  now?: () => number
}

/** 单次执行的上下文。 */
export interface ExecuteContext extends ExecutorDeps {
  /** 本次领取到的任务记录。 */
  task: TaskRecord
  /** worker 停止或超时会 abort；执行器必须把它合并进 IO 超时。 */
  signal: AbortSignal
  /** payload.accountId 的便捷读出（缺失时 undefined）。 */
  accountId?: string
}

/** 一种任务种类的执行器。抛出的错误由 worker 统一映射成队列语义。 */
export interface TaskExecutor {
  readonly kind: TaskKind
  execute(task: TaskRecord, ctx: ExecuteContext): Promise<void>
}

/** 执行器表：某种 kind 没注册时，worker 会把该任务标为不可重试失败。 */
export type ExecutorTable = Partial<Record<TaskKind, TaskExecutor>>
