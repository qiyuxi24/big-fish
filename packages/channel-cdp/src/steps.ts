/**
 * 发布步骤状态机：步骤顺序执行，失败立即返回并停止（写操作不自动重试）。
 * @module @bigfish/channel-cdp/steps
 */
import { XianyuError } from '@bigfish/core'
import type { ErrorCode } from '@bigfish/core'

import type { CdpPage } from './page.ts'

/** 一个发布步骤：名称用于失败定位与日志。 */
export interface PublishStep {
  name: string
  run(page: CdpPage, ctx: PublishContext): Promise<void>
}

export interface PublishContext {
  log(step: string, message: string): void
  now(): number
  signal?: AbortSignal
}

/** 失败时带上原始 XianyuError 的 code（仅 XianyuError 才有）：上层要据此决定是否 trip 熔断。 */
export type PublishRunResult = { ok: true } | { ok: false; step: string; error: string; code?: ErrorCode }

/**
 * 顺序执行发布步骤。
 *
 * 失败不重试是刻意设计：发布是写操作，重放可能重复上架（AGENTS §1.2）；
 * 失败后交给 daemon 把任务标成 needs_review，由人工确认。
 */
export async function runPublishSteps(
  page: CdpPage,
  steps: PublishStep[],
  ctx: PublishContext,
): Promise<PublishRunResult> {
  for (const step of steps) {
    if (ctx.signal?.aborted === true) {
      return { ok: false, step: step.name, error: '已取消（AbortSignal）' }
    }
    ctx.log(step.name, '开始')
    try {
      await step.run(page, ctx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.log(step.name, '失败：' + message)
      // 保留 code：只有 XianyuError 有稳定 code（如 RISK_CONTROL），字符串/普通 Error 不加字段，
      // 免得改变既有调用方对失败结果的 deepEqual 预期。
      const code = error instanceof XianyuError ? error.code : undefined
      return { ok: false, step: step.name, error: message, ...(code === undefined ? {} : { code }) }
    }
    ctx.log(step.name, '完成')
  }
  return { ok: true }
}
