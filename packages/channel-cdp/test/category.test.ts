import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertCategoryPublishable,
  CATEGORY_UNSUPPORTED_TEXT,
  readCategoryOptionTexts,
  readCategoryValue,
  stepSelectCategory,
  trustedClickAt,
} from '../src/category.ts'
import { createPublishSteps } from '../src/publish.ts'
import type { PublishDraft } from '../src/publish.ts'
import type { DomPage } from '../src/dom.ts'
import type { PublishContext } from '../src/steps.ts'

const OPEN_POINT = { x: 400, y: 300 }
const OPTION_POINT = { x: 420, y: 360 }

/**
 * 假分类下拉：用脚本标记（bf-category-*）区分不同表达式，模拟 antd Select 的坐标点击行为。
 * - 只有「可信鼠标事件」按在触发器坐标上，才算打开下拉；
 * - 按在选项坐标上时把下拉值改成被点的候选（模拟 antd 的受控回写）。
 */
class FakeSelectPage implements DomPage {
  readonly commands: { method: string; params: Record<string, unknown> }[] = []
  readonly screenshots: string[] = []
  /** 下拉当前选中的值。 */
  value = ''
  /** 下拉里可选候选文本。 */
  optionTexts: string[] = ['电子资料', '学习笔记', '教材教辅']
  bodyText = ''
  /** 触发器是否可见（false 模拟页面结构变化）。 */
  triggerVisible = true
  /** 点了选项后回读到的值（默认等于被点候选；改成别的值可测「点了但没生效」）。 */
  valueAfterClick: string | undefined
  dropdownOpen = false
  private pendingPick = ''
  private lastMove = { x: 0, y: 0 }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    if (expression.includes('innerText')) return this.bodyText as T
    if (expression.includes('bf-category-select-rect')) {
      return (this.triggerVisible ? JSON.stringify(OPEN_POINT) : '') as T
    }
    if (expression.includes('bf-category-value')) return this.value as T
    if (expression.includes('bf-category-option-texts')) return [...this.optionTexts] as T
    if (expression.includes('bf-category-option-rect')) {
      const matched = /const want = "([^"]*)"/.exec(expression)
      const want = matched?.[1] ?? ''
      if (!this.optionTexts.includes(want)) return '' as T
      this.pendingPick = want
      return JSON.stringify(OPTION_POINT) as T
    }
    throw new Error('未预期的页面脚本：' + expression.slice(0, 80))
  }

  async waitFor(): Promise<void> {
    throw new Error('分类步骤不应调用 waitFor')
  }

  async command<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ method, params })
    const point = { x: Number(params['x'] ?? 0), y: Number(params['y'] ?? 0) }
    if (method !== 'Input.dispatchMouseEvent') return {} as T
    if (params['type'] === 'mouseMoved') {
      this.lastMove = point
      return {} as T
    }
    if (params['type'] !== 'mousePressed') return {} as T
    const same = (a: { x: number; y: number }): boolean => a.x === this.lastMove.x && a.y === this.lastMove.y
    if (same(OPEN_POINT)) {
      this.dropdownOpen = true
      return {} as T
    }
    if (this.dropdownOpen && same(OPTION_POINT)) {
      this.value = this.valueAfterClick ?? this.pendingPick
    }
    return {} as T
  }

  async screenshot(path: string): Promise<void> {
    this.screenshots.push(path)
  }
}

function makeCtx(logs: string[]): PublishContext {
  return { log: (_step: string, message: string): void => { logs.push(message) }, now: () => 0 }
}

function baseDraft(overrides: Partial<PublishDraft> = {}): PublishDraft {
  return {
    title: '学习资料电子笔记',
    desc: '整理好的电子版资料',
    priceCents: 100,
    images: ['D:/tmp/a.png'],
    ...overrides,
  }
}

