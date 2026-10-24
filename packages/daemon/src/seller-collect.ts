/**
 * 「商家商品采集」：把某个商家在售的所有商品逐件读出来、只留结构化元数据、落进本地库。
 *
 * 与 reference.ts 的分工：
 * - reference.ts 是**一次性统计**（不落库，20 件封顶，给面板/工具看价格带）；
 * - 这里是要**留档的行情快照**（分页拉列表 + 逐件详情 + upsert 到 seller_items/sellers）。
 * 两者共用 channel-mtop 的解析层，不重复实现字段映射。
 *
 * 红线（AGENTS §1.6）：只存标题/价格/类目/计数/发布时间，不存描述全文与图片地址；
 * 拉「不是自己的店」必须先由用户显式确认（acknowledgeOther），且只用于看行情。
 * @module @bigfish/daemon/seller-collect
 */
import { fail, XianyuError } from '@bigfish/core'
import type { SellerRepository } from '@bigfish/core'
import {
  MTOP_APIS,
  USER_MTOP_APIS,
  buildItemDetailData,
  buildItemListData,
  buildUserHeadData,
  callMtop,
  parseItemReference,
  parseItemList,
  parseUserHead,
  summarizeReferences,
} from '@bigfish/channel-mtop'
import type {
  ItemListPage,
  MtopTransport,
  ReferenceItem,
  ReferenceSummary,
  UserHeadProfile,
} from '@bigfish/channel-mtop'

/** 一次最多采多少件（每件一次 mtop 调用；写库也要克制，默认 20 与参考采集一致）。 */
export const MAX_SELLER_ITEMS = 60
/** 列表最多翻几页（平台单页上限 20，默认 20 件 = 1 页）。 */
export const MAX_SELLER_PAGES = 3
const DEFAULT_ITEM_LIMIT = 20
const PAGE_SIZE = 20
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const ITEM_ID_RE = /^\d{1,20}$/

/** 采集请求（HTTP body 校验后的形态）。 */
export interface SellerCollectRequest {
  accountId: string
  sellerId: string
  /** 最多采多少件：1..60，缺省 20。 */
  maxItems?: number
  /** 拉别人店铺时必须显式 true（业务红线，不默认放开）。 */
  acknowledgeOther?: boolean
}

/** 采集结果：seller 是主页概览，items 是成功读到的商品，skipped 是失败条目。 */
export interface SellerCollectReport {
  accountId: string
  sellerId: string
  seller: UserHeadProfile
  items: number
  summary: ReferenceSummary
  skipped: string[]
  /** 落库件数（与成功解析件数一致；落库失败会直接抛 STORAGE，不会少报）。 */
  stored: number
  /** true 表示列表还有更多，但被页数/件数上限截断。 */
  truncated: boolean
  /** 是否为当前账号自己的店。 */
  self: boolean
}

/** 采集器入参；cookies 由调用方从凭据层解出。 */
export interface CollectSellerInput {
  accountId: string
  cookies: Readonly<Record<string, string>>
  sellerId: string
  maxItems?: number
  acknowledgeOther?: boolean
  signal?: AbortSignal
  onSessionUpdate?: (cookies: Record<string, string>) => void | Promise<void>
}

export interface SellerCollector {
  collect(input: CollectSellerInput): Promise<SellerCollectReport>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** body → 请求；字段错了直接 VALIDATION（错误信息带字段名，面板能直接展示）。 */
export function parseSellerCollectRequest(input: unknown): SellerCollectRequest {
  if (!isRecord(input)) fail('VALIDATION', '商家采集请求必须是对象')
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
  if (!ACCOUNT_ID_RE.test(accountId) || accountId === '.' || accountId === '..') {
    fail('VALIDATION', 'accountId 非法：' + String(input.accountId).slice(0, 40))
  }
  if (typeof input.sellerId !== 'string' || !ITEM_ID_RE.test(input.sellerId.trim())) {
    fail('VALIDATION', 'sellerId 必须是纯数字串（商家主页链接里的 userId）：' + String(input.sellerId).slice(0, 40))
  }
  const request: SellerCollectRequest = { accountId, sellerId: input.sellerId.trim() }
  if (input.maxItems !== undefined) request.maxItems = parseMaxItems(input.maxItems)
  if (input.acknowledgeOther !== undefined) {
    if (typeof input.acknowledgeOther !== 'boolean') fail('VALIDATION', 'acknowledgeOther 必须是布尔')
    request.acknowledgeOther = input.acknowledgeOther
  }
  return request
}

function parseMaxItems(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_SELLER_ITEMS) {
    fail('VALIDATION', 'maxItems 必须在 1..' + MAX_SELLER_ITEMS + ' 之间：' + String(value).slice(0, 20))
  }
  return value
}

/** 只有「需要人工」的错误才中止整批；单件不支持/字段缺失记进 skipped。 */
function isFatal(error: unknown): boolean {
  if (!(error instanceof XianyuError)) return false
  return error.code === 'AUTH_EXPIRED' || error.code === 'RISK_CONTROL' || error.code === 'UNAUTHORIZED'
}

/**
 * 自己的店判定：page.head 抓包固定 self=false（访客视角），所以用「sellerId === 当前账号 id」判断。
 * sellerId 与凭据里的 unb 不同 → 视为他人店铺，必须 acknowledgeOther 才放行。
 */
function isOwnShop(sellerId: string, accountId: string, cookies: Readonly<Record<string, string>>): boolean {
  const unb = typeof cookies.unb === 'string' ? cookies.unb.trim() : ''
  return sellerId === accountId || (unb !== '' && sellerId === unb)
}

