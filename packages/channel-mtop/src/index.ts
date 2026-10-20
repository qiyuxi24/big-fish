/**
 * mtop 只读通道：签名、信封、ret 分类、cookie 归一。
 * 契约见 docs/component-decomposition.md §4.1。
 * @module @bigfish/channel-mtop
 */
export {
  APP_KEY,
  DEFAULT_SPM_CNT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VERSION,
  MTOP_HOST,
  MTOP_USER_AGENT,
  defaultHeaders,
} from './constants.ts'
export { H5_TOKEN_COOKIE, h5Token, signMtop } from './sign.ts'
export { buildMtopRequest } from './request.ts'
export { parseMtopResponse, parseSetCookie } from './response.ts'
export { callMtop } from './call.ts'
export type { MtopCallOptions, MtopHttpRequest, MtopHttpResponse, MtopSession, MtopTransport } from './types.ts'
