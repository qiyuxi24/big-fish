/**
 * 接口路径、请求体构造与参数校验。
 *
 * 路径与字段名来自 open.goofish.pro 文档，参考实现见
 * research/repos/xian-guanjia/scripts/xian_guanjia.py（MIT）。
 * TS 侧对外用 camelCase，调用平台前在**方法层**映射成 snake_case。
 * @module @bigfish/channel-guanjia
 */

import { XianyuError } from '@bigfish/core'
import type { PageQuery } from './types.ts'

/**
 * 全部可用接口路径（20 个）。
 * 刻意不包含 /api/order/place（代下单）：属 AGENTS §1.6 业务红线，
 * 连方法都不提供，避免被误用成刷单通道。
 */
export const PATHS = {
  shops: '/api/user/shops',
  categories: '/api/product/categories',
  attributes: '/api/product/attributes',
  productList: '/api/product/list',
  productDetail: '/api/product/detail',
  skus: '/api/product/skus',
  createProduct: '/api/product/create',
  createProductsBatch: '/api/product/create_batch',
  publishProduct: '/api/product/publish',
  unpublishProduct: '/api/product/unpublish',
  updateProduct: '/api/product/update',
  updateStock: '/api/product/update_stock',
  deleteProduct: '/api/product/delete',
  orderList: '/api/order/list',
  orderDetail: '/api/order/detail',
  orderCards: '/api/order/cards',
  shipOrder: '/api/order/ship',
  updateOrderPrice: '/api/order/update_price',
  logisticsCompanies: '/api/logistics/companies',
  balance: '/api/mch/balance'
} as const

export type GuanJiaPath = (typeof PATHS)[keyof typeof PATHS]

export function requireId(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new XianyuError({ code: 'VALIDATION', message: `闲管家参数 ${field} 必须是正整数` })
  }
  return value
}

export function requireNonNegativeInt(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new XianyuError({ code: 'VALIDATION', message: `闲管家参数 ${field} 必须是非负整数` })
  }
  return value
}

export function requireText(field: string, value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new XianyuError({ code: 'VALIDATION', message: `闲管家参数 ${field} 必须是非空字符串` })
  }
  return value
}

export function requireRecord(field: string, value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new XianyuError({ code: 'VALIDATION', message: `闲管家参数 ${field} 必须是对象` })
  }
  return value
}

/** 平台强校验：page/page_size 缺省 1/20；status 未传则不带该键（不要传 undefined）。 */
export function pageBody(query?: PageQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {
    page: query?.page === undefined ? 1 : requireId('page', query.page),
    page_size: query?.pageSize === undefined ? 20 : requireId('pageSize', query.pageSize)
  }
  if (query?.status !== undefined) body.status = requireNonNegativeInt('status', query.status)
  return body
}

/** 编辑商品：product_id 放在后面，避免被 data 里的同名字段覆盖。 */
export function updateProductBody(
  productId: number,
  data: Record<string, unknown>
): Record<string, unknown> {
  return { ...requireRecord('data', data), product_id: requireId('productId', productId) }
}
