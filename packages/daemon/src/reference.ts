/**
 * 「参考分析」采集器：只读、串行、有上限。
 *
 * 定位：给「采集参考」模块提供**统计原料**（价格带 / 标题长度 / 类目分布 / 卖点词 / 商家量级），
 * 不产出可发布草稿、不下载图片（AGENTS §1.6 不搬运他人商品；裁决见 docs/repost-feature-parity.md §5）。
 *
 * 为什么放在 daemon 而不是插件：要读加密凭据、要按账号限流、要串行；插件只组装参数。
 * 纯函数部分（解析/统计）在 channel-mtop/reference.ts，这里只做「取数 + 收口 + 失败隔离」。
 * @module @bigfish/daemon/reference
 */
import { fail, XianyuError } from '@bigfish/core'
import {
  MTOP_APIS,
  USER_MTOP_APIS,
  buildItemDetailData,
  buildItemListData,
  buildUserHeadData,
  callMtop,
  parseItemList,
  parseItemReference,
  parseUserHead,
  summarizeReferences,
} from '@bigfish/channel-mtop'
import type { MtopTransport, ReferenceItem, ReferenceSeller, ReferenceSummary, UserHeadProfile } from '@bigfish/channel-mtop'

/** 单次最多分析多少件（读接口也要克制：串行 + 上限，避免把账号跑进风控）。 */
export const MAX_REFERENCE_ITEMS = 20
/** 商家列表默认取一页（平台单页上限 20）。 */
const DEFAULT_PAGE_SIZE = 20
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const ITEM_ID_RE = /^\d{1,20}$/

/** 采集请求（http body 校验后的形态）。itemIds 与 sellerId 至少给一个。 */
export interface ReferenceRequest {
  accountId: string
  itemIds?: string[]
  sellerId?: string
}

/** 采集结果；skipped 是「单条失败但不拖垮整批」的 itemId 列表。 */
export interface ReferenceReport {
  accountId: string
  items: ReferenceItem[]
  summary: ReferenceSummary
  /** 请求里给了 sellerId 才有：商家主页概览。 */
  seller?: UserHeadProfile
  /** 结果里出现过的商家（去重），便于面板显示「这批货是谁家的」。 */
  sellers: ReferenceSeller[]
  skipped: string[]
}

/** 采集器入参；session 由调用方从凭据层解出来（明文 cookie 不进日志、不进返回值）。 */
export interface CollectInput {
  accountId: string
  cookies: Readonly<Record<string, string>>
  itemIds?: string[]
  sellerId?: string
  pageSize?: number
  signal?: AbortSignal
  /** _m_h5_tk 过期时把新 cookie 落盘；不给就不刷新（callMtop 的既有语义）。 */
  onSessionUpdate?: (cookies: Record<string, string>) => void | Promise<void>
}

export interface ReferenceCollector {
  collect(input: CollectInput): Promise<ReferenceReport>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** http body → ReferenceRequest；字段错了直接 VALIDATION（错误信息带字段名，便于面板提示）。 */
export function parseReferenceRequest(input: unknown): ReferenceRequest {
  if (!isRecord(input)) fail('VALIDATION', '参考采集请求必须是对象')
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
  if (!ACCOUNT_ID_RE.test(accountId) || accountId === '.' || accountId === '..') {
    fail('VALIDATION', 'accountId 非法：' + String(input.accountId).slice(0, 40))
  }
  const itemIds = input.itemIds === undefined ? undefined : parseItemIds(input.itemIds)
  const sellerId = input.sellerId === undefined ? undefined : parseSellerId(input.sellerId)
  if (itemIds === undefined && sellerId === undefined) {
    fail('VALIDATION', '参考采集需要 itemIds 或 sellerId 至少一个')
  }
  return {
    accountId,
    ...(itemIds === undefined ? {} : { itemIds }),
    ...(sellerId === undefined ? {} : { sellerId }),
  }
}

function parseItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) fail('VALIDATION', 'itemIds 必须是数组')
  if (value.length === 0) fail('VALIDATION', 'itemIds 不能是空数组')
  if (value.length > MAX_REFERENCE_ITEMS) {
    fail('VALIDATION', 'itemIds 最多 ' + MAX_REFERENCE_ITEMS + ' 条，收到 ' + value.length)
  }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !ITEM_ID_RE.test(entry.trim())) {
      fail('VALIDATION', 'itemId 必须是纯数字串：' + String(entry).slice(0, 40))
    }
    const id = entry.trim()
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function parseSellerId(value: unknown): string {
  if (typeof value !== 'string' || !ITEM_ID_RE.test(value.trim())) {
    fail('VALIDATION', 'sellerId 必须是纯数字串（平台数字 kcUserId）：' + String(value).slice(0, 40))
  }
  return value.trim()
}

