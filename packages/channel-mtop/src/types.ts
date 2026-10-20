/**
 * @bigfish/channel-mtop 的公开类型；接口约定见 docs/component-decomposition.md §4.1。
 * @module @bigfish/channel-mtop/types
 */

/** 允许注入的传输层：真实实现用 fetch，测试用假实现。 */
export interface MtopTransport {
  request(req: MtopHttpRequest): Promise<MtopHttpResponse>
}

/** 已构造好的 HTTP 请求；body 是 application/x-www-form-urlencoded 文本。 */
export interface MtopHttpRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

/** 传输层返回的原始响应；正文不解析，交给 parseMtopResponse。 */
export interface MtopHttpResponse {
  status: number
  headers: Record<string, string>
  text: string
}

/** 一次调用的登录态。 */
export interface MtopSession {
  /** cookie 表：name → value；至少要含 _m_h5_tk 才能签名。 */
  cookies: Record<string, string>
  /** 设备 id；当前只读通道的信封用不到，留给 P1.1 的 IM token 接口。 */
  deviceId?: string
}

/** 调用参数；data 为对象时按紧凑 JSON 序列化，为字符串时视为调用方已序列化。 */
export interface MtopCallOptions {
  /** 接口名，如 'mtop.taobao.idle.pc.detail'。 */
  api: string
  /** 默认 '1.0'。 */
  version?: string
  data: unknown
  session: MtopSession
  /** 参与签名的毫秒时间戳；默认 Date.now()，绝不截断到秒再乘 1000。 */
  t?: number
  /** 默认 'a21ybx.home.0.0'。 */
  spmCnt?: string
  /** 追加查询参数；同名键覆盖默认值（例如按业务改 spm_cnt）。 */
  extraParams?: Record<string, string>
  signal?: AbortSignal
}
