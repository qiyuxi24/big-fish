/**
 * 闲管家开放平台客户端的公共类型。
 *
 * 签名算法与接口路径移植自开源项目 xian-guanjia（MIT License，
 * Copyright (c) 2025 thefreelight），原实现见
 * research/repos/xian-guanjia/scripts/xian_guanjia.py。
 * @module @bigfish/channel-guanjia
 */

/** 开放平台凭据；由 daemon 从加密存储取出后注入，禁止出现在日志与异常栈里。 */
export interface GuanJiaCredentials {
  appId: string
  appSecret: string
  mchId: string
  mchSecret: string
}

/** 底层 HTTP 请求：请求体是字符串，保证与参与签名的字节完全一致。 */
export interface GuanJiaTransportRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export interface GuanJiaTransportResponse {
  status: number
  text: string
}

/** 传输层抽象：生产用 fetch，测试注入假实现（禁真实网络，见 AGENTS §5）。 */
export interface GuanJiaTransport {
  request(req: GuanJiaTransportRequest): Promise<GuanJiaTransportResponse>
}

/** 分页查询参数；平台侧字段名为 page / page_size / status。 */
export interface PageQuery {
  page?: number
  pageSize?: number
  status?: number
}

export interface GuanJiaClientOptions {
  credentials: GuanJiaCredentials
  baseUrl?: string
  transport?: GuanJiaTransport
  /** 返回 epoch 毫秒；默认 Date.now。签名 timestamp 由它换算成秒。 */
  now?: () => number
}

/** 一次请求的签名结果；timestamp 恒为秒（平台签名规则要求）。 */
export interface GuanJiaSignature {
  timestamp: number
  sign: string
  headers: Record<string, string>
}
