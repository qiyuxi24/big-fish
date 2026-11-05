/**
 * IM 域路由：连接状态 + 人工回复入口。
 *
 * 为什么回复走「入队」而不是在 HTTP 处理里直接发：
 * 让回复复用队列已有的持久化、重试退避、限流、熔断与审计（executors.ts 的 reply 执行器），
 * 路由层只做参数校验与幂等键生成，HTTP 断开也不会留下「发了一半」的状态。
 *
 * 为什么默认要账号：回复要靠该账号的 wss 长连接发出去；只有一个已保存账号时自动取，
 * 多账号时宁可报错也不猜——猜错就是把话发到别人店里。
 * @module @bigfish/daemon/routes-im
 */
import { createHash } from 'node:crypto'

import { fail } from '@bigfish/core'
import type { EnqueueInput, EnqueueReceipt, TaskQueue, TaskQueueHandle } from '@bigfish/core'

import { asRecord, ok, optionalString, readJsonBody, requiredString, sendJson, sendMappedError } from './http.ts'
import type { Route, RouteContext } from './routes.ts'

/**
 * 默认幂等桶宽度：同一买家、同一句话 5 分钟内重复提交只算一次。
 * 双击/重发很常见，但「5 分钟后又说同样的话」是正常业务，不能用永久键。
 */
const REPLY_BUCKET_MS = 5 * 60_000

/** IM 域路由；拼进 routes.ts 的 ROUTES。 */
export const imRoutes: readonly Route[] = [
  { method: 'GET', pattern: /^\/im\/status\/?$/, handler: imStatusHandler },
  { method: 'POST', pattern: /^\/im\/reply\/?$/, handler: imReplyHandler },
]

/** 连接状态：面板只读诊断；默认关闭时也返回 200（而不是报错），面板才能显示「未开启」。 */
async function imStatusHandler(ctx: RouteContext): Promise<void> {
  if (ctx.im === undefined) {
    await sendJson(ctx.res, 200, ok({ enabled: false, accounts: [] }), ctx.redact)
    return
  }
  await sendJson(ctx.res, 200, ok({ enabled: ctx.im.enabled, accounts: ctx.im.status() }), ctx.redact)
}

/**
 * 入队一条回复任务。
 * 202 而不是 200：这里只保证「已持久化、worker 会发」，真正写出站帧是异步的。
 */
async function imReplyHandler(ctx: RouteContext): Promise<void> {
  requireImEnabled(ctx)
  const body = asRecord(await readJsonBody(ctx.req), '回复请求体')
  const cid = requiredString(body, 'cid', '回复请求体')
  const text = requiredString(body, 'text', '回复请求体')
  const accountId = resolveAccountId(ctx, optionalString(body, 'accountId', '回复请求体'))
  // 显式 dedupeKey 留给调用方做「同一条业务消息重试」；缺省按内容 + 5 分钟桶生成。
  const dedupeKey =
    optionalString(body, 'dedupeKey', '回复请求体') ?? defaultDedupeKey(ctx.now(), accountId, cid, text)
  let receipt: EnqueueReceipt
  try {
    receipt = enqueueWithReceipt(ctx.queue, {
      kind: 'reply',
      dedupeKey,
      payload: { accountId, cid, text },
    })
  } catch (error) {
    await sendMappedError(ctx.res, error, 400, ctx.redact)
    return
  }
  await sendJson(ctx.res, 202, ok({ ...receipt.task, created: receipt.created }), ctx.redact)
}

/** IM 未开启时直接拒绝：入队一条注定 UNSUPPORTED 的任务只会让面板多一条假失败。 */
function requireImEnabled(ctx: RouteContext): void {
  if (ctx.im === undefined || !ctx.im.enabled) {
    fail('UNSUPPORTED', 'IM 通道未开启：设置 BF_IM=1 并重启 daemon 后再回复')
  }
}

/** 账号解析：显式优先；只有一个已保存账号时自动取；0 个或多个都要求显式指定。 */
function resolveAccountId(ctx: RouteContext, explicit: string | undefined): string {
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim()
  const saved = ctx.accounts?.() ?? []
  if (saved.length === 1) {
    const only = saved[0]
    if (only !== undefined) return only
  }
  if (saved.length === 0) fail('VALIDATION', '回复必须指定 accountId：当前没有已保存账号')
  fail('VALIDATION', '回复必须指定 accountId：当前有 ' + String(saved.length) + ' 个账号，无法推断用哪个')
}

/** 默认幂等键：账号 + 会话 + 文本摘要 + 时间桶；文本只留摘要，不把聊天内容写进任务键。 */
function defaultDedupeKey(now: number, accountId: string, cid: string, text: string): string {
  const digest = createHash('sha256').update(cid + '\u0000' + text, 'utf8').digest('hex').slice(0, 16)
  const bucket = Math.floor(now / REPLY_BUCKET_MS)
  return 'im-reply:' + accountId + ':' + cid + ':' + digest + ':' + String(bucket)
}

/** 老队列实现没有 enqueueWithReceipt 时退回 enqueue，并保守地报告 created=true。 */
function enqueueWithReceipt(queue: TaskQueue, input: EnqueueInput): EnqueueReceipt {
  const handle = queue as TaskQueueHandle
  if (typeof handle.enqueueWithReceipt === 'function') return handle.enqueueWithReceipt(input)
  return { task: queue.enqueue(input), created: true }
}
