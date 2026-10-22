/**
 * 闲鱼 PC 发布页的「分类」下拉。
 *
 * 事实来自抓包 + 真机校准（2026-10-21/22，测试小号）：
 * - 分类是 antd Select，值在 `.ant-select-selection-item` 的 title 上；JS 的 el.click() 打不开下拉，
 *   必须向 `.ant-select-selector` 中心派发可信鼠标事件（Input.dispatchMouseEvent）；
 * - 选项挂在 body 级 portal `.ant-select-dropdown` 里，**每个 Select 复用一个 portal 节点**：
 *   关闭后节点不销毁，只加 `ant-select-dropdown-hidden` / leave 动画类、选项仍留在 DOM 中。
 *   所以绝不能全页扫 `.ant-select-item-option`：会把已关闭或别的 Select 的选项扫进来，点到不属于当前下拉的坐标；
 * - 下拉打开后**不要对选项调 scrollIntoView**：真机实测它把主页面滚了 65px（scrollY 94→29），
 *   antd 跟着重排下拉，随后的可信点击落空（选项显示 hover 但值不变、下拉按「点了外面」开始关闭）。
 *   坐标必须在页面不滚动的状态下取；
 * - 本机环境下拉 appear 动画永远走不完（class 停在 `ant-slide-up-appear-prepare`、opacity 0），
 *   但节点 pointer-events:auto、真实鼠标事件能点中。判「打开」只认 `.ant-select-open` + aria-expanded=true，
 *   不能等动画/可见性；
 * - 页面会按图片/文案用 AI 识别类目并覆盖下拉值，所以选完必须回读：连续两次读到目标值才算成功，
 *   不一致就重开下拉重选（有限次），仍不一致才 fail-closed；网页端不支持的类目直接失败。
 * - 「分类」下拉**不是全量类目树**：候选来自 AI 识别推荐（mtop.taobao.idle.kgraph.property.recommend，
 *   入参带标题/描述/图片，一次约 10 个），不能搜索、不能手输。所以草稿的 category 必须落在候选里；
 *   推荐是异步刷新的，暂时看不到时关掉下拉等一会儿再重开（见 REFRESH_WAIT_MS），等不到才 fail-closed。
 *
 * 页面脚本与返回值窄化放在 category-page.ts，本文件只写流程与决策。
 * @module @bigfish/channel-cdp/category
 */
import { XianyuError } from '@bigfish/core'
import { readBodyText } from './dom.ts'
import {
  CATEGORY_LABEL,
  categoryOptionScript,
  categoryOptionTextsScript,
  categoryRevealOptionScript,
  categoryScrollScript,
  categoryStateScript,
  categoryValueScript,
  parseRecord,
  readNumber,
  readPoint,
  readTextList,
} from './category-page.ts'
import { readFormFieldText } from './form.ts'
import type { CategoryOptionProbe, CategorySelectState, OptionMiss } from './category-page.ts'
import type { DomPage } from './dom.ts'
import type { PublishContext } from './steps.ts'

export { CATEGORY_LABEL }

/** 分类步骤的页面能力面：DOM 助手 + 可选截图。 */
export interface CategoryPage extends DomPage {
  screenshot?(path: string): Promise<void>
}

/** 选中网页端不支持类目时页面出现的提示（原文）。 */
export const CATEGORY_UNSUPPORTED_TEXT = '网页版暂不支持发布此分类'
const DEFAULT_TIMEOUT_MS = 20_000
const RECOGNITION_WAIT_MS = 10_000
const OPEN_WAIT_MS = 8_000
const OPTION_WAIT_MS = 3_000
const CONFIRM_MS = 1_200
const POLL_MS = 300
/** 两次尝试之间给「AI 推荐重新算一遍」留的时间；推荐接口是异步的，立刻重开会拿到旧候选。 */
const REFRESH_WAIT_MS = 700
/** 点选尝试次数上限：AI 识别可能在点击后把值改回去，重开下拉再选即可，但不能无限重试。 */
const PICK_ATTEMPTS = 3

/** 读「分类」下拉状态；触发器不存在/不可见返回 undefined。 */
async function readCategorySelectState(page: DomPage): Promise<CategorySelectState | undefined> {
  const record = parseRecord(await page.evaluate<unknown>(categoryStateScript()))
  if (record === undefined) return undefined
  const x = readNumber(record, 'x')
  const y = readNumber(record, 'y')
  if (x === undefined || y === undefined) return undefined
  return { point: { x, y }, inViewport: record['inViewport'] === true, open: record['open'] === true }
}

