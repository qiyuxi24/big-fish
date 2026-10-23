/**
 * 账号域路由：列表摘要、登录态导入、扫码登录、校验、切换、退出。
 *
 * 为什么单独成文件：账号是独立模块（导入/扫码/保活/切换），新增能力只会改这一处；
 * routes.ts 只留「路由表 + 公共上下文」，避免每次加账号动作都碰主表。
 * @module @bigfish/daemon/routes-accounts
 */
import { fail } from '@bigfish/core'
import {
  asRecord,
  MAX_BODY_BYTES,
  ok,
  optionalPort,
  optionalPositiveInt,
  optionalString,
  readJsonBody,
  requiredString,
  sendJson,
} from './http.ts'
import type { Route, RouteContext } from './routes.ts'
import type { ImportAccountInput, ImportedAccount } from './accounts.ts'
import type { LoginInput, LoginResult } from './login.ts'
import type { AccountSummary } from './account-list.ts'
import type { AccountSessionState } from './account-verify.ts'
import type { ActivateResult, LogoutResult } from './account-lifecycle.ts'

/** 账号导入能力的注入签名；未注入时路由返回 UNSUPPORTED（HTTP 500）。 */
export type ImportAccountHandler = (input: ImportAccountInput) => Promise<ImportedAccount>

/** 扫码登录能力的注入签名；未注入时 POST /accounts/login 返回 UNSUPPORTED。 */
export type LoginAccountHandler = (input: LoginInput) => Promise<LoginResult>

/**
 * 登录态校验能力的注入签名；未注入时 POST /accounts/:id/verify 返回 UNSUPPORTED。
 * 返回 200 的 value（online=false 也是成功响应），账号不存在才抛 VALIDATION。
 */
export type VerifyAccountHandler = (input: { accountId: string }) => Promise<AccountSessionState>

/** 切换当前账号的注入签名；未注入时 POST /accounts/activate 返回 UNSUPPORTED。 */
export type ActivateAccountHandler = (input: { accountId: string }) => Promise<ActivateResult>

/** 退出登录（只清本地凭据）的注入签名；未注入时 POST /accounts/:id/logout 返回 UNSUPPORTED。 */
export type LogoutAccountHandler = (input: { accountId: string }) => Promise<LogoutResult>

/** 账号域路由；拼进 routes.ts 的 ROUTES。 */
export const accountRoutes: readonly Route[] = [
  { method: 'GET', pattern: /^\/accounts\/?$/, handler: listAccountsHandler },
  { method: 'POST', pattern: /^\/accounts\/import\/?$/, handler: importAccountHandler },
  { method: 'POST', pattern: /^\/accounts\/login\/?$/, handler: loginAccountHandler },
  // 放在 login 之后：两条都是精确/带参路径，顺序只影响可读性；带参路由不要抢在精确路由前。
  { method: 'POST', pattern: /^\/accounts\/([^/]+)\/verify\/?$/, handler: verifyAccountHandler },
  { method: 'POST', pattern: /^\/accounts\/([^/]+)\/logout\/?$/, handler: logoutAccountHandler },
  // 精确路径，与上面两条带参路由不冲突（activate 里没有第二个路径段）。
  { method: 'POST', pattern: /^\/accounts\/activate\/?$/, handler: activateAccountHandler },
]

/**
 * 账号列表：只读摘要（账号 id / 更新时间 / 字段数 / 是否可用），不含任何 cookie 值。
 * 未注入摘要能力时返回空数组：面板在「daemon 未接凭据库」的开发态也应当能渲染。
 */
async function listAccountsHandler(ctx: RouteContext): Promise<void> {
  const summaries: AccountSummary[] = ctx.accountSummaries === undefined ? [] : await ctx.accountSummaries()
  await sendJson(ctx.res, 200, ok(summaries), ctx.redact)
}

/**
 * 从本机 Chrome 导入登录态。
 * 请求体可为空对象；accountId / port 都可选（默认 unb、默认 9222）。
 * 这是写操作（落加密凭据），插件侧必须走审批门禁。
 */
