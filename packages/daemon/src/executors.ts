/**
 * P1.1 任务执行器：把任务 kind 映射到通道能力，并统一处理凭据、限流、熔断与落库。
 *
 * 设计要点：
 * - 执行器只依赖 OperationPort（由 cli 装配成真实 mtop/CDP 实现，测试注入 fake），
 *   这样任务生命周期逻辑（校验、限流、熔断、items 落库）可以脱离网络单测。
 * - 通道错误按 XianyuError 上抛，worker 负责 ack/fail；执行器只补 retryAfterMs 之类的上下文。
 * - 写操作一律先过 RateLimiter 的 'write' 桶（同账号串行由 worker 保证，桶是跨任务的全局限速）。
 * @module @bigfish/daemon/executors
 */
import { XianyuError, checkListing, fail } from '@bigfish/core'
import type { CredentialRecord, CredentialSaveInput, ItemState } from '@bigfish/core'

import type { ExecuteContext, ExecutorTable, TaskExecutor } from './executor.ts'
import { emitTaskStep } from './event-emit.ts'
import {
  requireAccountId,
  requireDeliver,
  requireDraft,
  requireField,
  requireReply,
} from './task-payload.ts'
import type { DeliverRequest, PublishDraft, ReplyRequest } from './task-payload.ts'

// 载荷形状规则住在 task-payload.ts（入队期与执行期共用一份）；这里转出类型，
// 免得 cdp-publish / im-client / operations 的 import 路径全改一遍。
export type { DeliverRequest, PublishDraft, ReplyRequest } from './task-payload.ts'

/** 一次通道调用使用的登录态。 */
export interface Session {
  accountId: string
  cookies: Record<string, string>
  deviceId?: string
  /**
   * 令牌过期刷新后的 cookie 回写钩子（合并后的完整 cookie 表）。
   * 凭据层不可写时不设这个字段，通道层据此放弃自动刷新、直接上抛 AUTH_EXPIRED。
   */
  onSessionUpdate?: (cookies: Record<string, string>) => void | Promise<void>
}

/** 详情快照（probe 落库用）。 */
export interface DetailSnapshot {
  itemId: string
  title: string
  priceCents: number
  state: ItemState
}

/** 通道能力集合；真实实现见 cli.ts 的装配，测试用 fake。 */
export interface OperationPort {
  fetchItemDetail(input: { session: Session; itemId: string; signal: AbortSignal }): Promise<DetailSnapshot>
  polishItem(input: { session: Session; itemId: string; signal: AbortSignal }): Promise<void>
  publishItem(input: {
    session: Session
    draft: PublishDraft
    signal: AbortSignal
    /** 通道每步回调（步骤名 + 「开始」/「完成」/「失败：…」）；由执行器转成任务事件。 */
    onStep?: (step: string, message: string) => void
  }): Promise<{ itemId?: string }>
  deliverOrder(input: { session: Session; deliver: DeliverRequest; signal: AbortSignal }): Promise<{ delivered: boolean }>
  sendReply(input: { session: Session; reply: ReplyRequest; signal: AbortSignal }): Promise<void>
  /**
   * 只读探测登录态是否有效（head 接口）。
   * 不占限流桶、不写库：这是面板的即时查询，不是队列任务；刷新回写仍走 session.onSessionUpdate。
   */
  verifySession(input: { session: Session }): Promise<void>
}

/** 执行器装配参数：只需要通道能力；凭据/限流/熔断/items 都从 ExecuteContext 取。 */
export interface ExecutorOptions {
  ports: OperationPort
}

/** 限流桶：读接口用 read，写接口（发布/擦亮/发货/回消息）用 write。 */
type Bucket = 'read' | 'write'

/**
 * 构造五种执行器。
 * 未传 limiter/credentials 时对应检查跳过（P0 集成测试用），生产装配必须都传。
 */