test('trustedClickAt 依次派发 move/press/release 三个可信鼠标事件', async () => {
  const page = new FakeSelectPage()
  await trustedClickAt(page, { x: 12, y: 34 })
  assert.deepEqual(page.commands.map((entry) => entry.method), [
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
  ])
  assert.deepEqual(page.commands.map((entry) => entry.params['type']), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  assert.deepEqual(page.commands.map((entry) => entry.params['x']), [12, 12, 12])
  assert.deepEqual(page.commands.map((entry) => entry.params['button']), ['none', 'left', 'left'])
})

test('readCategoryValue 读当前选中文本；未选中返回空串', async () => {
  const page = new FakeSelectPage()
  assert.equal(await readCategoryValue(page), '')
  page.value = '电子资料'
  assert.equal(await readCategoryValue(page), '电子资料')
})

test('readCategoryOptionTexts 返回候选文本；页面返回非数组时按空处理', async () => {
  const page = new FakeSelectPage()
  assert.deepEqual(await readCategoryOptionTexts(page), ['电子资料', '学习笔记', '教材教辅'])
  page.optionTexts = []
  assert.deepEqual(await readCategoryOptionTexts(page), [])
})

test('stepSelectCategory 打开下拉、点选目标类目、回读校验并截图', async () => {
  const page = new FakeSelectPage()
  page.value = '教材教辅'
  const logs: string[] = []
  await stepSelectCategory(page, makeCtx(logs), '电子资料', { timeoutMs: 200, screenshotsDir: 'D:/shots' })
  assert.equal(page.value, '电子资料')
  assert.equal(page.dropdownOpen, true)
  assert.deepEqual(page.screenshots, ['D:/shots/04b-category.png'])
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /AI 识别为「教材教辅」→ 选为「电子资料」/)
})

test('stepSelectCategory：页面提示网页端不支持该类目时 fail-closed', async () => {
  const page = new FakeSelectPage()
  page.bodyText = '分类 ' + CATEGORY_UNSUPPORTED_TEXT + '，请使用闲鱼APP扫码继续发布 点击展示二维码'
  const logs: string[] = []
  await assert.rejects(
    () => stepSelectCategory(page, makeCtx(logs), '电子资料', { timeoutMs: 200 }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string }
      assert.equal(err.code, 'VALIDATION')
      assert.match(err.message ?? '', /网页版不支持发布/)
      assert.match(err.message ?? '', /换一个网页端支持的类目/)
      return true
    },
  )
  assert.deepEqual(logs, [])
})

test('stepSelectCategory：下拉里没有目标类目时报出候选列表', async () => {
  const page = new FakeSelectPage()
  page.optionTexts = ['教材教辅', '文学']
  await assert.rejects(
    () => stepSelectCategory(page, makeCtx([]), '电子资料', { timeoutMs: 120 }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string }
      assert.equal(err.code, 'VALIDATION')
      assert.match(err.message ?? '', /没有「电子资料」这个选项/)
      assert.match(err.message ?? '', /教材教辅、文学/)
      return true
    },
  )
})

test('stepSelectCategory：触发器找不到时给出结构变化提示', async () => {
  const page = new FakeSelectPage()
  page.triggerVisible = false
  await assert.rejects(
    () => stepSelectCategory(page, makeCtx([]), '电子资料', { timeoutMs: 120 }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string }
      assert.equal(err.code, 'VALIDATION')
      assert.match(err.message ?? '', /找不到「分类」下拉/)
      return true
    },
  )
})

test('stepSelectCategory：点了选项但回读不一致时拒绝继续', async () => {
  const page = new FakeSelectPage()
  page.valueAfterClick = '学习笔记'
  await assert.rejects(
    () => stepSelectCategory(page, makeCtx([]), '电子资料', { timeoutMs: 120 }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string }
      assert.equal(err.code, 'VALIDATION')
      assert.match(err.message ?? '', /下拉显示的是「学习笔记」/)
      return true
    },
  )
})

test('assertCategoryPublishable：命中提示才抛，正常页面放行', async () => {
  const ok = new FakeSelectPage()
  await assertCategoryPublishable(ok, '电子资料')
  const bad = new FakeSelectPage()
  bad.bodyText = CATEGORY_UNSUPPORTED_TEXT
  await assert.rejects(() => assertCategoryPublishable(bad, '教材教辅'), /网页版不支持发布/)
})

test('createPublishSteps：草稿带 category 时插入「选择分类」，顺序在「填写文案」之后', () => {
  const names = createPublishSteps(baseDraft({ category: '电子资料' }), { dryRun: true }).map((step) => step.name)
  assert.deepEqual(names, ['打开发布页', '上传图片', '填写文案', '选择分类', '填写价格', 'dry-run 收尾'])
})

test('createPublishSteps：草稿不带 category 时不插入分类步骤（沿用页面识别）', () => {
  const names = createPublishSteps(baseDraft(), { dryRun: true }).map((step) => step.name)
  assert.equal(names.includes('选择分类'), false)
})
