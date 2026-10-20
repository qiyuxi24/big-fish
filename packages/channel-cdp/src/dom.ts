/**
 * CDP 页面 DOM 助手：点击、填值、上传文件、等待文本/计数。
 *
 * 全部基于 Runtime.evaluate 与 DOM 域，不依赖任何浏览器驱动库；
 * 只依赖 DomPage 这个最小接口，测试用假页面即可回放。
 * @module @bigfish/channel-cdp/dom
 */
import { XianyuError } from '@bigfish/core'
import type { WaitForOptions } from './page.ts'

/** 页面助手需要的最小能力面（CdpPage 满足它，测试可注入假实现）。 */
export interface DomPage {
  evaluate<T = unknown>(expression: string): Promise<T>
  waitFor(expression: string, opts?: WaitForOptions): Promise<void>
  command<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

export interface DomWaitOptions {
  timeoutMs?: number
  intervalMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_POLL_MS = 500
const DONE = 'ok'
const MISSING = 'missing'

/** 把任意字符串安全嵌进页面脚本（JSON 字符串，转义引号/换行）。 */
export function jsQuote(value: string): string {
  return JSON.stringify(value)
}

/** 元素是否存在（选择器非法时按 false 处理，避免轮询里反复抛异常）。 */
export async function elementExists(page: DomPage, selector: string): Promise<boolean> {
  try {
    return await page.evaluate<boolean>('!!document.querySelector(' + jsQuote(selector) + ')')
  } catch (error) {
    throw toDomError(error, '查询元素失败：' + selector)
  }
}

/** 元素数量；找不到就是 0。 */
export async function countElements(page: DomPage, selector: string): Promise<number> {
  try {
    const count = await page.evaluate<unknown>(
      'document.querySelectorAll(' + jsQuote(selector) + ').length',
    )
    return typeof count === 'number' ? count : 0
  } catch (error) {
    throw toDomError(error, '统计元素失败：' + selector)
  }
}

/**
 * 点击选择器命中的第一个元素。
 * 先 scrollIntoView 再 click，避免元素在视口外时 CDP 点击落空。
 */
export async function clickSelector(page: DomPage, selector: string, label?: string): Promise<void> {
  const script = [
    '(function () {',
    '  const el = document.querySelector(' + jsQuote(selector) + ');',
    '  if (!el) return ' + jsQuote(MISSING) + ';',
    '  el.scrollIntoView({ block: "center", inline: "center" });',
    '  el.click();',
    '  return ' + jsQuote(DONE) + ';',
    '})()',
  ].join('\n')
  const result = await page.evaluate<unknown>(script).catch((error: unknown) => {
    throw toDomError(error, '点击失败：' + (label ?? selector))
  })
  if (result !== DONE) throw new XianyuError({ code: 'VALIDATION', message: '没找到要点击的元素：' + (label ?? selector) })
}

/**
 * 点按文字（闲鱼页面大量按钮没有稳定 class，文字是最稳的锚点）。
 * 只接受「文本完全等于目标」或「包含目标且没有更深匹配」的元素，避免点到整页容器。
 */
export async function clickByText(page: DomPage, text: string, label?: string): Promise<void> {
  const script = [
    '(function () {',
    '  const want = ' + jsQuote(text) + ';',
    '  const nodes = Array.from(document.querySelectorAll("button, a, div, span, li, label"));',
    '  let best = null;',
    '  for (const el of nodes) {',
    '    const t = (el.textContent || "").trim();',
    '    if (t !== want) continue;',
    '    if (best === null || (el.textContent || "").length < (best.textContent || "").length) best = el;',
    '  }',
    '  if (!best) return ' + jsQuote(MISSING) + ';',
    '  best.scrollIntoView({ block: "center", inline: "center" });',
    '  best.click();',
    '  return ' + jsQuote(DONE) + ';',
    '})()',
  ].join('\n')
  const result = await page.evaluate<unknown>(script).catch((error: unknown) => {
    throw toDomError(error, '按文字点击失败：' + (label ?? text))
  })
  if (result !== DONE) throw new XianyuError({ code: 'VALIDATION', message: '页面上没有文字为「' + text + '」的可点元素' })
}

/**
 * 填值到 input/textarea（也支持 contenteditable）。
 *
 * React 受控组件只认原生 setter + input 事件：直接改 value 再派发事件会被 React 的
 * value tracker 判成「没变化」，因此这里显式调用原型上的 setter 再冒泡 input/change。
 */
export async function fillField(page: DomPage, selector: string, value: string, label?: string): Promise<void> {
  await fillFieldAt(page, selector, 0, value, label)
}

/** 填值到命中的第 index 个元素（0 基）；一个选择器匹配多个输入框时用（价格/原价/运费都是 placeholder="0.00"）。 */
export async function fillFieldAt(
  page: DomPage,
  selector: string,
  index: number,
  value: string,
  label?: string,
): Promise<void> {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new XianyuError({ code: 'VALIDATION', message: '输入框下标非法：' + String(index) })
  }
  const script = [
    '(function () {',
    '  const el = document.querySelectorAll(' + jsQuote(selector) + ')[' + String(index) + '];',
    '  if (!el) return ' + jsQuote(MISSING) + ';',
    '  const value = ' + jsQuote(value) + ';',
    '  el.scrollIntoView({ block: "center", inline: "center" });',
    '  if (el.isContentEditable) {',
    '    el.textContent = value;',
    '    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));',
    '  } else {',
    '    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;',
    '    const setter = Object.getOwnPropertyDescriptor(proto, "value");',
    '    if (!setter || !setter.set) return "unsupported";',
    '    setter.set.call(el, value);',
    '    el.dispatchEvent(new Event("input", { bubbles: true }));',
    '    el.dispatchEvent(new Event("change", { bubbles: true }));',
    '  }',
    '  el.blur();',
    '  return ' + jsQuote(DONE) + ';',
    '})()',
  ].join('\n')
  const result = await page.evaluate<unknown>(script).catch((error: unknown) => {
    throw toDomError(error, '填值失败：' + (label ?? selector))
  })
  if (result === MISSING) throw new XianyuError({ code: 'VALIDATION', message: '没找到输入框：' + (label ?? selector) })
  if (result !== DONE) throw new XianyuError({ code: 'UNSUPPORTED', message: '该输入框不支持直接填值：' + (label ?? selector) })
}

/**
 * 富文本编辑器填值（闲鱼发布页的「宝贝描述」是 contenteditable，不是 textarea）。
 *
 * 直接改 textContent 不生效：Lexical 这类编辑器只在命中输入管线时才同步自己的状态。
 * 因此这里走 CDP 原生输入：聚焦 → 全选内容 → Input.insertText；多行用 Enter 分段
 * （Input.insertText 里的 \n 不保证被编辑器当成换行）。真机已验证回读一致。
 */
export async function fillRichText(page: DomPage, selector: string, value: string, label?: string): Promise<void> {
  const focusScript = [
    '(function () {',
    '  const el = document.querySelector(' + jsQuote(selector) + ');',
    '  if (!el) return ' + jsQuote(MISSING) + ';',
    '  if (el.isContentEditable !== true) return "not-editable";',
    '  el.scrollIntoView({ block: "center", inline: "center" });',
    '  el.focus();',
    '  const range = document.createRange();',
    '  range.selectNodeContents(el);',
    '  const selection = window.getSelection();',
    '  if (!selection) return "no-selection";',
    '  selection.removeAllRanges();',
    '  selection.addRange(range);',
    '  return ' + jsQuote(DONE) + ';',
    '})()',
  ].join('\n')
  const focused = await page.evaluate<unknown>(focusScript).catch((error: unknown) => {
    throw toDomError(error, '聚焦富文本失败：' + (label ?? selector))
  })
  if (focused === MISSING) throw new XianyuError({ code: 'VALIDATION', message: '没找到富文本编辑器：' + (label ?? selector) })
  if (focused !== DONE) throw new XianyuError({ code: 'UNSUPPORTED', message: '该元素不是可编辑富文本：' + (label ?? selector) })
  const lines = value.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) await pressEnter(page)
    const line = lines[index] ?? ''
    if (line !== '') await page.command('Input.insertText', { text: line })
  }
  // 回读校验：编辑器吞掉输入时不静默通过（否则后面填完也提交不了）。
  const readback = await page.evaluate<unknown>(
    '(function () { const el = document.querySelector(' + jsQuote(selector) + '); return el ? (el.innerText || el.textContent || "") : ""; })()',
  )
  const actual = typeof readback === 'string' ? readback : ''
  const probe = lines.map((line) => line.trim()).find((line) => line !== '')
  if (probe !== undefined && !actual.includes(probe)) {
    throw new XianyuError({
      code: 'INTERNAL',
      message: '富文本填写后回读不一致（' + (label ?? selector) + '）：期望包含「' + probe.slice(0, 20) + '」，实际「' + actual.slice(0, 40) + '」',
    })
  }
}

