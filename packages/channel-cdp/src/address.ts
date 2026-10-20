/**
 * 地址步骤：在闲鱼「宝贝所在地」候选里挑与目标匹配的一条。
 *
 * 为什么不能盲点第一个候选：搜索「广州大学城」时列表第一个是「生活垃圾分类驿站」，
 * 地址写错不会报错，但商品会挂到错误城市（运费/同城流量全错）。所以这里按文本匹配，
 * 匹配不上就 fail-closed 让用户人工处理，绝不"点一个看起来像的"。
 * @module @bigfish/channel-cdp/address
 */
import { XianyuError } from '@bigfish/core'
import { clickSelectorAt, readSelectorTexts } from './dom.ts'
import type { DomPage } from './dom.ts'

const POLL_MS = 400

/** 候选里挑匹配项：先整串包含，再退到前 3 字前缀；都没有返回 -1。 */
function matchIndex(texts: string[], keyword: string, prefix: string): number {
  const exact = texts.findIndex((text) => text.includes(keyword))
  if (exact >= 0) return exact
  if (prefix.length < 2) return -1
  return texts.findIndex((text) => text.includes(prefix))
}

/**
 * 轮询地址候选，命中目标后点那一条，返回候选文本。
 * 超时仍无匹配 → VALIDATION（带当前看到的候选，便于人工判断是搜索词问题还是页面改版）。
 */
export async function pickAddressOption(
  page: DomPage,
  selector: string,
  address: string,
  timeoutMs: number,
): Promise<string> {
  const keyword = address.trim()
  const prefix = keyword.slice(0, 3)
  const deadline = Date.now() + timeoutMs
  let last: string[] = []
  while (Date.now() < deadline) {
    last = await readSelectorTexts(page, selector)
    const hit = matchIndex(last, keyword, prefix)
    if (hit >= 0) {
      await clickSelectorAt(page, selector, hit, '地点候选')
      return last[hit] ?? keyword
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new XianyuError({
    code: 'VALIDATION',
    message: '地址候选里没有匹配「' + keyword + '」的项（看到：' + (last.slice(0, 5).join(' | ') || '空') + '）',
  })
}
