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

const TRIGGER_POINT = { x: 400, y: 300 }
const OPTION_POINT = { x: 420, y: 360 }

/**
 * 假分类下拉：用脚本标记（bf-category-*）区分不同表达式，模拟 antd Select 的坐标点击行为。
 *
 * 它同时扮演「页面契约的守卫」：
 * - 选项/候选查询必须带 `ant-select-dropdown-hidden`（否则会把已关闭/别的 Select 的选项扫进来）；
 * - 选项查询必须带 `ant-select-open`（下拉没打开时不能给坐标）；
 * - 取选项坐标的脚本不允许出现 `scrollIntoView(`（真机上滚页面会让 antd 重排下拉，点击落空）。
 * 这些断言让「实现退回到旧写法」时单测直接失败，而不是只靠真机才暴露。
 */
class FakeSelectPage implements DomPage {
  readonly commands: { method: string; params: Record<string, unknown> }[] = []
  readonly screenshots: string[] = []
  /** 下拉当前选中的值。 */
  value = ''
  /** 当前打开的下拉里的候选文本。 */
  visibleOptions: string[] = ['电子资料', '学习笔记', '教材教辅']
  /** 已关闭/别的 Select 的旧下拉里的候选（旧实现会误扫到它们）。 */
  hiddenOptions: string[] = []
  bodyText = ''
  /** 触发器是否可见（false 模拟页面结构变化）。 */
  triggerVisible = true
  /** 触发器是否在视口内（false 时应先滚动再点）。 */
  triggerInViewport = true
  /** 可信点击触发器能否打开下拉（false 模拟 antd 没响应）。 */
  opensOnClick = true
  dropdownOpen = false
  /** 每次点击选项后回读到的值（按顺序消费；用于模拟「先点错、再点对」）。 */
  clickValues: string[] = []
  /** 固定回读值（不消费序列；模拟「点了但值没变」）。 */
  valueAfterClick: string | undefined
  scrollCalls = 0
  /** 下拉内部 holder 被滚动的次数（候选在可视区外时应先滚它，而不是滚页面）。 */
  revealCalls = 0
  /** 存在但没有可用坐标的候选（模拟 rc-virtual-list 可视区外的末几项）。 */
  offScreenOptions: string[] = []
  /** 每次打开下拉时替换的候选组（模拟 AI 推荐随文案刷新；用完保持最后一组）。 */
  optionsByOpen: string[][] = []
  /** 下拉没打开时按到选项坐标的次数（应为 0：宁可不点也不能乱点）。 */
  strayOptionClicks = 0
  private pendingPick = ''
  private openCount = 0

