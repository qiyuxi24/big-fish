/**
 * 发布过程中的「报告物料」：截图证据 + 失败原因摘句。
 *
 * 两者都只服务于人看证据，不参与成功判定，所以从 publish.ts 拆出来——发布步骤本身
 * 已经很长，拆开后才守得住 AGENTS §3 的「文件 ≤ 400 行」。
 * @module @bigfish/channel-cdp/report
 */
import { XianyuError } from '@bigfish/core'

/** 截图只需要这一个能力，不必依赖完整 CdpPage（测试里给个假对象就能跑）。 */
export interface ScreenshotTarget {
  screenshot(target: string): Promise<void>
}

/** 截图选项：只有「截到哪」这一件事和发布有关。 */
export interface ScreenshotOptions {
  screenshotsDir?: string
}

/**
 * 截一张证据图（每步一张，落在 options.screenshotsDir 下）。
 *
 * 截图只是证据：真机偶发 Page.captureScreenshot 超时（2026-10-23 干跑遇到一次），
 * 表单状态不受影响，所以先重试一次；仍失败才抛错，避免一次截图抖动把整条发布判成失败。
 */
export async function shot(
  page: ScreenshotTarget,
  options: ScreenshotOptions,
  name: string,
): Promise<void> {
  if (options.screenshotsDir === undefined) return
  const target = options.screenshotsDir + '/' + name + '.png'
  try {
    await page.screenshot(target)
    return
  } catch {
    await wait(300)
  }
  try {
    await page.screenshot(target)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new XianyuError({
      code: 'INTERNAL',
      message: '截图重试后仍失败（表单已按步骤填写，请人工确认页面状态）：' + name + '：' + reason.slice(0, 120),
    })
  }
}

/** 从页面文本里摘一条可能的原因（只用于报错提示，不参与成功判定）。 */
export function findProblemHint(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const keywords = ['请选择', '请填写', '不能为空', '暂不支持', '扫码', '失败', '错误']
  const hit = lines.find((line) => keywords.some((keyword) => line.includes(keyword)))
  return hit === undefined ? undefined : hit.slice(0, 80)
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
