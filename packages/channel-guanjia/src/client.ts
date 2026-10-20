/**
 * 闲管家开放平台客户端。
 *
 * 签名 / 请求头 / 路径移植自 xian-guanjia（MIT License，
 * Copyright (c) 2025 thefreelight），原实现：
 * research/repos/xian-guanjia/scripts/xian_guanjia.py。
 * 契约见 docs/component-decomposition.md §4.3。
 * @module @bigfish/channel-guanjia
 */

import { XianyuError } from '@bigfish/core'
import { platformFailure } from './errors.ts'
import {
  PATHS,
  pageBody,
  requireId,
  requireNonNegativeInt,
  requireRecord,
  requireText,
  updateProductBody
} from './methods.ts'
import { assertCredentials, canonicalJson, signRequest } from './sign.ts'
import type {
  GuanJiaClientOptions,
  GuanJiaCredentials,
  GuanJiaSignature,
  GuanJiaTransport,
  GuanJiaTransportRequest,
  GuanJiaTransportResponse,
  PageQuery
} from './types.ts'

export const DEFAULT_BASE_URL = 'https://open.goofish.pro'

/** 平台侧强烈建议 ≥15s：网络抖动时过早放弃会白丢配额。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/** 生产传输层：fetch + 默认超时；外部 AbortSignal 与之取并集。 */
export const fetchTransport: GuanJiaTransport = {
  async request(req: GuanJiaTransportRequest): Promise<GuanJiaTransportResponse> {
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    const signal = req.signal === undefined ? timeout : AbortSignal.any([req.signal, timeout])
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal
    })
    return { status: response.status, text: await response.text() }
  }
}

interface Envelope {
  code: number
  msg: string
  data: unknown
}

/**
 * 解析平台响应。平台约定返回 { code, msg, data }；
 * 非 JSON 视为传输层故障（可重试），缺 code 视为契约破坏（不可重试）。
 */
