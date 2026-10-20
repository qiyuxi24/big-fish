import test from 'node:test'
import assert from 'node:assert/strict'
import { readFormFieldText, waitFormFieldText } from '../src/form.ts'
import type { DomPage } from '../src/dom.ts'

/** 按 label 返回预置文本的假页面（表达式形态由 form.ts 固定）。 */
class FormPage implements DomPage {
  readonly fields: Record<string, string> = {}
  readonly evaluated: string[] = []

  async evaluate<T = unknown>(expression: string): Promise<T> {
    this.evaluated.push(expression)
    const label = /const want = "([^"]+)"/.exec(expression)?.[1] ?? ''
    return (this.fields[label] ?? '') as T
  }

  async waitFor(): Promise<void> {
    return undefined
  }

  async command<T = unknown>(): Promise<T> {
    return {} as T
  }
}

test('readFormFieldText：按 label 取当前显示值，空值为空串', async () => {
  const page = new FormPage()
  page.fields['分类'] = ' 其他服务 '
  assert.equal(await readFormFieldText(page, '分类'), ' 其他服务 ')
  assert.equal(await readFormFieldText(page, '宝贝所在地'), '')
  assert.equal(page.evaluated.length, 2)
})

test('waitFormFieldText：等到非空值就返回，超时返回空串', async () => {
  const page = new FormPage()
  page.fields['宝贝所在地'] = '星天苑'
  assert.equal(await waitFormFieldText(page, '宝贝所在地', 200), '星天苑')
  assert.equal(await waitFormFieldText(page, '分类', 60), '')
})
