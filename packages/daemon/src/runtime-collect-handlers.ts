/**
 * 把采集能力适配成 HTTP 路由处理器（参考采集 / 商家商品采集）。
 *
 * 为什么单独成文件：两个采集器都需要「读凭据 → 带着 cookie 调 mtop → 回写刷新后的
 * cookie」，这段适配与账号/任务无关；拆出来后 runtime 只负责装配采集器本身。
 * @module @bigfish/daemon/runtime-collect-handlers
 */
import { fail } from '@bigfish/core'
import type { CredentialStore, SellerRepository } from '@bigfish/core'
import type { ReferenceCollector } from './reference.ts'
import type { ReferenceCollectHandler } from './routes-items.ts'
import type { SellerCollector } from './seller-collect.ts'
import type { SellerCollectHandler } from './seller-routes.ts'

/** 采集适配层的依赖。 */
export interface CollectHandlerDeps {
  credentials: CredentialStore
  referenceCollector: ReferenceCollector
  sellerCollector: SellerCollector
  sellers: SellerRepository
}

/** 注入给路由上下文的采集处理器集合。 */
export interface CollectHandlers {
  referenceCollect: ReferenceCollectHandler
  sellerCollect: SellerCollectHandler
  sellerItems: SellerRepository
}

export function createCollectHandlers(deps: CollectHandlerDeps): CollectHandlers {
  const { credentials, referenceCollector, sellerCollector, sellers } = deps

  return {
    // 采集参考：只读统计，cookie 值不出进程；令牌过期时用回写的凭据库刷新。
    referenceCollect: async (input) => {
      const record = await credentials.load(input.accountId)
      if (record === undefined) {
        fail('UNAUTHORIZED', '没有账号 ' + input.accountId + ' 的登录态，先导入或扫码登录')
      }
      return referenceCollector.collect({
        accountId: input.accountId,
        cookies: record.cookies,
        ...(input.itemIds === undefined ? {} : { itemIds: input.itemIds }),
        ...(input.sellerId === undefined ? {} : { sellerId: input.sellerId }),
        signal: input.signal,
        onSessionUpdate: async (cookies) => {
          await credentials.save({
            accountId: input.accountId,
            cookies,
            ...(record.meta === undefined ? {} : { meta: record.meta }),
          })
        },
      })
    },
    // 商家商品采集（会写本地库）：链接解析在前置层，这里只收纯数字 sellerId。
    sellerCollect: async (input) => {
      const record = await credentials.load(input.accountId)
      if (record === undefined) {
        fail('UNAUTHORIZED', '没有账号 ' + input.accountId + ' 的登录态，先导入或扫码登录')
      }
      return sellerCollector.collect({
        accountId: input.accountId,
        cookies: record.cookies,
        sellerId: input.sellerId,
        ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
        ...(input.acknowledgeOther === undefined ? {} : { acknowledgeOther: input.acknowledgeOther }),
        signal: input.signal,
        onSessionUpdate: async (cookies) => {
          await credentials.save({
            accountId: input.accountId,
            cookies,
            ...(record.meta === undefined ? {} : { meta: record.meta }),
          })
        },
      })
    },
    sellerItems: sellers,
  }
}