/** 读分类下拉当前选中项的文本（没选中返回空串）。 */
export async function readCategoryValue(page: DomPage): Promise<string> {
  const value = await page.evaluate<unknown>(categoryValueScript())
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

/** 找文本完全等于 want 的候选（限定在当前打开的那个下拉里），返回坐标或没找到的原因。 */
async function readCategoryOptionPoint(page: DomPage, want: string): Promise<CategoryOptionProbe> {
  const record = parseRecord(await page.evaluate<unknown>(categoryOptionScript(want)))
  if (record === undefined) return { options: [] }
  const options = readTextList(record['options'])
  const point = readPoint(record)
  if (point !== undefined) return { point, options }
  const miss = record['miss']
  if (miss === 'not-open' || miss === 'no-option' || miss === 'off-screen' || miss === 'obscured') {
    return { miss, options }
  }
  return { options }
}

/** 当前下拉里出现的候选文本（只用于报错提示）。 */
export async function readCategoryOptionTexts(page: DomPage): Promise<string[]> {
  const value = await page.evaluate<unknown>(categoryOptionTextsScript()).catch(() => undefined)
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
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

/** 轮询直到下拉真的打开（或超时）；返回最后一次状态。 */
async function waitCategoryOpen(page: DomPage, timeoutMs: number): Promise<CategorySelectState | undefined> {
  const deadline = Date.now() + timeoutMs
  let state = await readCategorySelectState(page)
  while (state !== undefined && !state.open && Date.now() < deadline) {
    await delay(Math.min(POLL_MS, Math.max(0, deadline - Date.now())))
    state = await readCategorySelectState(page)
  }
  return state
}

/**
 * 打开分类下拉，并断言它真的打开了。
 * 与旧实现的区别：旧实现点完就走，下拉没打开时会拿全页旧选项坐标去点（本次故障的一半原因）。
 */
async function openCategorySelect(page: DomPage, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let state = await readCategorySelectState(page)
  if (state === undefined) throw missingTriggerError()
  if (state.open) return
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!state.inViewport) {
      /* 只在打开之前滚：打开后再滚页面会让 antd 重排下拉，坐标失效 */
      await page.evaluate<unknown>(categoryScrollScript())
      await delay(POLL_MS)
      const reread = await readCategorySelectState(page)
      if (reread === undefined) throw missingTriggerError()
      if (!reread.inViewport) {
        throw new XianyuError({
          code: 'VALIDATION',
          message: '「分类」下拉在视口外，滚动后仍不可见（可能被弹层遮挡），不继续以免点错位置',
        })
      }
      state = reread
    }
    await trustedClickAt(page, state.point)
    const opened = await waitCategoryOpen(page, Math.min(OPEN_WAIT_MS, Math.max(POLL_MS, deadline - Date.now())))
    if (opened !== undefined && opened.open) return
    if (opened !== undefined) state = opened
  }
  throw new XianyuError({
    code: 'VALIDATION',
    message: '点了「分类」下拉但下拉没有打开（antd Select 没响应可信点击）；不继续，避免点到别的候选',
  })
}

/** 轮询等选项渲染出坐标（下拉刚打开时虚拟列表可能还没布局完）。 */
async function waitCategoryOptionPoint(page: DomPage, want: string, timeoutMs: number): Promise<CategoryOptionProbe> {
  const deadline = Date.now() + timeoutMs
  let probe = await readCategoryOptionPoint(page, want)
  while (probe.point === undefined && Date.now() < deadline) {
    await delay(Math.min(POLL_MS, Math.max(0, deadline - Date.now())))
    probe = await readCategoryOptionPoint(page, want)
  }
  return probe
}

/**
 * 把目标选项滚进下拉自己的可视区（rc-virtual-list 只给可视范围内的选项坐标）。
 * 只改下拉内部 holder 的 scrollTop：页面不滚，antd 不会重排下拉。
 */
async function revealCategoryOption(page: DomPage, want: string): Promise<boolean> {
  const result = await page.evaluate<unknown>(categoryRevealOptionScript(want)).catch(() => undefined)
  if (result !== 'ok') return false
  await delay(POLL_MS)
  return true
}

/**
 * 关掉分类下拉，为「重开拿到新候选」做准备。
 * 先按 Escape（antd Select 的默认关闭键），没关掉再点一次触发器（点击已展开的 Select 会收起）。
 */
