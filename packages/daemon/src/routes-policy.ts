/**
 * 策略预检路由：POST /policy/check。
 *
 * 为什么需要一条专用路由：发布草稿的合规规则（标题字数、违禁词、图片数、价格）只有 core 的
 * `checkListing` 一份实现，而插件层按 AGENTS §2 不能 import core。过去插件只能校验「字段类型」，
 * 于是描述只有 20 字、含违禁词的草稿在 dry-run 阶段全部放行，一路入队到执行器才被
 * `requirePolicy` 拒掉——一次确定性的拒绝被拖成一条 failed 任务，模型还得再读一遍错误才知道改哪儿。
 *
 * 这里是纯函数包装：不读盘、不联网、无副作用，所以可以放心让 dry-run 调用。
 * @module @bigfish/daemon/routes-policy
 */
import { checkListing, fail } from '@bigfish/core'
import type { ListingDraft } from '@bigfish/core'
import { asRecord, ok, readJsonBody, sendJson, sendMappedError } from './http.ts'
import type { Route, RouteContext } from './routes.ts'

/** 策略预检路由；拼进 routes.ts 的 ROUTES。 */
export const policyRoutes: readonly Route[] = [
  { method: 'POST', pattern: /^\/policy\/check\/?$/, handler: checkPolicyHandler },
]

/** 从请求体里取一个「要么没有、要么是字符串」的字段。 */
function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail('VALIDATION', '策略预检的 ' + key + ' 必须是字符串')
  return value
}

/** 从请求体里取一个「要么没有、要么是正整数」的字段。 */
function optionalInt(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('VALIDATION', '策略预检的 ' + key + ' 必须是非负整数')
  }
  return value
}

/**
 * 预检一份草稿。请求体直接复用发布载荷的字段名（priceCents/imageCount），
 * 让调用方不必做字段名映射——字段名一映射就会漂移。
 */
async function checkPolicyHandler(ctx: RouteContext): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(ctx.req), '策略预检请求体')
    // 可选字段先落变量再展开：直接写 `optionalInt(...)` 两次会让 TS 看不出它已经非空
    // （exactOptionalPropertyTypes 下 `number | undefined` 不能赋给可选 `number`）。
    const marketPriceCents = optionalInt(body, 'marketPriceCents')
    const categoryPath = Array.isArray(body.categoryPath)
      ? body.categoryPath.filter((item): item is string => typeof item === 'string')
      : undefined
    const draft: ListingDraft = {
      title: optionalText(body, 'title') ?? '',
      description: optionalText(body, 'desc') ?? '',
      priceCents: optionalInt(body, 'priceCents') ?? 0,
      imageCount: optionalInt(body, 'imageCount') ?? 0,
      ...(typeof body.firstImageSquare === 'boolean' ? { firstImageSquare: body.firstImageSquare } : {}),
      ...(marketPriceCents === undefined ? {} : { marketPriceCents }),
      ...(categoryPath === undefined ? {} : { categoryPath }),
    }
    await sendJson(ctx.res, 200, ok(checkListing(draft)), ctx.redact)
  } catch (error) {
    await sendMappedError(ctx.res, error, 400, ctx.redact)
  }
}
