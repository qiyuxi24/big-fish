/**
 * 读 Ant Design 表单项当前显示的值（闲鱼发布页是 antd 表单）。
 *
 * 表单项本身的 class 是 CSS Modules hash（只有 ant-form-item 稳定），所以按「label 文本前缀」
 * 定位表单项，再读它 control 容器的文本：分类、宝贝所在地这类由页面自动预填的字段都靠它判断
 * 是否有值——提交前如果为空，闲鱼会直接拦下，没有必要把请求发出去。
 * @module @bigfish/channel-cdp/form
 */
import type { DomPage } from './dom.ts'

const POLL_MS = 500

/** 读某个表单项当前显示的文本（按 label 前缀定位；找不到或空值返回空串）。 */
export async function readFormFieldText(page: DomPage, label: string): Promise<string> {
  const script = [
    '(function () {',
    '  const want = ' + JSON.stringify(label) + ';',
    '  const items = Array.from(document.querySelectorAll(".ant-form-item"));',
    '  const item = items.find((it) => {',
    '    const label = it.querySelector(".ant-form-item-label label");',
    '    return label !== null && (label.textContent || "").trim().startsWith(want);',
    '  });',
    '  if (!item) return "";',
    '  const content = item.querySelector(".ant-form-item-control-input-content");',
    '  return ((content || item).textContent || "").replace(/\\s+/g, " ").trim();',
    '})()',
  ].join('\n')
  const value = await page.evaluate<unknown>(script)
  return typeof value === 'string' ? value : ''
}

/** 轮询等某个表单项出现非空值；超时返回空串（由调用方决定怎么报错）。 */
export async function waitFormFieldText(page: DomPage, label: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await readFormFieldText(page, label)
    if (last !== '') return last
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS))
  }
  return last
}
