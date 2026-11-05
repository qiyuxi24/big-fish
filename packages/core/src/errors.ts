/**
 * 统一错误类型。跨包只用 XianyuError，携带稳定 code，便于 daemon 映射为 ApiError、
 * 插件映射为工具错误、测试断言。
 * @module @bigfish/core/errors
 */

/** 稳定错误码；新增码必须同时在本文件与 AGENTS.md 里登记。 */
export type ErrorCode =
  | 'VALIDATION'
  | 'AUTH_EXPIRED'
  | 'RISK_CONTROL'
  | 'RATE_LIMITED'
  | 'CIRCUIT_OPEN'
  | 'NETWORK'
  | 'STORAGE'
  | 'UNSUPPORTED'
  | 'INTERNAL'
  | 'UNAUTHORIZED'
  /** 路径/资源不存在（404）。与 VALIDATION 分开：客户端据此可判断「是不是这个 daemon 版本没这条路由」。 */
  | 'NOT_FOUND'
  /** 路径存在但方法不对（405）。 */
  | 'METHOD_NOT_ALLOWED'
  /** 平台返回了我们没归类的 ret；保留原文进 message，重试无意义。 */
  | 'UNKNOWN'

/** 全部错误码的集合（运行时判定用，例如把外部 code 收敛到白名单）。 */
export const ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'VALIDATION',
  'AUTH_EXPIRED',
  'RISK_CONTROL',
  'RATE_LIMITED',
  'CIRCUIT_OPEN',
  'NETWORK',
  'STORAGE',
  'UNSUPPORTED',
  'INTERNAL',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'UNKNOWN',
])

/** 每个 code 的重试语义：true=稍后可重试，false=重试无意义。 */
const RETRYABLE: Record<ErrorCode, boolean> = {
  VALIDATION: false,
  AUTH_EXPIRED: false,
  RISK_CONTROL: false,
  RATE_LIMITED: true,
  CIRCUIT_OPEN: true,
  NETWORK: true,
  STORAGE: true,
  UNSUPPORTED: false,
  INTERNAL: false,
  // 401：daemon token 缺失/不匹配。凭据本身可重配，但重试同一请求无意义。
  UNAUTHORIZED: false,
  // 404/405：路由不存在/方法不对，是「代码或版本问题」，重试不会变。
  NOT_FOUND: false,
  METHOD_NOT_ALLOWED: false,
  UNKNOWN: false,
}

export interface XianyuErrorOptions {
  code: ErrorCode
  message: string
  /** 底层原因；只保留给日志，不进 ApiError 的 message。 */
  cause?: unknown
  /** 覆盖默认重试语义。 */
  retryable?: boolean
  /** 结构化上下文；写日志前必须经过 redact。 */
  details?: Record<string, unknown>
}

/** 项目唯一错误类型。 */
export class XianyuError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly details: Record<string, unknown>

  constructor(options: XianyuErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'XianyuError'
    this.code = options.code
    this.retryable = options.retryable ?? RETRYABLE[options.code]
    this.details = options.details ?? {}
  }

  /**
   * 映射为 IPC 错误体。
   *
   * details 必须一起透出：错误体是 agent/面板唯一能看到的失败信息，
   * 少了 details 就只剩一句话（「发布步骤『填价格』失败」），
   * 调用方无法从结构上知道该改哪个字段、该等多久、该找谁。
   * 调用方（daemon 的 sendJson）已经统一过 redact，这里不做二次脱敏。
   */
  toApiError(): { code: string; message: string; retryable: boolean; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details }
  }
}

/** 断言式抛错，减少 if/throw 噪音。 */
export function fail(code: ErrorCode, message: string, options: Omit<XianyuErrorOptions, 'code' | 'message'> = {}): never {
  throw new XianyuError({ code, message, ...options })
}

/** 把未知异常包成 XianyuError，避免裸字符串冒泡。 */
export function toXianyuError(error: unknown, fallback: ErrorCode = 'INTERNAL'): XianyuError {
  if (error instanceof XianyuError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new XianyuError({ code: fallback, message, cause: error })
}