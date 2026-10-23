/**
 * 设置域路由：GET/PUT /settings。
 *
 * 为什么单独成文件：设置是面板的可编辑面，校验在 core 的 parseSettingsPatch；
 * 这里只做「读/写 + 错误映射」，和业务写路由分开更容易审。
 * @module @bigfish/daemon/routes-settings
 */
import { fail } from '@bigfish/core'
import { ok, readJsonBody, sendJson, sendMappedError } from './http.ts'
import type { Route, RouteContext } from './routes.ts'
import type { SettingsStore } from './settings.ts'

/** 设置域路由；拼进 routes.ts 的 ROUTES。 */
export const settingsRoutes: readonly Route[] = [
  { method: 'GET', pattern: /^\/settings\/?$/, handler: getSettingsHandler },
  { method: 'PUT', pattern: /^\/settings\/?$/, handler: putSettingsHandler },
]

/** 读设置：面板启动时拉一次，显示当前文案风格/默认类目/发布节奏。 */
async function getSettingsHandler(ctx: RouteContext): Promise<void> {
  const store = ctx.settings ?? fail('UNSUPPORTED', 'daemon 未注入设置存储')
  await sendJson(ctx.res, 200, ok(await store.get()), ctx.redact)
}

/**
 * 改设置：只接受补丁（缺省字段保持不变）；非法字段/越界值由 core 的 parseSettingsPatch 抛 VALIDATION → 400。
 * 与入队一样，写接口不做「部分成功」：校验不过就一个字段都不写。
 */
async function putSettingsHandler(ctx: RouteContext): Promise<void> {
  const store: SettingsStore = ctx.settings ?? fail('UNSUPPORTED', 'daemon 未注入设置存储')
  const body = await readJsonBody(ctx.req)
  let next: Awaited<ReturnType<SettingsStore['update']>>
  try {
    next = await store.update(body)
  } catch (error) {
    await sendMappedError(ctx.res, error, 400, ctx.redact)
    return
  }
  await sendJson(ctx.res, 200, ok(next), ctx.redact)
}
