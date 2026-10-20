/**
 * mtop 响应 fixture：全部是参考实现里出现过的平台原文，不含真实账号数据。
 * 测试只回放这些 fixture，绝不发真实网络。
 */
import type { ErrorCode } from '@bigfish/core'

export interface RetFixture {
  name: string
  ret: string[]
  code: ErrorCode
}

/** ret 分类用例；code 是期望抛出的 XianyuError code。 */
export const RET_FIXTURES: readonly RetFixture[] = [
  { name: '风控 RGV587', ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦'], code: 'RISK_CONTROL' },
  { name: '风控 user validate', ret: ['FAIL_SYS_USER_VALIDATE::哎哟喂'], code: 'RISK_CONTROL' },
  { name: '风控 punish 链接', ret: ['FAIL_SYS_USER_VALIDATE::/punish?x5secdata=fixture'], code: 'RISK_CONTROL' },
  { name: 'token 过期（平台原文拼写 EXOIRED）', ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'], code: 'AUTH_EXPIRED' },
  { name: 'session 过期', ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'], code: 'AUTH_EXPIRED' },
  { name: '账号级非法访问', ret: ['FAIL_SYS_ILLEGAL_ACCESS::非法访问'], code: 'AUTH_EXPIRED' },
  { name: '签名非法', ret: ['FAIL_SYS_ILLEGAL_REQUEST::非法请求'], code: 'VALIDATION' },
  { name: '签名错误（core 正则漏掉的 SIGN_ERROR）', ret: ['FAIL_SYS_API_SIGN_ERROR::签名错误'], code: 'VALIDATION' },
  { name: '接口不存在', ret: ['FAIL_SYS_API_NOT_FOUND::api not found'], code: 'VALIDATION' },
  { name: '中文不存在', ret: ['FAIL_SYS_API_NOT_FOUNDED::API不存在'], code: 'VALIDATION' },
  { name: '未知 ret', ret: ['FAIL_SYS_NEW_ERROR::从未见过的错误'], code: 'UNKNOWN' },
]

/** 典型成功响应；data 是业务负载。 */
export const SUCCESS_BODY = { ret: ['SUCCESS::调用成功'], data: { itemId: '1001', price: 9900 } }

/** 平台一次调用会同时带两条 SUCCESS ret。 */
export const SUCCESS_REDIRECT_BODY = { ret: ['SUCCESS::调用成功', 'SUCCESS::redirect'], data: { ok: true } }
