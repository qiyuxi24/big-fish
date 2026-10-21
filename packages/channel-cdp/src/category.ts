/**
 * 闲鱼 PC 发布页的「分类」下拉。
 *
 * 事实来自抓包 + 真机校准（2026-10-21，测试小号）：
 * - 分类是 antd Select（`.ant-select-single`），当前值在 `.ant-select-selection-item` 的 title 上；
 * - JS 的 el.click() 打不开下拉，必须向 `.ant-select-selector` 中心派发**可信鼠标事件**（Input.dispatchMouseEvent）；
 * - 选项是 body 级 portal 的 `.ant-select-item-option`，文本就是类目名；
 * - 网页端只支持部分类目：选中不支持的会**立刻**在分类下方出现「网页版暂不支持发布此分类」，
 *   点提交同样只会被拦。所以这里选完必须回读校验，遇到不支持直接失败，不靠提交去撞。
 *
 * 页面会按图片/文案用 AI 预先识别一个类目，识别完成后会覆盖下拉值；
 * 因此选类目前先等它落定，避免我们选的类目被随后到来的识别结果覆盖。
 * @module @bigfish/channel-cdp/category
 */
import { XianyuError } from '@bigfish/core'
import { readBodyText } from './dom.ts'
import { readFormFieldText } from './form.ts'
import type { DomPage } from './dom.ts'
import type { PublishContext } from './steps.ts'

/**
 * 分类步骤的页面能力面：DOM 助手 + 可选截图。
 * 只声明用到的部分，测试假页面不必实现整个 CdpPage（真调用方传 CdpPage 即可满足）。
 */
export interface CategoryPage extends DomPage {
  screenshot?(path: string): Promise<void>
}

/** 「分类」表单项的 label 文本。 */
export const CATEGORY_LABEL = '分类'
/** 选中网页端不支持类目时页面出现的提示（原文）。 */
export const CATEGORY_UNSUPPORTED_TEXT = '网页版暂不支持发布此分类'
/** 分类下拉选项的选择器（antd portal，挂在 body 上）。 */
const CATEGORY_OPTION = '.ant-select-item-option'
const DEFAULT_TIMEOUT_MS = 20_000
const RECOGNITION_WAIT_MS = 10_000
const POLL_MS = 300

/** 找到「分类」表单项里的 antd Select 触发器，返回其中心坐标（找不到返回 undefined）。 */
async function readSelectTriggerPoint(page: DomPage): Promise<{ x: number; y: number } | undefined> {
  const script = [
    '(function () {',
    '  /* bf-category-select-rect */',
    '  const want = ' + JSON.stringify(CATEGORY_LABEL) + ';',
    '  const items = Array.from(document.querySelectorAll(".ant-form-item"));',
    '  const item = items.find(function (it) {',
    '    const label = it.querySelector(".ant-form-item-label label");',
    '    if (label === null) return false;',
    '    const title = (label.getAttribute("title") || "").trim();',
    '    return title === want || (label.textContent || "").trim() === want;',
    '  });',
    '  if (!item) return "";',
    '  const trigger = item.querySelector(".ant-select-selector");',
    '  if (!trigger) return "";',
    '  const rect = trigger.getBoundingClientRect();',
    '  if (rect.width <= 0 || rect.height <= 0) return "";',
    '  return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });',
    '})()',
  ].join('\n')
  return parsePoint(await page.evaluate<unknown>(script))
}

/** 读分类下拉当前选中项的文本（没选中返回空串）。 */
export async function readCategoryValue(page: DomPage): Promise<string> {
  const script = [
    '(function () {',
    '  /* bf-category-value */',
    '  const want = ' + JSON.stringify(CATEGORY_LABEL) + ';',
    '  const items = Array.from(document.querySelectorAll(".ant-form-item"));',
    '  const item = items.find(function (it) {',
    '    const label = it.querySelector(".ant-form-item-label label");',
    '    if (label === null) return false;',
    '    const title = (label.getAttribute("title") || "").trim();',
    '    return title === want || (label.textContent || "").trim() === want;',
    '  });',
    '  if (!item) return "";',
    '  const selected = item.querySelector(".ant-select-selection-item");',
    '  if (!selected) return "";',
    '  const title = (selected.getAttribute("title") || "").trim();',
    '  return title === "" ? ((selected.textContent || "").trim()) : title;',
    '})()',
  ].join('\n')
  const value = await page.evaluate<unknown>(script)
  return typeof value === 'string' ? value : ''
}

/** 等页面 AI 识别落定（分类有值）；超时不算错，继续尝试手选。 */
async function waitRecognitionSettled(page: DomPage, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await readCategoryValue(page).catch(() => '')
    if (last !== '') return last
    await delay(POLL_MS)
  }
  return last
}

/** 找文本完全等于 want 的候选（antd 选项文本就是类目名），返回其中心坐标。 */
async function readOptionPoint(page: DomPage, want: string): Promise<{ x: number; y: number } | undefined> {
  const script = [
    '(function () {',
    '  /* bf-category-option-rect */',
    '  const want = ' + JSON.stringify(want) + ';',
    '  const nodes = Array.from(document.querySelectorAll(' + JSON.stringify(CATEGORY_OPTION) + '));',
    '  const hit = nodes.find(function (el) { return (el.textContent || "").trim() === want; });',
    '  if (!hit) return "";',
    '  hit.scrollIntoView({ block: "center", inline: "center" });',
    '  const rect = hit.getBoundingClientRect();',
    '  if (rect.width <= 0 || rect.height <= 0) return "";',
    '  return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });',
    '})()',
  ].join('\n')
  return parsePoint(await page.evaluate<unknown>(script))
}

