/**
 * 闲鱼 IM 通道（钉钉 lwp 长连接）：帧构造/解析 + 可注入传输的会话状态机。
 *
 * 协议事实见 docs/im-protocol.md。本包是纯函数 + 状态机，不发网络也不落库：
 * ws 适配器、mtop 取 token 的签名与发送分别由 daemon / channel-mtop 负责。
 * @module @bigfish/channel-im
 */
export type { ImFrame, ImTokenRequest } from './frames.ts'
export {
  ACK_DIFF_DELAY_MS,
  ACK_DIFF_LWP,
  ACK_DIFF_PIPELINE,
  ACK_DIFF_TOO_LONG_TAG,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_LWP,
  HEARTBEAT_TIMEOUT_MS,
  IM_APP_KEY,
  IM_CACHE_HEADER,
  IM_DT,
  IM_SYNC_INITIAL,
  IM_TOKEN_API,
  IM_TOKEN_API_VERSION,
  IM_UA,
  IM_WV,
  IM_WS_URL,
  REG_LWP,
  buildAckDiffFrame,
  buildAckFrame,
  buildHeartbeatFrame,
  buildImTokenRequest,
  buildRegFrame,
  decodeBase64Json,
  encodeFrame,
  generateDeviceId,
  generateMid,
  isRecord,
  parseFrameText,
  readInteger,
  readPath,
  readText,
} from './frames.ts'
export type { ImChatMessage, ImMessageKind, ImTradeStatus } from './messages.ts'
export { decodePushItems, parseImMessage, parsePushMessages } from './messages.ts'
export type { ImClock, ImSessionOptions, ImSessionState, ImStartOptions, ImTransport } from './session.ts'
export { ImSession, SYSTEM_CLOCK } from './session.ts'