  async evaluate<T = unknown>(expression: string): Promise<T> {
    if (expression.includes('innerText')) return this.bodyText as T
    if (expression.includes('bf-category-select-state')) {
      if (!this.triggerVisible) return '' as T
      return JSON.stringify({
        x: TRIGGER_POINT.x,
        y: TRIGGER_POINT.y,
        inViewport: this.triggerInViewport,
        open: this.dropdownOpen,
      }) as T
    }
    if (expression.includes('bf-category-value')) return this.value as T
    if (expression.includes('bf-category-scroll')) {
      this.scrollCalls += 1
      this.triggerInViewport = true
      return 'ok' as T
    }
    if (expression.includes('bf-category-option-texts')) {
      assert.ok(expression.includes('ant-select-dropdown-hidden'), '候选查询必须排除已关闭的下拉')
      return (this.dropdownOpen ? [...this.visibleOptions] : []) as T
    }
    if (expression.includes('bf-category-reveal')) {
      const matched = /optionText\(el\) === "([^"]*)"/.exec(expression)
      const want = matched?.[1] ?? ''
      assert.ok(expression.includes('scrollTop'), '滚选项必须只改下拉内部 holder 的 scrollTop')
      assert.equal(expression.includes('scrollIntoView('), false, '滚选项不能滚动页面（会重排下拉）')
      if (!this.dropdownOpen) return 'not-open' as T
      if (!this.visibleOptions.includes(want)) return 'no-option' as T
      this.revealCalls += 1
      this.offScreenOptions = this.offScreenOptions.filter((text) => text !== want)
      return 'ok' as T
    }
    if (expression.includes('bf-category-option-rect')) {
      const matched = /optionText\(el\) === "([^"]*)"/.exec(expression)
      const want = matched?.[1] ?? ''
      assert.ok(expression.includes('ant-select-dropdown-hidden'), '选项查询必须排除已关闭的下拉')
      assert.ok(expression.includes('ant-select-open'), '选项查询必须先确认下拉已打开')
      assert.equal(expression.includes('scrollIntoView('), false, '取选项坐标不能滚动页面（会重排下拉）')
      if (!this.dropdownOpen) return JSON.stringify({ miss: 'not-open', options: [] }) as T
      // 隐藏下拉里同名选项不算数：它不在当前打开的列表里，所以只能拿可见候选去比对
      const options = [...this.visibleOptions]
      if (!this.visibleOptions.includes(want)) {
        return JSON.stringify({ miss: 'no-option', options }) as T
      }
      if (this.offScreenOptions.includes(want)) {
        return JSON.stringify({ miss: 'off-screen', options }) as T
      }
      this.pendingPick = want
      return JSON.stringify({ x: OPTION_POINT.x, y: OPTION_POINT.y }) as T
    }
    throw new Error('未预期的页面脚本：' + expression.slice(0, 80))
  }

  async waitFor(): Promise<void> {
    throw new Error('分类步骤不应调用 waitFor')
  }

  async command<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ method, params })
    if (method === 'Input.dispatchKeyEvent') {
      // antd Select 收到 Escape 会收起下拉
      if (params['type'] === 'keyDown' && params['key'] === 'Escape') this.dropdownOpen = false
      return {} as T
    }
    if (method !== 'Input.dispatchMouseEvent') return {} as T
    const point = { x: Number(params['x'] ?? 0), y: Number(params['y'] ?? 0) }
    const at = (target: { x: number; y: number }): boolean => target.x === point.x && target.y === point.y
    if (params['type'] !== 'mousePressed') return {} as T
    if (at(TRIGGER_POINT)) {
      if (this.opensOnClick) {
        this.dropdownOpen = true
        this.openCount += 1
        if (this.optionsByOpen.length > 0) {
          const index = Math.min(this.openCount - 1, this.optionsByOpen.length - 1)
          this.visibleOptions = [...(this.optionsByOpen[index] ?? this.visibleOptions)]
        }
      }
      return {} as T
    }
    if (!at(OPTION_POINT)) return {} as T
    if (!this.dropdownOpen) {
      this.strayOptionClicks += 1
      return {} as T
    }
    // antd Select 选中后关闭下拉
    this.dropdownOpen = false
    this.value = this.clickValues.shift() ?? this.valueAfterClick ?? this.pendingPick
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

function pressCount(page: FakeSelectPage, point: { x: number; y: number }): number {
  return page.commands.filter(
    (entry) =>
      entry.method === 'Input.dispatchMouseEvent' &&
      entry.params['type'] === 'mousePressed' &&
      entry.params['x'] === point.x &&
      entry.params['y'] === point.y,
  ).length
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

test('readCategoryOptionTexts 只返回当前打开下拉的候选；关闭时为空', async () => {
  const page = new FakeSelectPage()
  page.hiddenOptions = ['已关闭下拉里的旧选项']
  assert.deepEqual(await readCategoryOptionTexts(page), [])
  page.dropdownOpen = true
  assert.deepEqual(await readCategoryOptionTexts(page), ['电子资料', '学习笔记', '教材教辅'])
})

test('stepSelectCategory 打开下拉、点选目标类目、回读校验并截图', async () => {
  const page = new FakeSelectPage()
  page.value = '教材教辅'
  const logs: string[] = []
  await stepSelectCategory(page, makeCtx(logs), '电子资料', { timeoutMs: 200, screenshotsDir: 'D:/shots' })
  assert.equal(page.value, '电子资料')
  assert.equal(page.dropdownOpen, false)
  assert.deepEqual(page.screenshots, ['D:/shots/04b-category.png'])
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /AI 识别为「教材教辅」→ 选为「电子资料」/)
})

test('stepSelectCategory：下拉没打开时先打开，再点选项', async () => {
  const page = new FakeSelectPage()
  page.value = '教材教辅'
  assert.equal(page.dropdownOpen, false)
  await stepSelectCategory(page, makeCtx([]), '电子资料', { timeoutMs: 400 })
  const pressTypes = page.commands
    .filter((entry) => entry.method === 'Input.dispatchMouseEvent' && entry.params['type'] === 'mousePressed')
    .map((entry) => ({ x: entry.params['x'], y: entry.params['y'] }))
  assert.deepEqual(pressTypes[0], TRIGGER_POINT)
  assert.deepEqual(pressTypes[1], OPTION_POINT)
  assert.equal(page.value, '电子资料')
  assert.equal(page.strayOptionClicks, 0)
})