/**
 * 在坐标上派发一段可信鼠标事件（move → press → release）。
 * antd Select 只认真实指针事件；Runtime.evaluate 里造的 MouseEvent 打不开下拉。
 */
export async function trustedClickAt(page: DomPage, point: { x: number; y: number }): Promise<void> {
  const base = { x: point.x, y: point.y }
  await page.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none', clickCount: 0 })
  await page.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, button: 'left', clickCount: 1 })
  await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, button: 'left', clickCount: 1 })
}

/** 打开分类下拉（点触发器中心）。 */
async function openCategorySelect(page: DomPage): Promise<void> {
  const point = await readSelectTriggerPoint(page)
  if (point === undefined) {
    throw new XianyuError({
      code: 'VALIDATION',
      message: '页面上找不到「分类」下拉（antd Select 触发器不可见），可能页面结构又改了，需重新校准选择器',
    })
  }
  await trustedClickAt(page, point)
}

/** 在下拉里点选文本完全等于 category 的选项，并回读确认已选中。 */
async function clickCategoryOption(page: DomPage, category: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let seen: string[] = []
  while (Date.now() < deadline) {
    const point = await readOptionPoint(page, category)
    if (point !== undefined) {
      await trustedClickAt(page, point)
      const picked = await readCategoryValue(page)
      if (picked === category) return
      throw new XianyuError({
        code: 'VALIDATION',
        message: '点了分类「' + category + '」但下拉显示的是「' + picked + '」，拒绝继续（避免发到错误类目）',
      })
    }
    seen = await readCategoryOptionTexts(page)
    await delay(POLL_MS)
  }
  throw new XianyuError({
    code: 'VALIDATION',
    message:
      '分类下拉里没有「' + category + '」这个选项（页面当前候选：' +
      (seen.length === 0 ? '空，下拉可能没打开' : seen.slice(0, 12).join('、')) +
      '）',
  })
}

/** 当前下拉里出现的候选文本（只用于报错提示）。 */
export async function readCategoryOptionTexts(page: DomPage): Promise<string[]> {
  const script = [
    '(function () {',
    '  /* bf-category-option-texts */',
    '  const nodes = Array.from(document.querySelectorAll(' + JSON.stringify(CATEGORY_OPTION) + '));',
    '  return nodes.map(function (el) { return (el.textContent || "").trim(); }).filter(function (t) { return t !== ""; });',
    '})()',
  ].join('\n')
  const value = await page.evaluate<unknown>(script).catch(() => undefined)
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * 选类目步骤：等 AI 识别落定 → 打开下拉 → 点选 draft.category → 回读 → 检查「是否网页端支持」。
 * 选中的类目网页端不支持时立即失败（页面会提示扫码去 App），不留到提交才发现。
 */
export async function stepSelectCategory(
  page: CategoryPage,
  ctx: PublishContext,
  category: string,
  options: { timeoutMs?: number; screenshotsDir?: string },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const recognized = await waitRecognitionSettled(page, Math.min(timeoutMs, RECOGNITION_WAIT_MS))
  await openCategorySelect(page)
  await clickCategoryOption(page, category, timeoutMs)
  await assertCategoryPublishable(page, category)
  ctx.log('选择分类', 'AI 识别为「' + recognized + '」→ 选为「' + category + '」（网页端支持）')
  if (options.screenshotsDir !== undefined && page.screenshot !== undefined) {
    await page.screenshot(options.screenshotsDir + '/04b-category.png')
  }
}

/**
 * 类目网页端可用性断言：页面一旦出现「网页版暂不支持发布此分类」就 fail-closed。
 * 选类目后立刻调一次（页面即时提示），提交前再调一次（页面结构变化时兜底）。
 */
export async function assertCategoryPublishable(page: DomPage, category: string): Promise<void> {
  const text = await readBodyText(page)
  if (!text.includes(CATEGORY_UNSUPPORTED_TEXT)) return
  throw new XianyuError({
    code: 'VALIDATION',
    message:
      '类目「' + category + '」网页版不支持发布（页面提示「' + CATEGORY_UNSUPPORTED_TEXT + '」）：' +
      '请换一个网页端支持的类目，或改用 App 扫码发布（本工具不自动点二维码）',
  })
}

/** 解析页面脚本返回的坐标 JSON；非法一律当没找到（页面重渲染时 rect 会短暂为 0）。 */
function parsePoint(raw: unknown): { x: number; y: number } | undefined {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const x = record['x']
  const y = record['y']
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
  if (x <= 0 || y <= 0) return undefined
  return { x, y }
}

/** 表单项读值兜底（仅用于日志；category.ts 的主要回读走 readCategoryValue）。 */
export async function readCategoryFieldText(page: DomPage): Promise<string> {
  return readFormFieldText(page, CATEGORY_LABEL)
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