async function closeCategorySelect(page: DomPage): Promise<void> {
  const state = await readCategorySelectState(page).catch(() => undefined)
  if (state === undefined || !state.open) return
  const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  await page.command('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
  await page.command('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  await delay(POLL_MS)
  const after = await readCategorySelectState(page).catch(() => undefined)
  if (after !== undefined && after.open) {
    await trustedClickAt(page, after.point)
    await delay(POLL_MS)
  }
}

/**
 * 点击后等回读落定：连续两次读到目标值才算选中。
 * 单次读不够——页面 AI 识别可能在点击后的一小段时间内把值改回去。
 */
async function waitCategoryPicked(page: DomPage, category: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + Math.min(timeoutMs, CONFIRM_MS)
  let last = ''
  let hits = 0
  while (true) {
    last = await readCategoryValue(page)
    if (last === category) {
      hits += 1
      if (hits >= 2) return last
    } else {
      hits = 0
    }
    if (Date.now() >= deadline) return last
    await delay(Math.min(POLL_MS, Math.max(0, deadline - Date.now())))
  }
}

/** 打开下拉 → 点目标选项 → 回读确认；回读不一致或暂时没候选时重开重选，最多 PICK_ATTEMPTS 次。 */
async function pickCategoryOption(page: DomPage, category: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let seen: string[] = []
  let picked = ''
  let miss: OptionMiss | undefined
  for (let attempt = 1; attempt <= PICK_ATTEMPTS; attempt += 1) {
    await openCategorySelect(page, timeoutMs)
    let probe = await waitCategoryOptionPoint(page, category, Math.min(timeoutMs, OPTION_WAIT_MS))
    if (probe.options.length > 0) seen = probe.options
    if (probe.point === undefined && probe.miss === 'off-screen') {
      /* 候选多于下拉可视行数时末几项没有可用坐标：只滚下拉内部 holder，不动页面 */
      if (await revealCategoryOption(page, category)) {
        probe = await readCategoryOptionPoint(page, category)
        if (probe.options.length > 0) seen = probe.options
      }
    }
    if (probe.point === undefined) {
      miss = probe.miss
      /* 候选由 AI 推荐接口算出来（随图片/文案刷新，异步）：关掉下拉等一会儿再重开，
         目标类目可能只是还没被推荐出来，不能一次没看到就判死 */
      if (attempt < PICK_ATTEMPTS) {
        await closeCategorySelect(page)
        /* 等待时间受步骤总预算约束：预算不够就立刻重试，不把整个步骤拖超时 */
        await delay(Math.min(REFRESH_WAIT_MS * attempt, Math.max(0, deadline - Date.now())))
      }
      continue
    }
    miss = undefined
    await trustedClickAt(page, probe.point)
    picked = await waitCategoryPicked(page, category, timeoutMs)
    if (picked === category) return
  }
  if (picked !== '') throw mismatchError(category, picked)
  throw missingOptionError(category, seen, miss)
}

/** 回读值仍不是目标：fail-closed，宁可不发布也不发到错误类目。 */
function mismatchError(category: string, picked: string): XianyuError {
  return new XianyuError({
    code: 'VALIDATION',
    message: '点了分类「' + category + '」但下拉显示的是「' + picked + '」，拒绝继续（避免发到错误类目）',
  })
}

/**
 * 下拉里没有该选项：把候选和平台约束带进报错，方便人工改草稿而不是反复重试。
 * 事实：PC 发布页的「分类」不是全量类目树，只是 AI 识别的推荐（mtop.taobao.idle.kgraph.property.recommend，
 * 入参含标题/描述/图片），一次约 10 个候选，不能搜索、不能手输。
 */
function missingOptionError(category: string, seen: string[], miss?: OptionMiss): XianyuError {
  const hint =
    miss === 'not-open'
      ? '（下拉没打开，可能点选时机问题）'
      : '（闲鱼 PC 发布页的分类只能从 AI 推荐里选：推荐由图片和文案决定，一次约 10 个候选，不能搜索或手输）'
  return new XianyuError({
    code: 'VALIDATION',
    message:
      '分类下拉里没有「' + category + '」这个选项' + hint + '；页面当前候选' +
      (seen.length === 0 ? '为空' : '：' + seen.slice(0, 12).join('、')) +
      '。可改用候选里的类目，或把品类关键词写进标题/描述后重试（推荐会随文案刷新），或显式指定「其他闲置」兜底',
  })
}

function missingTriggerError(): XianyuError {
  return new XianyuError({
    code: 'VALIDATION',
    message: '页面上找不到「分类」下拉（antd Select 触发器不可见），可能页面结构又改了，需重新校准选择器',
  })
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
  await pickCategoryOption(page, category, timeoutMs)
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

/** 表单项读值兜底（仅用于日志；category.ts 的主要回读走 readCategoryValue）。 */
export async function readCategoryFieldText(page: DomPage): Promise<string> {
  return readFormFieldText(page, CATEGORY_LABEL)
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