test('stepSelectCategory：触发器不在视口内时先滚到可见处再打开', async () => {
  const page = new FakeSelectPage()
  page.value = '教材教辅'
  page.triggerInViewport = false
  await stepSelectCategory(page, makeCtx([]), '电子资料', { timeoutMs: 400 })
  assert.equal(page.scrollCalls, 1)
  assert.equal(page.value, '电子资料')
})

test('stepSelectCategory：隐藏 dropdown 里的同名选项不得被选中', async () => {
  const page = new FakeSelectPage()
  page.visibleOptions = ['电子资料', '教材教辅']
  page.hiddenOptions = ['学习笔记']
  await assert.rejects(
    () => stepSelectCategory(page, makeCtx([]), '学习笔记', { timeoutMs: 120 }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string }
      assert.equal(err.code, 'VALIDATION')
      assert.match(err.message ?? '', /没有「学习笔记」这个选项/)
      assert.match(err.message ?? '', /电子资料、教材教辅/)
      return true
    },
  )
  assert.equal(page.value, '')
  assert.equal(page.strayOptionClicks, 0)
  assert.equal(pressCount(page, OPTION_POINT), 0)
})

test('stepSelectCategory：点空了回读不一致时会重开下拉重选，第二次成功', async () => {
  const page = new FakeSelectPage()
  page.value = '电子资料'
  // 第一次点击落空（值仍是 AI 识别出来的「学习笔记」），第二次才点中目标
  page.clickValues = ['学习笔记', '电子资料']
  const logs: string[] = []
  await stepSelectCategory(page, makeCtx(logs), '电子资料', { timeoutMs: 800 })
  assert.equal(page.value, '电子资料')
  assert.equal(pressCount(page, TRIGGER_POINT) >= 2, true)
  assert.equal(logs.length, 1)
})

test('stepSelectCategory：重试耗尽仍回读不一致时 fail-closed', async () => {
  const page = new FakeSelectPage()
  page.value = '电子资料'
  page.valueAfterClick = '学习笔记'
  await assert.rejects(
    () => stepSelectCategory(page, makeCtx([]), '电子资料', { timeoutMs: 200 }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string }
      assert.equal(err.code, 'VALIDATION')
      assert.match(err.message ?? '', /下拉显示的是「学习笔记」/)
      return true
    },
  )
})

test('stepSelectCategory：下拉点不开时拒绝继续，也不乱点候选', async () => {
  const page = new FakeSelectPage()
  page.opensOnClick = false
  await assert.rejects(
    () => stepSelectCategory(page, makeCtx([]), '电子资料', { timeoutMs: 150 }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string }
      assert.equal(err.code, 'VALIDATION')
      assert.match(err.message ?? '', /下拉没有打开/)
      return true
    },
  )
  assert.equal(page.strayOptionClicks, 0)
  assert.equal(pressCount(page, OPTION_POINT), 0)
})

test('stepSelectCategory：下拉里没有目标类目时报出候选列表', async () => {
  const page = new FakeSelectPage()
  page.visibleOptions = ['教材教辅', '文学']
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

test('stepSelectCategory：选项在可视区外时先滚下拉内部 holder 再点', async () => {
  const page = new FakeSelectPage()
  page.value = '教材教辅'
  page.visibleOptions = ['电子资料', '学习笔记', '其他闲置']
  page.offScreenOptions = ['其他闲置']
  await stepSelectCategory(page, makeCtx([]), '其他闲置', { timeoutMs: 800 })
  assert.equal(page.value, '其他闲置')
  assert.equal(page.revealCalls, 1)
  assert.equal(page.scrollCalls, 0, '不应滚主页面')
})

test('stepSelectCategory：候选是异步推荐，刷新后出现目标类目则选中', async () => {
  const page = new FakeSelectPage()
  page.value = '教材教辅'
  page.optionsByOpen = [['教材教辅', '文学/小说'], ['电子资料', '学习笔记', '教材教辅']]
  const logs: string[] = []
  await stepSelectCategory(page, makeCtx(logs), '学习笔记', { timeoutMs: 5_000 })
  assert.equal(page.value, '学习笔记')
  assert.equal(pressCount(page, TRIGGER_POINT) >= 2, true, '应关掉下拉重开以拿到新候选')
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
