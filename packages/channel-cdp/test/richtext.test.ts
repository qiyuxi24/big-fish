import test from 'node:test'
import assert from 'node:assert/strict'
import { fillRichText, fillText } from '../src/dom.ts'
import type { DomPage } from '../src/dom.ts'
import type { WaitForOptions } from '../src/page.ts'

/** 只回放 fillText/fillRichText 用到的表达式；其余一律 false。 */
class RichPage implements DomPage {
  readonly events: string[] = []
  /** 聚焦脚本的返回值：ok / missing / not-editable。 */
  focusResult = 'ok'
  /** 回读到的编辑器文本。 */
  readback = ''
  editable = true

  async evaluate<T = unknown>(expression: string): Promise<T> {
    if (expression.includes('selectNodeContents')) return this.focusResult as T
    if (expression.includes('el.innerText || el.textContent')) return this.readback as T
    if (expression.includes('setter.set')) {
      this.events.push('setter')
      return 'ok' as T
    }
    if (expression.includes('isContentEditable')) return this.editable as T
    return false as T
  }

  async waitFor(_expression: string, _opts?: WaitForOptions): Promise<void> {
    return undefined
  }

  async command<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'Input.insertText') {
      this.events.push('insert:' + String(params.text))
      return {} as T
    }
    if (method === 'Input.dispatchKeyEvent') {
      // keyDown 不带 text 时 Chrome 不插入换行，这里把两种形态区分开记，防止回退。
      if (params.type === 'keyDown') this.events.push(params.text === '\r' ? 'enter' : 'enter-no-text')
      return {} as T
    }
    return {} as T
  }
}

test('fillText：contenteditable 走原生输入，不碰 textContent', async () => {
  const page = new RichPage()
  page.readback = '九成新键盘'
  await fillText(page, '#desc', '九成新键盘', '描述')
  assert.deepEqual(page.events, ['insert:九成新键盘'])
})

test('fillRichText：多行用 Enter 分段，顺序是 行→回车→行', async () => {
  const page = new RichPage()
  page.readback = '第一行\n第二行'
  await fillRichText(page, '#desc', '第一行\n第二行', '描述')
  assert.deepEqual(page.events, ['insert:第一行', 'enter', 'insert:第二行'])
})

test('fillRichText：回读不含写入内容时报 INTERNAL，不静默通过', async () => {
  const page = new RichPage()
  page.readback = ''
  await assert.rejects(fillRichText(page, '#desc', '要写的内容', '描述'), /回读不一致/)
})

test('fillRichText：多行时回读没有换行算失败（标题与描述粘成一行）', async () => {
  const page = new RichPage()
  // 模拟编辑器吞掉回车：两段文字都在，但粘在同一行。
  page.readback = '标题描述'
  await assert.rejects(fillRichText(page, '#desc', '标题\n描述', '描述'), /换行未生效/)
})

test('fillRichText：元素不存在是 VALIDATION，不是可编辑元素是 UNSUPPORTED', async () => {
  const missing = new RichPage()
  missing.focusResult = 'missing'
  await assert.rejects(fillRichText(missing, '#desc', 'x'), /没找到富文本编辑器/)
  const notEditable = new RichPage()
  notEditable.focusResult = 'not-editable'
  await assert.rejects(fillRichText(notEditable, '#desc', 'x'), /不是可编辑富文本/)
})

test('fillText：非 contenteditable 退化成原生 setter 填值', async () => {
  const page = new RichPage()
  page.editable = false
  await fillText(page, 'input.price', '99', '售价')
  assert.deepEqual(page.events, ['setter'])
})
