/**
 * daemon 生命周期路由：POST /shutdown 让调用方（面板 / 运维脚本）优雅停掉常驻进程。
 *
 * 为什么不只用信号：面板运行在浏览器侧，只能走 HTTP；信号只有本机终端能给。
 * 关闭动作由 cli 注入的 requestShutdown 完成（唤醒主循环的退出等待），路由本身不关
 * listener——先回 202、下一轮事件循环再关，否则这次响应会写不出去。
 * @module @bigfish/daemon/lifecycle
 */
import { fail } from '@bigfish/core'
import { ok, sendJson } from './http.ts'
import type { RequestShutdown, Route, RouteContext } from './routes.ts'

async function shutdownHandler(ctx: RouteContext): Promise<void> {
  const requestShutdown = ctx.requestShutdown ?? fail('UNSUPPORTED', 'daemon 未注入关停能力')
  await sendJson(ctx.res, 202, ok({ stopping: true, pid: process.pid }), ctx.redact)
  // setImmediate：让 sendJson 的响应先刷出去，再开始关闭。
  setImmediate(() => requestShutdown('HTTP'))
}

export const lifecycleRoutes: readonly Route[] = [
  { method: 'POST', pattern: /^\/shutdown\/?$/, handler: shutdownHandler },
]

export type { RequestShutdown }