export function createExecutors(options: ExecutorOptions): ExecutorTable {
  const ports = options.ports

  const probe: TaskExecutor = {
    kind: 'probe',
    async execute(task, ctx) {
      const accountId = requireAccountId(task.payload)
      const itemId = requireField(task.payload, 'itemId')
      const session = await requireSession(ctx, accountId)
      await checkCircuit(ctx, accountId)
      await spend(ctx, 'read', accountId)
      const snapshot = await ports.fetchItemDetail({ session, itemId, signal: ctx.signal })
      ctx.items?.upsert({
        itemId: snapshot.itemId,
        accountId,
        title: snapshot.title,
        priceCents: snapshot.priceCents,
        state: snapshot.state,
      })
    },
  }

  const polish: TaskExecutor = {
    kind: 'polish',
    async execute(task, ctx) {
      const accountId = requireAccountId(task.payload)
      const itemId = requireField(task.payload, 'itemId')
      const session = await requireSession(ctx, accountId)
      await checkCircuit(ctx, accountId)
      await spend(ctx, 'write', accountId)
      await ports.polishItem({ session, itemId, signal: ctx.signal })
    },
  }

  const publish: TaskExecutor = {
    kind: 'publish',
    async execute(task, ctx) {
      const accountId = requireAccountId(task.payload)
      const draft = requireDraft(task.payload)
      requirePolicy(draft)
      const session = await requireSession(ctx, accountId)
      await checkCircuit(ctx, accountId)
      await spend(ctx, 'write', accountId)
      // 步骤事件写进 task_events：面板工作流树与失败诊断都靠它，见 event-emit.ts。
      const onStep = (step: string, message: string): void => emitTaskStep(ctx, task, step, message)
      const result = await ports.publishItem({ session, draft, signal: ctx.signal, onStep })
      if (result.itemId !== undefined && ctx.items !== undefined) {
        ctx.items.upsert({
          itemId: result.itemId,
          accountId,
          title: draft.title,
          priceCents: draft.priceCents,
          state: 'online',
        })
      }
    },
  }

  const deliver: TaskExecutor = {
    kind: 'deliver',
    async execute(task, ctx) {
      const accountId = requireAccountId(task.payload)
      const request = requireDeliver(task.payload)
      const session = await requireSession(ctx, accountId)
      await checkCircuit(ctx, accountId)
      await spend(ctx, 'write', accountId)
      await ports.deliverOrder({ session, deliver: request, signal: ctx.signal })
    },
  }

  const reply: TaskExecutor = {
    kind: 'reply',
    async execute(task, ctx) {
      const accountId = requireAccountId(task.payload)
      const request = requireReply(task.payload)
      const session = await requireSession(ctx, accountId)
      await checkCircuit(ctx, accountId)
      await spend(ctx, 'write', accountId)
      await ports.sendReply({ session, reply: request, signal: ctx.signal })
    },
  }

  return { probe, polish, publish, deliver, reply } satisfies ExecutorTable
}

/** 熔断中直接拒绝：retryAfterMs 让队列把任务推后，而不是立刻重试。 */
async function checkCircuit(ctx: ExecuteContext, accountId: string): Promise<void> {
  if (ctx.circuits === undefined) return
  if (!ctx.circuits.isOpen(accountId)) return
  const state = ctx.circuits.list().find(entry => entry.accountId === accountId)
  const now = ctx.now?.() ?? Date.now()
  const retryAfterMs = Math.max(1, (state?.until ?? now) - now)
  throw new XianyuError({
    code: 'CIRCUIT_OPEN',
    message: '账号处于风控冷却中：' + accountId,
    details: { retryAfterMs },
  })
}

/** 领取限流预算；失败抛 RATE_LIMITED 并带 retryAfterMs（预算不退还）。 */
async function spend(ctx: ExecuteContext, bucket: Bucket, accountId: string): Promise<void> {
  if (ctx.limiter === undefined) return
  const result = ctx.limiter.acquire(bucket, accountId)
  if (result.ok) return
  throw new XianyuError({
    code: 'RATE_LIMITED',
    message: '本地限流：' + accountId + ' 的 ' + bucket + ' 桶已满',
    details: { retryAfterMs: result.retryAfterMs },
  })
}

/** 载入登录态；没有凭据时抛 AUTH_EXPIRED（不可重试，需要人工导入 cookie）。 */
async function requireSession(ctx: ExecuteContext, accountId: string): Promise<Session> {
  if (ctx.credentials === undefined) fail('AUTH_EXPIRED', '未配置凭据库，无法执行需要登录态的任务：' + accountId)
  const record = await ctx.credentials.load(accountId)
  if (record === undefined) fail('AUTH_EXPIRED', '账号没有已保存的登录态：' + accountId)
  const deviceId = record.meta?.['deviceId']
  const onSessionUpdate = sessionWriter(ctx.credentials, record)
  return {
    accountId: record.accountId,
    cookies: record.cookies,
    ...(typeof deviceId === 'string' ? { deviceId } : {}),
    ...(onSessionUpdate === undefined ? {} : { onSessionUpdate }),
  }
}

/**
 * 令牌刷新回写：保存合并后的 cookie，并原样带回 meta（deviceId 等标记丢了会影响后续 IM 鉴权）。
 * 凭据层没有 save 时返回 undefined——宁可不刷新，也不假装回写成功。
 */
function sessionWriter(
  credentials: NonNullable<ExecuteContext['credentials']>,
  record: CredentialRecord,
): ((cookies: Record<string, string>) => Promise<void>) | undefined {
  const save = credentials.save
  if (save === undefined) return undefined
  return async (cookies: Record<string, string>): Promise<void> => {
    const input: CredentialSaveInput = {
      accountId: record.accountId,
      cookies,
      ...(record.meta === undefined ? {} : { meta: record.meta }),
    }
    await save.call(credentials, input)
  }
}

/** 本地策略校验：把能在本地判定的违规挡在通道调用之前（error 级直接拒绝）。 */
function requirePolicy(draft: PublishDraft): void {
  const result = checkListing({
    title: draft.title,
    description: draft.desc,
    priceCents: draft.priceCents,
    imageCount: draft.images.length,
  })
  if (result.ok) return
  const errors = result.issues.filter(issue => issue.severity === 'error').map(issue => issue.code + ':' + issue.message)
  fail('VALIDATION', '发布草稿未通过本地策略校验：' + errors.join('；'), { details: { issues: result.issues } })
}