/** 只有「需要人工」的错误才中止整批；单件不支持的形态（VALIDATION 等）记进 skipped。 */
function isFatal(error: unknown): boolean {
  if (!(error instanceof XianyuError)) return false
  return error.code === 'AUTH_EXPIRED' || error.code === 'RISK_CONTROL' || error.code === 'UNAUTHORIZED'
}

/**
 * 构造采集器。transport 由调用方注入（生产是 createFetchTransport()，测试给假实现）。
 * 顺序：给了 sellerId 先取商家主页 + 列表 → 再逐件取详情；详情失败逐条记录，不中断。
 */
export function createReferenceCollector(options: { transport: MtopTransport; now?: () => number }): ReferenceCollector {
  const transport = options.transport
  const now = options.now ?? ((): number => Date.now())

  async function callDetail(input: CollectInput, itemId: string): Promise<ReferenceItem> {
    const raw = await callMtop(transport, {
      api: MTOP_APIS.detail,
      data: buildItemDetailData({ itemId }),
      session: { cookies: { ...input.cookies } },
      ...(input.onSessionUpdate === undefined ? {} : { onSessionUpdate: input.onSessionUpdate }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    return parseItemReference(raw)
  }

  async function listSellerItems(input: CollectInput, sellerId: string): Promise<string[]> {
    const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE
    const raw = await callMtop(transport, {
      api: USER_MTOP_APIS.itemList,
      data: buildItemListData({ userId: sellerId, pageNumber: 1, pageSize }),
      session: { cookies: { ...input.cookies } },
      ...(input.onSessionUpdate === undefined ? {} : { onSessionUpdate: input.onSessionUpdate }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const page = parseItemList(raw, input.accountId, now())
    return page.items.map((item) => item.itemId).slice(0, MAX_REFERENCE_ITEMS)
  }

  async function headSeller(input: CollectInput, sellerId: string): Promise<UserHeadProfile> {
    const raw = await callMtop(transport, {
      api: USER_MTOP_APIS.head,
      data: buildUserHeadData({ userId: sellerId }),
      session: { cookies: { ...input.cookies } },
      ...(input.onSessionUpdate === undefined ? {} : { onSessionUpdate: input.onSessionUpdate }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    return parseUserHead(raw, sellerId)
  }

  return {
    async collect(input: CollectInput): Promise<ReferenceReport> {
      const request = parseReferenceRequest({
        accountId: input.accountId,
        ...(input.itemIds === undefined ? {} : { itemIds: input.itemIds }),
        ...(input.sellerId === undefined ? {} : { sellerId: input.sellerId }),
      })
      const sellerProfile = request.sellerId === undefined ? undefined : await headSeller(input, request.sellerId)
      const targets = request.itemIds ?? (await listSellerItems(input, request.sellerId as string))
      const items: ReferenceItem[] = []
      const skipped: string[] = []
      for (const itemId of targets) {
        try {
          items.push(await callDetail(input, itemId))
        } catch (error) {
          if (isFatal(error)) throw error
          skipped.push(itemId)
        }
      }
      const sellerMap = new Map<string, ReferenceSeller>()
      for (const item of items) sellerMap.set(item.seller.sellerId, item.seller)
      return {
        accountId: request.accountId,
        items,
        summary: summarizeReferences(items),
        ...(sellerProfile === undefined ? {} : { seller: sellerProfile }),
        sellers: [...sellerMap.values()],
        skipped,
      }
    },
  }
}