function parseEnvelope(path: string, text: string): Envelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new XianyuError({
      code: 'NETWORK',
      message: `闲管家响应不是合法 JSON（${path}）`,
      retryable: true,
      cause: error,
      details: { path }
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new XianyuError({
      code: 'UNKNOWN',
      message: `闲管家响应结构非预期（${path}）`,
      details: { path }
    })
  }
  const record = parsed as Record<string, unknown>
  const code = record.code
  if (typeof code !== 'number' || !Number.isInteger(code)) {
    throw new XianyuError({
      code: 'UNKNOWN',
      message: `闲管家响应缺少整数 code（${path}）`,
      details: { path }
    })
  }
  return { code, msg: typeof record.msg === 'string' ? record.msg : '', data: record.data }
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl === undefined ? DEFAULT_BASE_URL : baseUrl
  const trimmed = raw.trim().replace(/\/+$/, '')
  // 只接受裸 origin：把 path 拼在 baseUrl 上，带路径或查询会静默打错接口。
  if (!/^https?:\/\/[^/?#]+$/.test(trimmed)) {
    throw new XianyuError({ code: 'VALIDATION', message: `闲管家 baseUrl 非法：${raw}` })
  }
  return trimmed
}

/** 闲管家开放平台客户端：20 个只读/写业务方法，不含代下单。 */
export class GuanJiaClient {
  private readonly credentials: GuanJiaCredentials
  private readonly baseUrl: string
  private readonly transport: GuanJiaTransport
  private readonly now: () => number

  constructor(opts: GuanJiaClientOptions) {
    this.credentials = assertCredentials(opts.credentials)
    this.baseUrl = normalizeBaseUrl(opts.baseUrl)
    this.transport = opts.transport ?? fetchTransport
    this.now = opts.now ?? Date.now
  }

  /** 计算签名（不发送请求）；timestamp 恒为秒。 */
  sign(body: unknown): GuanJiaSignature {
    return signRequest(this.credentials, canonicalJson(body), this.currentTimestamp())
  }

  /** 调用任意接口：code === 0 返回 data，否则抛 XianyuError。 */
  async call<T = unknown>(path: string, body?: unknown): Promise<T> {
    const bodyText = canonicalJson(body)
    const timestamp = this.currentTimestamp()
    const signed = signRequest(this.credentials, bodyText, timestamp)
    let response: GuanJiaTransportResponse
    try {
      response = await this.transport.request({
        url: this.baseUrl + path,
        method: 'POST',
        headers: signed.headers,
        body: bodyText
      })
    } catch (error) {
      throw new XianyuError({
        code: 'NETWORK',
        message: `闲管家请求失败（${path}）`,
        retryable: true,
        cause: error,
        details: { path }
      })
    }
    if (response.status !== 200) {
      throw new XianyuError({
        code: 'NETWORK',
        message: `闲管家返回 HTTP ${response.status}（${path}）`,
        retryable: true,
        cause: response.text.slice(0, 1024),
        details: { path, status: response.status }
      })
    }
    const envelope = parseEnvelope(path, response.text)
    if (envelope.code !== 0) {
      throw platformFailure(path, envelope.code, envelope.msg, envelope.data)
    }
    return envelope.data as T
  }

  // ---- 店铺 ----

  shops(): Promise<unknown> {
    return this.call(PATHS.shops, {})
  }

  // ---- 商品 ----

  categories(): Promise<unknown> {
    return this.call(PATHS.categories, {})
  }

  attributes(categoryId: number): Promise<unknown> {
    return this.call(PATHS.attributes, { category_id: requireId('categoryId', categoryId) })
  }

  productList(params?: PageQuery): Promise<unknown> {
    return this.call(PATHS.productList, pageBody(params))
  }

  productDetail(productId: number): Promise<unknown> {
    return this.call(PATHS.productDetail, { product_id: requireId('productId', productId) })
  }

  skus(productId: number): Promise<unknown> {
    return this.call(PATHS.skus, { product_id: requireId('productId', productId) })
  }

  createProduct(data: Record<string, unknown>): Promise<unknown> {
    return this.call(PATHS.createProduct, requireRecord('data', data))
  }

  createProductsBatch(products: Record<string, unknown>[]): Promise<unknown> {
    if (!Array.isArray(products) || products.length === 0) {
      throw new XianyuError({ code: 'VALIDATION', message: '闲管家批量创建需要非空 products 数组' })
    }
    const items = products.map((product, index) => requireRecord(`products[${index}]`, product))
    return this.call(PATHS.createProductsBatch, { products: items })
  }

  publishProduct(productId: number): Promise<unknown> {
    return this.call(PATHS.publishProduct, { product_id: requireId('productId', productId) })
  }

  unpublishProduct(productId: number): Promise<unknown> {
    return this.call(PATHS.unpublishProduct, { product_id: requireId('productId', productId) })
  }

  updateProduct(productId: number, data: Record<string, unknown>): Promise<unknown> {
    return this.call(PATHS.updateProduct, updateProductBody(productId, data))
  }

  updateStock(productId: number, stock: number, skuId?: number): Promise<unknown> {
    const body: Record<string, unknown> = {
      product_id: requireId('productId', productId),
      stock: requireNonNegativeInt('stock', stock)
    }
    if (skuId !== undefined) body.sku_id = requireId('skuId', skuId)
    return this.call(PATHS.updateStock, body)
  }

  deleteProduct(productId: number): Promise<unknown> {
    return this.call(PATHS.deleteProduct, { product_id: requireId('productId', productId) })
  }

  // ---- 订单 ----

  orderList(params?: PageQuery): Promise<unknown> {
    return this.call(PATHS.orderList, pageBody(params))
  }

  orderDetail(orderId: number): Promise<unknown> {
    return this.call(PATHS.orderDetail, { order_id: requireId('orderId', orderId) })
  }

  orderCards(orderId: number): Promise<unknown> {
    return this.call(PATHS.orderCards, { order_id: requireId('orderId', orderId) })
  }

  shipOrder(orderId: number, logisticsNo: string, logisticsCompany: string): Promise<unknown> {
    return this.call(PATHS.shipOrder, {
      order_id: requireId('orderId', orderId),
      logistics_no: requireText('logisticsNo', logisticsNo),
      logistics_company: requireText('logisticsCompany', logisticsCompany)
    })
  }

  /** price 单位：分（整数）。 */
  updateOrderPrice(orderId: number, price: number): Promise<unknown> {
    return this.call(PATHS.updateOrderPrice, {
      order_id: requireId('orderId', orderId),
      price: requireNonNegativeInt('price', price)
    })
  }

  // ---- 其他 ----

  logisticsCompanies(): Promise<unknown> {
    return this.call(PATHS.logisticsCompanies, {})
  }

  balance(): Promise<unknown> {
    return this.call(PATHS.balance, {})
  }

  private currentTimestamp(): number {
    const ms = this.now()
    if (!Number.isFinite(ms) || ms < 0) {
      throw new XianyuError({ code: 'INTERNAL', message: '闲管家客户端时间源返回了非法值' })
    }
    return Math.floor(ms / 1000)
  }
}