/** 在 Input 域按一次回车（富文本换行用）。 */
async function pressEnter(page: DomPage): Promise<void> {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await page.command('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
  await page.command('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/**
 * 按元素类型选填值方式：contenteditable 走富文本输入，其余走原生 setter。
 * 发布页文案框在真机上是富文本，选择器没法区分，所以运行时判一次。
 */
export async function fillText(page: DomPage, selector: string, value: string, label?: string): Promise<void> {
  const editable = await page.evaluate<unknown>(
    '(function () { const el = document.querySelector(' + jsQuote(selector) + '); return el ? el.isContentEditable === true : false; })()',
  ).catch((error: unknown) => {
    throw toDomError(error, '判断输入框类型失败：' + (label ?? selector))
  })
  if (editable === true) {
    await fillRichText(page, selector, value, label)
    return
  }
  await fillField(page, selector, value, label)
}

/**
 * 用真实键盘输入往输入框里打字（Input.insertText），替换原有内容。
 *
 * 地址搜索框这类受 antd 受控组件：直接改 value 只改 DOM，组件状态不更新、联想不触发，
 * 所以必须走原生输入管线；先全选旧值再插入，等价于用户 ctrl+a 后重打。
 */
export async function typeInto(page: DomPage, selector: string, value: string, label?: string): Promise<void> {
  const focusScript = [
    '(function () {',
    '  const el = document.querySelector(' + jsQuote(selector) + ');',
    '  if (!el) return ' + jsQuote(MISSING) + ';',
    '  el.scrollIntoView({ block: "center", inline: "center" });',
    '  el.focus();',
    '  if (el.isContentEditable === true) {',
    '    const range = document.createRange();',
    '    range.selectNodeContents(el);',
    '    const selection = window.getSelection();',
    '    if (!selection) return "no-selection";',
    '    selection.removeAllRanges();',
    '    selection.addRange(range);',
    '  } else if (typeof el.setSelectionRange === "function") {',
    '    el.setSelectionRange(0, String(el.value === undefined ? "" : el.value).length);',
    '  }',
    '  return ' + jsQuote(DONE) + ';',
    '})()',
  ].join('\n')
  const focused = await page.evaluate<unknown>(focusScript).catch((error: unknown) => {
    throw toDomError(error, '聚焦输入框失败：' + (label ?? selector))
  })
  if (focused === MISSING) throw new XianyuError({ code: 'VALIDATION', message: '没找到输入框：' + (label ?? selector) })
  if (focused !== DONE) throw new XianyuError({ code: 'UNSUPPORTED', message: '该输入框不可聚焦：' + (label ?? selector) })
  if (value !== '') await page.command('Input.insertText', { text: value })
  const readback = await page.evaluate<unknown>(
    '(function () { const el = document.querySelector(' + jsQuote(selector) + '); if (!el) return ""; return String(el.value === undefined ? (el.innerText || "") : el.value); })()',
  )
  const actual = typeof readback === 'string' ? readback : ''
  if (!actual.includes(value)) {
    throw new XianyuError({
      code: 'INTERNAL',
      message: '输入后回读不一致（' + (label ?? selector) + '）：期望「' + value.slice(0, 20) + '」，实际「' + actual.slice(0, 40) + '」',
    })
  }
}

/** 查询页面里的文件输入节点（DOM.setFileInputFiles 要 nodeId，不能用选择器）。 */
export async function findFileInputNodeIds(page: DomPage, selector = 'input[type=file]'): Promise<number[]> {
  await page.command('DOM.enable')
  const document = await page.command<{ root?: { nodeId?: unknown } }>('DOM.getDocument', { depth: -1, pierce: true })
  const rootId = document.root?.nodeId
  if (typeof rootId !== 'number') throw new XianyuError({ code: 'INTERNAL', message: 'DOM.getDocument 没有返回 root.nodeId' })
  const found = await page.command<{ nodeIds?: unknown }>('DOM.querySelectorAll', { nodeId: rootId, selector })
  const ids = Array.isArray(found.nodeIds) ? found.nodeIds.filter((id): id is number => typeof id === 'number') : []
  return ids
}

/**
 * 给文件输入设置本地文件（CDP 原生方式，等价于用户选择文件）。
 * 浏览器进程按本机绝对路径读取，不经过页面 JS，所以不受文件选择框限制。
 */
export async function setFileInputFiles(page: DomPage, files: readonly string[], selector = 'input[type=file]'): Promise<void> {
  if (files.length === 0) throw new XianyuError({ code: 'VALIDATION', message: '上传文件列表为空' })
  const nodeIds = await findFileInputNodeIds(page, selector)
  const nodeId = nodeIds[0]
  if (nodeId === undefined) throw new XianyuError({ code: 'VALIDATION', message: '页面上没有文件输入框（' + selector + '）' })
  await page.command('DOM.setFileInputFiles', { files: [...files], nodeId })
}

/** 读页面可见文本（用于成功/失败判定）。 */
export async function readBodyText(page: DomPage): Promise<string> {
  try {
    const text = await page.evaluate<unknown>('document.body ? document.body.innerText : ""')
    return typeof text === 'string' ? text : ''
  } catch (error) {
    throw toDomError(error, '读取页面文本失败')
  }
}

/** 当前 URL（hash 路由也包含在内）。 */
export async function readLocationHref(page: DomPage): Promise<string> {
  const href = await page.evaluate<unknown>('location.href')
  return typeof href === 'string' ? href : ''
}

/** 等元素出现（超时抛 NETWORK，消息里带选择器）。 */
export async function waitForElement(page: DomPage, selector: string, opts: DomWaitOptions & { label?: string } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  await page.waitFor('!!document.querySelector(' + jsQuote(selector) + ')', {
    timeoutMs,
    intervalMs: opts.intervalMs ?? DEFAULT_POLL_MS,
    label: opts.label ?? ('元素出现：' + selector),
  })
}

/** 等页面里出现某段文字。 */
export async function waitForText(page: DomPage, text: string, opts: DomWaitOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  await page.waitFor('document.body && document.body.innerText.indexOf(' + jsQuote(text) + ') >= 0', {
    timeoutMs,
    intervalMs: opts.intervalMs ?? DEFAULT_POLL_MS,
    label: '页面出现文字：' + text,
  })
}

/** 等满足某条件的元素数量达到下限（例如上传预览图张数）。 */
export async function waitForCount(
  page: DomPage,
  selector: string,
  minimum: number,
  opts: DomWaitOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  await page.waitFor(
    'document.querySelectorAll(' + jsQuote(selector) + ').length >= ' + String(minimum),
    {
      timeoutMs,
      intervalMs: opts.intervalMs ?? DEFAULT_POLL_MS,
      label: '元素数量 ' + selector + ' >= ' + String(minimum),
    },
  )
}

/** 读一组选择器匹配到的元素文本（顺序同 DOM）。用来从候选列表里挑正确的一条。 */
export async function readSelectorTexts(page: DomPage, selector: string): Promise<string[]> {
  const script = [
    '(function () {',
    '  const nodes = Array.from(document.querySelectorAll(' + jsQuote(selector) + '));',
    '  return nodes.map((el) => (el.textContent || "").replace(/\\s+/g, " ").trim());',
    '})()',
  ].join('\n')
  const value = await page.evaluate<unknown>(script)
  if (!Array.isArray(value)) return []
  return value.map((item) => (typeof item === 'string' ? item : ''))
}

/** 点第 index 个匹配元素（候选列表按文本命中后精确点那一条，不盲点第一个）。 */
export async function clickSelectorAt(page: DomPage, selector: string, index: number, label?: string): Promise<void> {
  const script = [
    '(function () {',
    '  const nodes = Array.from(document.querySelectorAll(' + jsQuote(selector) + '));',
    '  if (nodes.length <= ' + String(index) + ') return ' + jsQuote(MISSING) + ';',
    '  nodes[' + String(index) + '].scrollIntoView({ block: "center", inline: "center" });',
    '  nodes[' + String(index) + '].click();',
    '  return ' + jsQuote(DONE) + ';',
    '})()',
  ].join('\n')
  const result = await page.evaluate<unknown>(script).catch((error: unknown) => {
    throw toDomError(error, '点击失败：' + (label ?? selector))
  })
  if (result !== DONE) throw new XianyuError({ code: 'VALIDATION', message: '没找到要点击的元素：' + (label ?? selector) })
}

function toDomError(error: unknown, fallback: string): XianyuError {
  if (error instanceof XianyuError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new XianyuError({ code: 'INTERNAL', message: fallback + '：' + message })
}
