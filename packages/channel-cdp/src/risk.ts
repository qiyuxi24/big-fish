/**
 * 发布侧风控识别。
 *
 * 为什么需要：mtop 读接口的风控由 core 的 classifyMtopRet 识别，但发布走 CDP 浏览器，
 * 页面被风控（滑块/验证码/punish 跳转）时步骤机只会抛普通的 INTERNAL/VALIDATION，
 * daemon 就不会 trip 熔断，后续任务会继续打同一个账号，把风控越拖越重。
 * 这里把「页面级信号」统一翻译成 XianyuError RISK_CONTROL（不可重试），
 * worker 据此触发账号级冷却（worker.ts #mapFailure → circuits.trip）。
 *
 * 为什么识别到就失败、不自动重试：发布是写操作，重放可能重复上架（AGENTS §1.2）；
 * 风控状态下重试也只会让风控升级。人工完成验证并等冷却后再手动重试才是安全路径。
 * @module @bigfish/channel-cdp/risk
 */
import { XianyuError } from '@bigfish/core'

import type { DomPage } from './dom.ts'
import type { CdpPage } from './page.ts'
import { runPublishSteps } from './steps.ts'
import type { PublishContext, PublishRunResult, PublishStep } from './steps.ts'

/** 风控信号分类：URL 跳转 / 页面文案 / 风控组件。 */
export interface PublishRisk {
  kind: 'url' | 'text' | 'element'
  /** 给日志和错误信息用的中文原因（含命中的具体标记）。 */
  reason: string
}

/** 一次页面探测的结构化结果（由页面脚本产出，TS 侧做窄化与分类）。 */
export interface RiskSignals {
  url: string
  textHits: string[]
  elementHits: string[]
}

/** 风控跳转 URL 的稳定标记（小写比较）。 */
export const RISK_URL_MARKERS: readonly string[] = [
  'x5sec',
  '/_____tmd_____/',
  'punish',
  'baxia',
  'captcha',
  '/slide',
  'verify',
]

/** 风控弹层/验证页的可见文案；只收「出现就基本可判定」的整句，避免误伤帮助文案。 */
export const RISK_TEXT_MARKERS: readonly string[] = [
  '请完成安全验证',
  '拖动滑块',
  '人机验证',
  '滑块验证',
  '安全验证失败',
  '操作过于频繁',
  '访问受限',
]

/** 风控组件的 DOM 锚点（阿里系滑块/验证弹层），命中即视为风控。 */
export const RISK_ELEMENT_SELECTORS: readonly string[] = [
  '.nc-container',
  '#nc_1_wrapper',
  '.baxia-dialog',
  '#baxia-dialog-content',
  'iframe[src*="punish"]',
  '[class*="captcha"]',
]

/** 探测脚本的稳定注释标记：测试替身和调试日志靠它识别这次 evaluate 的用途。 */
export const RISK_PROBE_MARKER = '/* bf-risk-probe */'

/** 只是旁路探测，不改变页面；返回 JSON 字符串，解析失败按「没有风控」处理。 */
export function publishRiskProbeScript(): string {
  return [
    RISK_PROBE_MARKER,
    '(function () {',
    '  const url = String(location.href || "");',
    '  const text = document.body ? String(document.body.innerText || "") : "";',
    '  const textMarkers = ' + JSON.stringify(RISK_TEXT_MARKERS) + ';',
    '  const elementSelectors = ' + JSON.stringify(RISK_ELEMENT_SELECTORS) + ';',
    '  const textHits = [];',
    '  for (const marker of textMarkers) {',
    '    if (text.indexOf(marker) !== -1) textHits.push(marker);',
    '  }',
    '  // 闲鱼风控响应里常见的 1004：单独出现不算，必须同时有「风控/验证」语境。',
    '  if (text.indexOf("1004") !== -1 && (text.indexOf("风控") !== -1 || text.indexOf("验证") !== -1)) {',
    '    textHits.push("1004");',
    '  }',
    '  const elementHits = [];',
    '  for (const selector of elementSelectors) {',
    '    try {',
    '      if (document.querySelector(selector)) elementHits.push(selector);',
    '    } catch (error) {',
    '      // 选择器非法只是这一条探测失效，不能让整个风控探测抛错（会盖掉真实步骤错误）。',
    '      void error;',
    '    }',
    '  }',
    '  return JSON.stringify({ url: url, textHits: textHits, elementHits: elementHits });',
    '})()',
  ].join('\n')
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item !== '') out.push(item)
  }
  return out
}