async function importAccountHandler(ctx: RouteContext): Promise<void> {
  const importer = ctx.importAccount ?? fail('UNSUPPORTED', 'daemon 未注入账号导入能力')
  const body = asRecord(await readJsonBody(ctx.req), '账号导入请求体')
  const input: ImportAccountInput = {}
  const accountId = optionalString(body, 'accountId', '账号导入请求体')
  if (accountId !== undefined) input.accountId = accountId
  const port = optionalPort(body, 'port', '账号导入请求体')
  if (port !== undefined) input.port = port
  const result = await importer(input)
  await sendJson(ctx.res, 200, ok(result), ctx.redact)
}

/**
 * 扫码登录：打开闲鱼登录页并等用户扫码，读到 cookie 后落加密凭据。
 * 请求体可空（全部参数可选）；长轮询期间用 AbortSignal 响应客户端断开，不阻塞事件循环。
 * 调用方的 HTTP 超时必须大于 timeoutMs（默认 180s）：DaemonClient 默认 15s，直接调会先超时。
 * 这是写操作（落加密凭据），插件侧必须走审批门禁。
 */
async function loginAccountHandler(ctx: RouteContext): Promise<void> {
  const login = ctx.loginAccount ?? fail('UNSUPPORTED', 'daemon 未注入扫码登录能力')
  const body = asRecord(await readJsonBody(ctx.req, MAX_BODY_BYTES, true), '扫码登录请求体')
  const input: LoginInput = {}
  const accountId = optionalString(body, 'accountId', '扫码登录请求体')
  if (accountId !== undefined) input.accountId = accountId
  const port = optionalPort(body, 'port', '扫码登录请求体')
  if (port !== undefined) input.port = port
  const timeoutMs = optionalPositiveInt(body, 'timeoutMs', '扫码登录请求体')
  if (timeoutMs !== undefined) input.timeoutMs = timeoutMs
  const controller = new AbortController()
  // 客户端提前断开（用户关页面/超时撤销）时立刻中止等待，否则会有一个悬挂的扫码轮询。
  const onClose = (): void => {
    controller.abort()
  }
  ctx.res.once('close', onClose)
  try {
    const result = await login({ ...input, signal: controller.signal })
    await sendJson(ctx.res, 200, ok(result), ctx.redact)
  } finally {
    ctx.res.off('close', onClose)
  }
}

/**
 * 校验账号登录态：掉线/风控/网络失败都回 200 + online:false，面板据此展示原因，不用解析 mtop 错误码。
 * 只有「账号不存在」（VALIDATION → 400）与「能力未装配」（UNSUPPORTED → 500）走错误信封。
 */
async function verifyAccountHandler(ctx: RouteContext): Promise<void> {
  const verify = ctx.verifyAccount ?? fail('UNSUPPORTED', 'daemon 未注入登录态校验能力')
  const accountId = ctx.params[0] ?? fail('VALIDATION', '缺少账号 id')
  const state = await verify({ accountId })
  await sendJson(ctx.res, 200, ok(state), ctx.redact)
}

/**
 * 切换当前账号：只写本地设置（settings.activeAccountId），不触达闲鱼。
 * 清空当前账号走 logout，所以这里不接受空串（避免用空串伪造一个「没有账号」的状态）。
 * 这是写磁盘操作（settings.json），插件侧必须走审批门禁。
 */
async function activateAccountHandler(ctx: RouteContext): Promise<void> {
  const activate = ctx.activateAccount ?? fail('UNSUPPORTED', 'daemon 未注入切换账号能力')
  const body = asRecord(await readJsonBody(ctx.req), '切换账号请求体')
  const accountId = requiredString(body, 'accountId', '切换账号请求体').trim()
  if (accountId === '') fail('VALIDATION', 'accountId 不能为空')
  const result = await activate({ accountId })
  await sendJson(ctx.res, 200, ok(result), ctx.redact)
}

/**
 * 退出登录：删本地加密凭据并清掉「当前账号」标记，绝不调用闲鱼接口踢掉网页端会话。
 * 账号不存在 → 400 VALIDATION：重复退出的客户端 bug 应该被看见，而不是静默成功。
 * 这是写磁盘操作（删凭据），插件侧必须走审批门禁。
 */
async function logoutAccountHandler(ctx: RouteContext): Promise<void> {
  const logout = ctx.logoutAccount ?? fail('UNSUPPORTED', 'daemon 未注入退出登录能力')
  const accountId = ctx.params[0] ?? fail('VALIDATION', '缺少账号 id')
  const result = await logout({ accountId })
  await sendJson(ctx.res, 200, ok(result), ctx.redact)
}