/**
 * 建采集器。transport 由调用方注入（生产 createFetchTransport()，测试给假实现）。
 * 顺序：主页概览 → 分页拉在售列表 → 逐件详情 → upsert 到本地库。
 */
export function createSellerCollector(options: {
  transport: MtopTransport
  sellers: SellerRepository
  now?: () => number
}): SellerCollector {
  const transport = options.transport
  const sellers = options.sellers
  const now = options.now ?? ((): number => Date.now())

  /** 三个读接口共用同一套 session/abort/令牌回写语义。 */
  async function callRead(
    input: CollectSellerInput,
    api: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return callMtop(transport, {
      api,
      data,
      session: { cookies: { ...input.cookies } },
      ...(input.onSessionUpdate === undefined ? {} : { onSessionUpdate: input.onSessionUpdate }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  async function readHead(input: CollectSellerInput): Promise<UserHeadProfile> {
    const raw = await callRead(input, USER_MTOP_APIS.head, buildUserHeadData({ userId: input.sellerId }))
    return parseUserHead(raw, input.sellerId)
  }

  async function readPage(input: CollectSellerInput, pageNumber: number): Promise<ItemListPage> {
    const raw = await callRead(
      input,
      USER_MTOP_APIS.itemList,
      buildItemListData({ userId: input.sellerId, pageNumber, pageSize: PAGE_SIZE }),
    )
    return parseItemList(raw, input.accountId, now())
  }

  async function readDetail(input: CollectSellerInput, itemId: string): Promise<ReferenceItem> {
    const raw = await callRead(input, MTOP_APIS.detail, buildItemDetailData({ itemId }))
    return parseItemReference(raw)
  }

  /**
   * 翻页直到「平台说没有更多」或撞上页数/件数上限。
   * 返回的 truncated 只表示「因为上限提前停了」——平台确实还有货，只是这次没采。
   */
  async function collectIds(input: CollectSellerInput, maxItems: number): Promise<{ ids: string[]; truncated: boolean }> {
    const ids: string[] = []
    let pageNumber = 1
    let hasMore = true
    while (hasMore) {
      if (pageNumber > MAX_SELLER_PAGES) return { ids, truncated: true }
      const page = await readPage(input, pageNumber)
      for (const item of page.items) {
        if (ids.length >= maxItems) return { ids, truncated: true }
        if (!ids.includes(item.itemId)) ids.push(item.itemId)
      }
      hasMore = page.hasMore
      pageNumber += 1
      // 件数刚好到顶但平台说还有：直接收工，不为「确认截断」多打一页。
      if (ids.length >= maxItems && hasMore) return { ids, truncated: true }
    }
    return { ids, truncated: false }
  }

  return {
    async collect(input: CollectSellerInput): Promise<SellerCollectReport> {
      const request = parseSellerCollectRequest({
        accountId: input.accountId,
        sellerId: input.sellerId,
        ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
        ...(input.acknowledgeOther === undefined ? {} : { acknowledgeOther: input.acknowledgeOther }),
      })
      const self = isOwnShop(request.sellerId, request.accountId, input.cookies)
      if (!self && request.acknowledgeOther !== true) {
        fail(
          'UNAUTHORIZED',
          '这不是当前账号的店铺（' + request.sellerId + '）。采集他人店铺需先勾选确认「仅用于看行情、不搬运素材」',
        )
      }
      const maxItems = request.maxItems ?? DEFAULT_ITEM_LIMIT
      const profile = await readHead(input)
      const listed = await collectIds(input, maxItems)
      const items: ReferenceItem[] = []
      const skipped: string[] = []
      for (const itemId of listed.ids) {
        try {
          const parsed = await readDetail(input, itemId)
          sellers.saveItem(toStoredItem(parsed, request))
          items.push(parsed)
        } catch (error) {
          if (isFatal(error)) throw error
          skipped.push(itemId)
        }
      }
      sellers.saveProfile({
        sellerId: request.sellerId,
        ...(profile.displayName === undefined ? {} : { nick: profile.displayName }),
        ...(profile.ipLocation === undefined ? {} : { city: profile.ipLocation }),
        ...(profile.itemCount === undefined ? {} : { itemCount: profile.itemCount }),
        isSelf: self,
        collectedAt: now(),
      })
      return {
        accountId: request.accountId,
        sellerId: request.sellerId,
        seller: profile,
        items: items.length,
        summary: summarizeReferences(items),
        skipped,
        stored: items.length,
        truncated: listed.truncated || (profile.itemCount !== undefined && items.length < profile.itemCount),
        self,
      }
    },
  }
}

/** 详情解析结果 → 仓储入参；只挑白名单字段（不含 desc / 图片地址）。 */
function toStoredItem(item: ReferenceItem, request: SellerCollectRequest) {
  return {
    itemId: item.itemId,
    sellerId: request.sellerId,
    accountId: request.accountId,
    title: item.title,
    priceCents: item.priceCents,
    imageCount: item.imageCount,
    ...(item.originalPriceCents === undefined ? {} : { originalPriceCents: item.originalPriceCents }),
    ...(item.categoryId === undefined ? {} : { categoryId: item.categoryId }),
    ...(item.browseCount === undefined ? {} : { browseCount: item.browseCount }),
    ...(item.wantCount === undefined ? {} : { wantCount: item.wantCount }),
    ...(item.collectCount === undefined ? {} : { collectCount: item.collectCount }),
    ...(item.soldCount === undefined ? {} : { soldCount: item.soldCount }),
    ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
    // 结构特征（只数字与开关）：让面板/工具能看「标题怎么分段、主图什么比例」，原文与图片地址不进库。
    copyFeatures: item.copyFeatures,
    imageFeatures: item.imageFeatures,
  }
}
