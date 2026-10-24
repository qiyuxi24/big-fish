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
  /**
   * 步骤成功后的风控检查开关（默认开）。
   *
   * 为什么要有：提交成功后页面会跳到商品页，此时账号被风控弹层（滑块/punish iframe）盖住是常态，
   * 但上架已经生效（2026-10-23 实测 itemId 1095534136427：商品已在「我发布的」里）。
   * 若终态步骤也做 post 检查，就会把成功翻成 RISK_CONTROL 失败，CLI 退出码非 0、队列标失败，
   * 人工还会以为没发出去。终态步骤显式关掉；执行前的检查照旧，真被风控挡住的发布仍会被拦。
   */
  postRiskCheck?: boolean
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
