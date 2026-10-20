/**
 * CDP 会话：连 Chrome、页面操作、响应拦截、发布步骤状态机。
 * 契约见 docs/component-decomposition.md §4.2。
 * @module @bigfish/channel-cdp
 */
export type {
  CdpConnectionLike,
  CdpConnectionOptions,
  SocketEvent,
  WebSocketFactory,
  WebSocketLike,
} from './connection.ts'
export { CdpConnection } from './connection.ts'
export type {
  CaptureJsonOptions,
  CdpPageOptions,
  WaitForOptions,
} from './page.ts'
export { CdpPage } from './page.ts'
export type {
  AttachChromeOptions,
  AttachChromePageOptions,
  ChildProcessLike,
  ChromePageHandle,
  ChromeTarget,
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
  LaunchChromeOptions,
  LaunchChromeResult,
  SpawnLike,
} from './launch.ts'
export { attachChrome, attachChromePage, DEFAULT_PORT, launchChrome, resolveChromePath } from './launch.ts'
export type { BrowserCookie, CdpRequestConnection, CookieJar } from './cookies.ts'
export { assertLoginCookies, CdpCookieSource, selectGoofishCookies } from './cookies.ts'
export type {
  PublishContext,
  PublishRunResult,
  PublishStep,
} from './steps.ts'
export { runPublishSteps } from './steps.ts'
export type { DomPage, DomWaitOptions } from './dom.ts'
export {
  clickByText,
  clickSelector,
  countElements,
  elementExists,
  fillField,
  fillFieldAt,
  findFileInputNodeIds,
  readBodyText,
  readLocationHref,
  setFileInputFiles,
  waitForCount,
  waitForElement,
  waitForText,
} from './dom.ts'
export type { PublishDraft, PublishOptions, PublishSelectors } from './publish.ts'
export {
  assertValidDraft,
  createPublishSteps,
  DEFAULT_SELECTORS,
  extractItemId,
  priceToYuanText,
  publishItem,
  PUBLISH_URL,
} from './publish.ts'