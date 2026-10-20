/**
 * @bigfish/channel-guanjia —— 闲管家开放平台客户端。
 *
 * 只做确定性 HTTP：签名、参数校验、错误映射；不调 LLM、不做重试与限流
 * （重试/限流属于 daemon 执行器的职责）。
 *
 * 算法与接口移植自 xian-guanjia（MIT License, Copyright (c) 2025 thefreelight）：
 * research/repos/xian-guanjia/scripts/xian_guanjia.py
 * research/repos/xian-guanjia/references/api-docs.md
 *
 * 刻意不实现 /api/order/place（代下单）：AGENTS.md §1.6 业务红线。
 * @module @bigfish/channel-guanjia
 */

export {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  GuanJiaClient,
  fetchTransport
} from './client.ts'

export { PLATFORM_FAILURES, platformFailure } from './errors.ts'

export {
  PATHS,
  pageBody,
  requireId,
  requireNonNegativeInt,
  requireRecord,
  requireText,
  updateProductBody
} from './methods.ts'
export type { GuanJiaPath } from './methods.ts'

export {
  assertCredentials,
  canonicalJson,
  computeSign,
  md5Hex,
  signRequest,
  signedHeaders
} from './sign.ts'

export type {
  GuanJiaClientOptions,
  GuanJiaCredentials,
  GuanJiaSignature,
  GuanJiaTransport,
  GuanJiaTransportRequest,
  GuanJiaTransportResponse,
  PageQuery
} from './types.ts'
