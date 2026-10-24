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
export {
  MTOP_APIS,
  MTOP_API_VERSIONS,
  buildItemDetailData,
  buildPolishData,
  parseItemDetail,
} from './api.ts'
export type { ItemDetailInput, PolishInput } from './api.ts'
export {
  USER_MTOP_APIS,
  buildItemListData,
  buildUserHeadData,
  extractSellerIdFromDetail,
  parseItemList,
  parseUserHead,
} from './user.ts'
export type { ItemListInput, ItemListPage, UserHeadInput, UserHeadProfile } from './user.ts'
export {
  extractTitleKeywords,
  parseItemReference,
  summarizeReferences,
} from './reference.ts'
export type {
  ReferenceItem,
  ReferenceProperty,
  ReferenceSeller,
  ReferenceSiblingItem,
  ReferenceSummary,
} from './reference.ts'
export { analyzeCopyStructure, analyzeImageFeatures } from './features.ts'
export { parseXianyuLink } from './link.ts'
export type { XianyuLinkTarget } from './link.ts'
export type { MtopCallOptions, MtopHttpRequest, MtopHttpResponse, MtopSession, MtopTransport } from './types.ts'
