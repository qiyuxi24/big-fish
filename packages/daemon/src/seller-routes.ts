/**
 * 「采集」模块的 HTTP 路由：链接解析、商家商品采集入库、读已入库快照。
 *
 * 为什么单独成文件：routes.ts 已经是「队列/账号/设置」的主路由表，采集属于新模块；
 * 用 lifecycle 的同一手法（导出 Route 数组再拼进 ROUTES），不把主表继续撑大。
 * @module @bigfish/daemon/seller-routes
 */
import { fail } from '@bigfish/core'
import type { SellerItemRecord, SellerProfileRecord, SellerRepository } from '@bigfish/core'
import { parseXianyuLink } from '@bigfish/channel-mtop'
import { asRecord, ok, readJsonBody, requiredString, sendJson } from './http.ts'
import { parseSellerCollectRequest } from './seller-collect.ts'
import type { SellerCollectReport, SellerCollectRequest } from './seller-collect.ts'
import type { Route, RouteContext } from './routes.ts'
import { parseLimit } from './routes-shared.ts'

/**
 * 商家商品采集能力的注入签名；未注入时 POST /sellers/collect 返回 UNSUPPORTED。
 * 会**写本地库**，所以插件侧必须走审批门禁（与读类 /reference 不同）。
 */
export type SellerCollectHandler = (
  input: SellerCollectRequest & { signal: AbortSignal },
) => Promise<SellerCollectReport>

/** 商家列表项：平台概览 + 本地已入库件数（面板要显示「已存多少件」）。 */
export type SellerProfileSummary = SellerProfileRecord & { storedCount: number }

const DEFAULT_PROFILES_LIMIT = 50
const DEFAULT_ITEMS_LIMIT = 200
const MAX_ITEMS_LIMIT = 500
const SELLER_ID_RE = /^\d{1,20}$/

/** 采集模块路由；拼进 routes.ts 的 ROUTES。 */
export const sellerRoutes: readonly Route[] = [
  // 纯解析：不发 mtop、不写库，面板「解析」按钮直接用。
  { method: 'POST', pattern: /^\/resolve\/?$/, handler: resolveLinkHandler },
  { method: 'GET', pattern: /^\/sellers\/?$/, handler: listSellersHandler },
  // 精确路径，与下面的带参路径不冲突（collect 不是数字 sellerId）。
  { method: 'POST', pattern: /^\/sellers\/collect\/?$/, handler: collectSellerHandler },
  { method: 'GET', pattern: /^\/sellers\/([^/]+)\/items\/?$/, handler: listSellerItemsHandler },
]

async function resolveLinkHandler(ctx: RouteContext): Promise<void> {
  const body = asRecord(await readJsonBody(ctx.req), '链接解析请求体')
  const link = requiredString(body, 'link', '链接解析请求体')
  await sendJson(ctx.res, 200, ok(parseXianyuLink(link)), ctx.redact)
}

/**
 * 采集并入库：列表 + 逐件详情都是串行 mtop 调用，客户端断开就用 AbortSignal 止损。
 * 落库失败会抛 STORAGE（不会返回「部分成功」的假象）。
 */
async function collectSellerHandler(ctx: RouteContext): Promise<void> {
  const collect = ctx.sellerCollect ?? fail('UNSUPPORTED', 'daemon 未注入商家商品采集能力')
  const body = asRecord(await readJsonBody(ctx.req), '商家采集请求体')
  const request = parseSellerCollectRequest(body)
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

/** 已采集过的商家：平台概览 + 本地件数，最近采集在前。 */
async function listSellersHandler(ctx: RouteContext): Promise<void> {
  const repo: SellerRepository | undefined = ctx.sellerItems
  const limit = parseLimit(ctx.url.searchParams.get('limit'), DEFAULT_PROFILES_LIMIT, MAX_ITEMS_LIMIT)
  const profiles: SellerProfileSummary[] = (repo?.listProfiles(limit) ?? []).map((profile) => ({
    ...profile,
    storedCount: repo?.countItems(profile.sellerId) ?? 0,
  }))
  await sendJson(ctx.res, 200, ok(profiles), ctx.redact)
}

/** 某商家已入库的商品快照；未注入仓储时返回空数组（面板照常渲染）。 */
async function listSellerItemsHandler(ctx: RouteContext): Promise<void> {
  const sellerId = ctx.params[0] ?? fail('VALIDATION', '缺少商家 id')
  if (!SELLER_ID_RE.test(sellerId)) fail('VALIDATION', '商家 id 必须是纯数字串：' + sellerId.slice(0, 40))
  const limit = parseLimit(ctx.url.searchParams.get('limit'), DEFAULT_ITEMS_LIMIT, MAX_ITEMS_LIMIT)
  const repo: SellerRepository | undefined = ctx.sellerItems
  const items: SellerItemRecord[] = repo?.listItems(sellerId, limit) ?? []
  await sendJson(ctx.res, 200, ok({ sellerId, total: repo?.countItems(sellerId) ?? 0, items }), ctx.redact)
}
