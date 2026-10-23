/**
 * 商品与熔断域路由：已入库商品列表、参考采集（只读）、熔断重置。
 *
 * 为什么单独成文件：这三条都是「账号视角的只读数据 + 一个本地运维动作」，
 * 与任务机的写入路径无关；分出来让任务域文件只剩队列语义。
 * @module @bigfish/daemon/routes-items
 */
import { fail } from '@bigfish/core'
import type { ItemFilter, ItemSummary } from '@bigfish/core'
import { asRecord, ok, readJsonBody, requiredString, sendJson } from './http.ts'
import type { Route, RouteContext } from './routes.ts'
import { isItemState, parsePositiveInt } from './routes-shared.ts'
import { parseReferenceRequest } from './reference.ts'
import type { ReferenceReport, ReferenceRequest } from './reference.ts'

/**
 * 参考采集能力的注入签名；未注入时 POST /reference 返回 UNSUPPORTED。
 * 只读：返回统计原料，不落库、不下载图片（AGENTS §1.6）。
 */
export type ReferenceCollectHandler = (input: ReferenceRequest & { signal: AbortSignal }) => Promise<ReferenceReport>

/** 商品域路由；拼进 routes.ts 的 ROUTES。 */
export const itemRoutes: readonly Route[] = [
  { method: 'POST', pattern: /^\/reference\/?$/, handler: referenceHandler },
  { method: 'GET', pattern: /^\/items\/?$/, handler: listItemsHandler },
  { method: 'POST', pattern: /^\/circuits\/reset\/?$/, handler: resetCircuitHandler },
]

/**
 * 采集参考：只读统计（价格带 / 标题长度 / 类目分布 / 关键词 / 商家量级）。
 * 客户端断开就用 AbortSignal 中止剩余请求：20 件串行最坏要十几秒，用户关页面后不该继续打平台。
 */
async function referenceHandler(ctx: RouteContext): Promise<void> {
  const collect = ctx.referenceCollect ?? fail('UNSUPPORTED', 'daemon 未注入参考采集能力')
  const body = asRecord(await readJsonBody(ctx.req), '参考采集请求体')
  const request = parseReferenceRequest(body)
  const controller = new AbortController()
  const onClose = (): void => {
    controller.abort()
  }
  ctx.res.once('close', onClose)
  try {
    const report = await collect({ ...request, signal: controller.signal })
    await sendJson(ctx.res, 200, ok(report), ctx.redact)
  } finally {
    ctx.res.off('close', onClose)
  }
}

async function listItemsHandler(ctx: RouteContext): Promise<void> {
  const filter: ItemFilter = {}
  const state = ctx.url.searchParams.get('state')
  if (state !== null) {
    if (!isItemState(state)) fail('VALIDATION', 'item state 非法：' + state)
    filter.state = state
  }
  const accountId = ctx.url.searchParams.get('accountId')
  if (accountId !== null) {
    if (accountId === '') fail('VALIDATION', 'accountId 不能为空')
    filter.accountId = accountId
  }
  const limit = ctx.url.searchParams.get('limit')
  if (limit !== null) filter.limit = parsePositiveInt(limit)
  const items: ItemSummary[] = ctx.items?.list(filter) ?? []
  await sendJson(ctx.res, 200, ok(items), ctx.redact)
}

async function resetCircuitHandler(ctx: RouteContext): Promise<void> {
  const body = asRecord(await readJsonBody(ctx.req), '熔断重置请求体')
  const accountId = requiredString(body, 'accountId', '熔断重置请求体')
  ctx.circuits?.reset(accountId)
  await sendJson(ctx.res, 200, ok({ accountId, reset: ctx.circuits !== undefined }), ctx.redact)
}
