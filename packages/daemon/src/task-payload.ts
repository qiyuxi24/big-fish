/**
 * 任务载荷的形状规则：入队期与执行期共用同一份。
 *
 * 为什么要提前到入队：入队返回 201 之后要等 worker 领走才报「载荷缺少 accountId」，
 * 用户看到的是「先说收到了，三秒后翻脸」。入队那一刻就把必填字段挡掉，错误才算数。
 * 执行器仍在执行前再校验一次（防止绕过 HTTP 直接写队列的路径）。
 *
 * 边界：这里只管形状（必填字段与类型），不管发布策略——策略是业务判断，留在执行器。
 * @module @bigfish/daemon/task-payload
 */
import { fail } from '@bigfish/core'
import type { TaskKind } from '@bigfish/core'

/** 发布草稿：字段与 xy_task_enqueue 的 publish 载荷对齐。 */
export interface PublishDraft {
  title: string
  desc: string
  priceCents: number
  images: string[]
  quantity?: number
  /** 闲鱼类目名（如「电子资料」）；不给就走页面 AI 识别结果。 */
  category?: string
  /** 包邮开关；不给就沿用页面默认（包邮）。 */
  shipping?: 'free' | 'none'
  /** 宝贝所在地文字（如「西北工业大学长安校区星天苑」）；不给就不改地址。 */
  address?: string
}

/** 发货请求：规格双键（itemId+specId）用于卡密匹配。 */
export interface DeliverRequest {
  orderId: string
  itemId?: string
  specId?: string
  content: string
}

/** IM 回消息请求。 */
export interface ReplyRequest {
  cid: string
  text: string
}

/**
 * 每种任务必填的字符串字段。
 * 列出它是为了让报错能直接告诉调用方「缺哪个」，而不是让对方去猜执行器要什么。
 */
export const REQUIRED_PAYLOAD_FIELDS: Record<TaskKind, readonly string[]> = {
  publish: ['accountId', 'title', 'desc', 'priceCents', 'images'],
  deliver: ['accountId', 'orderId', 'content'],
  polish: ['accountId', 'itemId'],
  reply: ['accountId', 'cid', 'text'],
  probe: ['accountId', 'itemId'],
}

/**
 * 入队前的载荷校验：与执行器同一套规则，但提前到入队这一刻。
 *
 * 幂等重放（同一个 dedupeKey 再发一次）如果载荷合法，照旧返回既有任务；
 * 载荷不合法就直接 400——此时队列里根本没有这条任务可言。
 */
export function validateTaskPayload(kind: TaskKind, payload: unknown): void {
  const record = asPayloadRecord(payload)
  try {
    switch (kind) {
      case 'publish':
        requireAccountId(record)
        requireDraft(record)
        return
      case 'deliver':
        requireAccountId(record)
        requireDeliver(record)
        return
      case 'probe':
      case 'polish':
        requireAccountId(record)
        requireField(record, 'itemId')
        return
      case 'reply':
        requireAccountId(record)
        requireReply(record)
        return
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail('VALIDATION', kind + ' 任务载荷校验失败：' + message)
  }
}

/** 载荷必须是普通对象；数组与 null 都不行（队列落库时也要对象）。 */
function asPayloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail('VALIDATION', '任务载荷必须是对象')
  }
  return payload as Record<string, unknown>
}

export function requireAccountId(payload: Record<string, unknown>): string {
  return requireField(payload, 'accountId')
}

export function requireField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.length === 0) fail('VALIDATION', '任务载荷缺少非空字符串字段 ' + key)
  return value
}

export function requireDraft(payload: Record<string, unknown>): PublishDraft {
  const title = requireField(payload, 'title')
  const desc = requireField(payload, 'desc')
  const priceCents = payload['priceCents']
  if (typeof priceCents !== 'number' || !Number.isSafeInteger(priceCents) || priceCents < 0) {
    fail('VALIDATION', '任务载荷的 priceCents 必须是非负整数（分）')
  }
  const images = payload['images']
  if (!Array.isArray(images) || images.some(entry => typeof entry !== 'string')) {
    fail('VALIDATION', '任务载荷的 images 必须是字符串数组')
  }
  const quantity = payload['quantity']
  if (quantity !== undefined && (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1)) {
    fail('VALIDATION', '任务载荷的 quantity 必须是正整数')
  }
  // 分类决定网页端能不能发：选错类目会被判「网页版暂不支持发布此分类」。
  const category = payload['category']
  if (category !== undefined && typeof category !== 'string') {
    fail('VALIDATION', '任务载荷的 category 必须是字符串')
  }
  // 地址决定「必填项预检」能不能过：队列任务不带地址时，网页端「宝贝所在地」为空会被拦下（VALIDATION，不假装成功）。
  const address = payload['address']
  if (address !== undefined && typeof address !== 'string') {
    fail('VALIDATION', '任务载荷的 address 必须是字符串')
  }
  const shipping = payload['shipping']
  if (shipping !== undefined && shipping !== 'free' && shipping !== 'none') {
    fail('VALIDATION', '任务载荷的 shipping 只能是 free 或 none')
  }
  return {
    title,
    desc,
    priceCents,
    images: images as string[],
    ...(quantity === undefined ? {} : { quantity }),
    ...(category === undefined ? {} : { category }),
    ...(shipping === undefined ? {} : { shipping }),
    ...(address === undefined ? {} : { address }),
  }
}

export function requireDeliver(payload: Record<string, unknown>): DeliverRequest {
  const orderId = requireField(payload, 'orderId')
  const content = requireField(payload, 'content')
  const itemId = optionalField(payload, 'itemId')
  const specId = optionalField(payload, 'specId')
  return {
    orderId,
    content,
    ...(itemId === undefined ? {} : { itemId }),
    ...(specId === undefined ? {} : { specId }),
  }
}

export function requireReply(payload: Record<string, unknown>): ReplyRequest {
  return { cid: requireField(payload, 'cid'), text: requireField(payload, 'text') }
}

function optionalField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) fail('VALIDATION', '任务载荷字段 ' + key + ' 必须是非空字符串')
  return value
}
