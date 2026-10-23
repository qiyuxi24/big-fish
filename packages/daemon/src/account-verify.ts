/**
 * 账号登录态校验的结果模型与错误分类。
 *
 * 为什么单独成文件：POST /accounts/:id/verify 的失败语义是「200 + online:false + 稳定 code」，
 * 不是 HTTP 错误；把「XianyuError → 面板可读的 code/message」这段纯映射从 runtime 拆出来，
 * 才能脱离 HTTP、网络与凭据库单测（runtime 只负责 IO 装配）。
 *
 * 约束：本文件不做任何 IO；message 一律用本文件写死的中文短句，绝不回显 cookie 值。
 * @module @bigfish/daemon/account-verify
 */
import { XianyuError } from '@bigfish/core'

/** 校验结论允许出现的失败类别；直接作为 200 响应里的 code 给面板用。 */
export type AccountVerifyCode =
  | 'AUTH_EXPIRED'
  | 'RISK_CONTROL'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'VALIDATION'
  | 'INTERNAL'

/** POST /accounts/:id/verify 的 value 形状。online=false 时 code/message 必有。 */
export interface AccountSessionState {
  accountId: string
  online: boolean
  /** 毫秒时间戳；取调用方注入的时钟，方便测试与面板排序。 */
  checkedAt: number
  /** 本次调用是否把刷新到的 _m_h5_tk 成功写回凭据库。 */
  refreshed: boolean
  code?: AccountVerifyCode
  message?: string
  /** 命中冷却窗口、直接返回上次成功结果时为 true；面板据此避免把缓存值当新检测展示。 */
  cached?: boolean
}

/** 分类结果：code 稳定、message 可直接展示。 */
export interface VerifyFailure {
  code: AccountVerifyCode
  message: string
}

/**
 * 每类失败的默认中文短句。
 * 为什么不用通道原始 message：mtop 原文带 api 名与平台 ret 细节，面板要的是「下一步做什么」。
 */
const FALLBACK_MESSAGE: Record<AccountVerifyCode, string> = {
  AUTH_EXPIRED: '登录态已失效，请重新扫码登录或重新导入登录态',
  RISK_CONTROL: '触发平台风控，请稍后再试',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  NETWORK: '网络请求失败，请检查网络后重试',
  VALIDATION: '登录态校验请求不合法',
  INTERNAL: '登录态校验内部错误',
}

/** 防御性检查：消息里出现这些词就不透传（宁可文案笼统，也不泄露 cookie/令牌线索）。 */
const SECRET_HINT_RE = /cookie|_m_h5_tk|tfstk|x5sec|authorization/i

/** XianyuError.code → 校验类别；未登记的码统一 INTERNAL（不把内部故障细粒度暴露给面板）。 */
function verifyCodeOf(error: unknown): AccountVerifyCode {
  if (!(error instanceof XianyuError)) return 'INTERNAL'
  switch (error.code) {
    case 'AUTH_EXPIRED':
    case 'UNAUTHORIZED':
      return 'AUTH_EXPIRED'
    case 'RISK_CONTROL':
    case 'RATE_LIMITED':
    case 'NETWORK':
    case 'VALIDATION':
      return error.code
    default:
      return 'INTERNAL'
  }
}

/**
 * 错误 → {code,message}。
 * VALIDATION 保留本仓库自写的原文（如「凭据里没有 unb，无法校验登录态」），它比通用文案更能
 * 指出修复动作；其余类别用固定短句，避免把平台/通道内部字符串透给面板。
 */
export function classifyVerifyError(error: unknown): VerifyFailure {
  const code = verifyCodeOf(error)
  if (
    code === 'VALIDATION'
    && error instanceof XianyuError
    && error.message.trim().length > 0
    && !SECRET_HINT_RE.test(error.message)
  ) {
    return { code, message: error.message }
  }
  return { code, message: FALLBACK_MESSAGE[code] }
}

/** 结果组装入参；failure 缺省表示登录态有效。 */
export interface AccountSessionStateInput {
  accountId: string
  checkedAt: number
  refreshed: boolean
  failure?: VerifyFailure
}

/** 结果组装；online 由「有没有 failure」推导，避免两个字段各写一遍导致不一致。 */
export function buildAccountSessionState(input: AccountSessionStateInput): AccountSessionState {
  if (input.failure === undefined) {
    return { accountId: input.accountId, online: true, checkedAt: input.checkedAt, refreshed: input.refreshed }
  }
  return {
    accountId: input.accountId,
    online: false,
    checkedAt: input.checkedAt,
    refreshed: input.refreshed,
    code: input.failure.code,
    message: input.failure.message,
  }
}
