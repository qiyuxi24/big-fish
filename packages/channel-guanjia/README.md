# @bigfish/channel-guanjia

闲管家开放平台（https://open.goofish.pro）客户端：签名、参数校验、错误码映射。
契约见 [`docs/component-decomposition.md`](../../docs/component-decomposition.md) §4.3。

## 来源与许可证

签名算法、请求头、接口路径移植自开源项目 **xian-guanjia**（MIT License，
Copyright (c) 2025 thefreelight）：

- `research/repos/xian-guanjia/scripts/xian_guanjia.py`（签名与请求实现）
- `research/repos/xian-guanjia/references/api-docs.md`（路径、参数与错误码表）

移植的是协议事实（md5 拼接顺序、header 名、路径），实现按本仓规范重写
（TS strict、零依赖、node:test）。完整 MIT 文本见上述仓库的 `LICENSE`。

## 用法

```ts
import { GuanJiaClient } from '@bigfish/channel-guanjia'

const client = new GuanJiaClient({
  credentials: { appId, appSecret, mchId, mchSecret }
})
const shops = await client.shops()
```

传 `transport` 可注入自定义 HTTP 实现（测试必须注入假 transport，禁真实网络）；
传 `now` 可注入假时钟（返回 **epoch 毫秒**，签名 timestamp 由它换算成秒）。

## 签名

`sign = md5(appId + "," + appSecret + "," + md5(body) + "," + timestamp + "," + mchId + "," + mchSecret)`，
timestamp 为**秒**，body 为**紧凑** JSON（无空格），无请求体时用 `{}`（md5 = `99914b932bd37a50b983c5e7c90ae93b`）。

参考实现用 `requests` 的 `json=` 参数发送，会重新插入空格，与参与签名的紧凑串不一致；
本包签名与发送共用同一份字节（更严格地满足了平台「参数强校验」）。

## 接口（20 个，全部 POST）

| 方法 | 路径 |
| --- | --- |
| `shops()` | `/api/user/shops` |
| `categories()` | `/api/product/categories` |
| `attributes(categoryId)` | `/api/product/attributes` |
| `productList({page,pageSize,status})` | `/api/product/list` |
| `productDetail(productId)` | `/api/product/detail` |
| `skus(productId)` | `/api/product/skus` |
| `createProduct(data)` | `/api/product/create` |
| `createProductsBatch(products)` | `/api/product/create_batch` |
| `publishProduct(productId)` | `/api/product/publish` |
| `unpublishProduct(productId)` | `/api/product/unpublish` |
| `updateProduct(productId,data)` | `/api/product/update` |
| `updateStock(productId,stock,skuId?)` | `/api/product/update_stock` |
| `deleteProduct(productId)` | `/api/product/delete` |
| `orderList({page,pageSize,status})` | `/api/order/list` |
| `orderDetail(orderId)` | `/api/order/detail` |
| `orderCards(orderId)` | `/api/order/cards` |
| `shipOrder(orderId,logisticsNo,logisticsCompany)` | `/api/order/ship` |
| `updateOrderPrice(orderId,price)` | `/api/order/update_price` |
| `logisticsCompanies()` | `/api/logistics/companies` |
| `balance()` | `/api/mch/balance` |

对外用 camelCase，调用平台前映射为 snake_case（`productId` → `product_id` 等）。

## 不实现代下单（/api/order/place）

AGENTS.md §1.6 把「代下单/刷单」列为业务红线：开放平台确实提供
`/api/order/place`，但该接口可凭空为任意买家创建订单，属于刷单/代下单通道。
本包**连方法都不提供**，`PATHS` 里也不含该路径，避免被上层误用。

## 错误映射

- `code === 0` 返回 `data`。
- `code !== 0` 抛 `XianyuError`：原平台码放 `error.details.platformCode`，原文放 `details.platformMessage`，完整 `data` 放 `cause`。
- 传输异常 / 超时 / 非 JSON / HTTP 非 200 → `NETWORK`（`retryable: true`）。
- 平台码映射见 `src/errors.ts`：签名错/参数/业务冲突 → `VALIDATION`；IP 白名单/商户不可用 → `UNAUTHORIZED`；500 → `INTERNAL` 且 `retryable`；`1209`（下单超时）→ `UNKNOWN` 且不可重试（必须先查单）。

## 遗留

- `call()` 按契约只有两个参数，未开放外部 `AbortSignal`；默认 `fetchTransport` 自带 15s 超时（`DEFAULT_TIMEOUT_MS`）。若要按任务取消，建议 P1.1 给 `call` 增加可选 `options`（未擅自改契约）。
- 平台文档把发布请求体字段放在外链 Apifox 上，仓内未收录；`createProduct(data)` 原样透传，字段需调用方按官方文档填。