/**
 * 纯分类函数：URL 优先（跳转到风控页最确定），其次页面文案，最后风控组件。
 * 单独导出是为了用假信号做单测，不需要真的页面。
 */
export function classifyPublishRisk(signals: RiskSignals): PublishRisk | undefined {
  const url = signals.url.toLowerCase()
  for (const marker of RISK_URL_MARKERS) {
    if (url.includes(marker)) return { kind: 'url', reason: 'URL 命中「' + marker + '」' }
  }
  const textHit = signals.textHits[0]
  if (textHit !== undefined) return { kind: 'text', reason: '页面出现「' + textHit + '」' }
  const elementHit = signals.elementHits[0]
  if (elementHit !== undefined) return { kind: 'element', reason: '页面出现风控组件 ' + elementHit }
  return undefined
}

/**
 * 解析页面探测结果。非字符串/空串/坏 JSON 一律当作「没有风控」：
 * 这是旁路探测，解析失败不能反过来改变正常发布路径的失败语义。
 */
export function parsePublishRiskProbe(raw: unknown): PublishRisk | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    void error
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const url = typeof record['url'] === 'string' ? record['url'] : ''
  return classifyPublishRisk({
    url,
    textHits: readStringList(record['textHits']),
    elementHits: readStringList(record['elementHits']),
  })
}

/** 读一次页面风控信号；页面求值异常照常上抛（CdpPage 会包成 XianyuError INTERNAL）。 */
export async function detectPublishRisk(page: DomPage): Promise<PublishRisk | undefined> {
  const raw = await page.evaluate<unknown>(publishRiskProbeScript())
  return parsePublishRiskProbe(raw)
}

function riskError(step: string, risk: PublishRisk): XianyuError {
  return new XianyuError({
    code: 'RISK_CONTROL',
    message: '发布步骤「' + step + '」遇到风控：' + risk.reason
      + '；不自动重试：重放会加重风控且可能重复上架，需人工完成验证并等冷却（默认 600s）后再手动重试',
    details: { step },
  })
}

async function assertNoRisk(page: DomPage, step: string, ctx: PublishContext): Promise<void> {
  const risk = await detectPublishRisk(page)
  if (risk === undefined) return
  ctx.log(step, '识别到风控：' + risk.reason)
  throw riskError(step, risk)
}

/** 给每个步骤套上「执行前/执行后/步骤自己抛错时」三道风控检查。 */
export function withRiskGuards(steps: readonly PublishStep[]): PublishStep[] {
  return steps.map((step): PublishStep => ({
    name: step.name,
    async run(page, ctx) {
      await assertNoRisk(page, step.name, ctx)
      try {
        await step.run(page, ctx)
      } catch (error) {
        // 步骤失败可能正是因为撞到风控：先看一眼页面，风控原因比底层报错更有诊断价值。
        const risk = await detectPublishRisk(page)
        if (risk === undefined) throw error
        ctx.log(step.name, '识别到风控：' + risk.reason)
        throw riskError(step.name, risk)
      }
      if (step.postRiskCheck === false) {
        // 终态步骤（提交并验证）：成功后页面被风控弹层盖住是常态，但上架已经生效，
        // 不能把成功翻成失败。这里只记一条日志，交给人工确认页面。
        const risk = await detectPublishRisk(page)
        if (risk !== undefined) {
          ctx.log(step.name, '提交已完成，页面出现风控弹层（不影响已生成的上架）：' + risk.reason)
        }
        return
      }
      await assertNoRisk(page, step.name, ctx)
    },
  }))
}

/**
 * 带风控检查地执行发布步骤。
 *
 * runPublishSteps 会把步骤异常收成 { ok:false, error }；若异常是 RISK_CONTROL，
 * 这里重新抛成 XianyuError，daemon/CLI 拿到的才是可路由的 code（worker 靠它 trip 熔断）。
 * 其它失败保持原契约返回，不改变既有失败语义。
 */
export async function runRiskGuardedSteps(
  page: CdpPage,
  steps: readonly PublishStep[],
  ctx: PublishContext,
): Promise<PublishRunResult> {
  const result = await runPublishSteps(page, withRiskGuards(steps), ctx)
  if (!result.ok && result.code === 'RISK_CONTROL') {
    throw new XianyuError({
      code: 'RISK_CONTROL',
      message: result.error,
      details: { step: result.step },
    })
  }
  return result
}
