import test from 'node:test'
import assert from 'node:assert/strict'
import { setFileInputFiles } from '../src/dom.ts'
import type { DomPage } from '../src/dom.ts'
import { assertValidDraft, createPublishSteps, extractItemId, priceToYuanText, publishItem } from '../src/publish.ts'
import type { PublishDraft, PublishSelectors } from '../src/publish.ts'
import type { WaitForOptions } from '../src/page.ts'
import type { CdpPage } from '../src/page.ts'
import type { PublishContext } from '../src/steps.ts'

/**
 * 假页面：不跑真 CDP，只按表达式里的选择器/文字返回脚本化结果。
 * 表达式由 dom.ts 生成，形态稳定（querySelector / querySelectorAll / click / setter.set）。
 */
class FakePage implements DomPage {
  readonly selectors = new Set<string>()
  readonly texts = new Set<string>()
  readonly counts: Record<string, number> = {}
  readonly clicked: string[] = []
  readonly navigated: string[] = []
  readonly screenshots: string[] = []
  readonly commands: { method: string; params: Record<string, unknown> }[] = []
  href = 'https://www.goofish.com/publish'
  bodyText = ''
  fileInputs: number[] = [7]
  /** 点提交后跳转到的 URL；空串表示提交失败（停在发布页）。 */
  submitHref = ''
  /** 哪些选择器算提交按钮（改选择器时同步改这里）。 */
  submitClickIncludes = ['publish-button']
  /** Input.insertText 打进去的文本（typeInto 用）。 */
  typed = ''
  /** typeInto 回读时返回的输入框值。 */
  readbackValue = ''
  /** antd 表单项当前显示的文本（readFormFieldText 用，键是 label）。 */
  formFields: Record<string, string> = { 分类: '其他服务', 宝贝所在地: '请选择地址' }
  /** 点地址候选后是否把地点写回表单项（假页面用它模拟「没写回」的异常分支）。 */
  addressWritesBack = true
  /** 地址候选文本（readSelectorTexts 用）。 */
  optionTexts: Record<string, string[]> = {}

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const quoted = extractQuoted(expression)
    const selector = quoted[0] ?? ''
    if (expression.includes('location.href')) return this.href as T
    // readSelectorTexts：候选文本列表。
    if (expression.includes('nodes.map')) {
      const list = this.optionTexts[selector] ?? (this.selectors.has(selector) ? ['广州大学城'] : [])
      return list as T
    }
    // clickSelectorAt：点候选列表里的第 N 条。
    if (expression.includes('nodes.length <=')) {
      this.clicked.push(selector)
      if (selector.includes('addressItem--') && this.addressWritesBack) {
        this.formFields['宝贝所在地'] = this.typed || '广东省广州市'
      }
      return 'ok' as T
    }
    // readFormFieldText 脚本：按 label 返回表单项当前文本。
    if (expression.includes('.ant-form-item')) {
      const matched = /const want = "([^"]*)"/.exec(expression)
      return (this.formFields[matched?.[1] ?? ''] ?? '') as T
    }
    // typeInto 的聚焦脚本（内部也含 el.value === undefined，必须在回读分支之前判）
    if (expression.includes('selectNodeContents') || expression.includes('setSelectionRange')) return 'ok' as T
    if (expression.includes('el.value === undefined')) return this.readbackValue as T
    if (expression.includes('innerText')) return this.bodyText as T
    if (expression.includes('const want')) {
      return (this.texts.has(selector) ? 'ok' : 'missing') as T
    }
    if (expression.includes('setter.set')) {
      const count = this.counts[selector] ?? (this.selectors.has(selector) ? 1 : 0)
      return (count > 0 ? 'ok' : 'missing') as T
    }
    if (expression.includes('querySelectorAll(') && expression.includes(').length')) {
      return (this.counts[selector] ?? 0) as T
    }
    if (expression.includes('querySelectorAll(')) {
      return ((this.counts[selector] ?? 0) > 0 ? 'ok' : 'missing') as T
    }
    // 发布页真机是富文本，但假页面默认按普通输入框回放（需要富文本的用例自己起 RichPage）。
    if (expression.includes('isContentEditable')) return false as T
    if (expression.includes('.click()')) {
      this.clicked.push(selector)
      // 点地址候选后闲鱼会把地点写回「宝贝所在地」表单项。
      if (selector.includes('addressItem--') && this.addressWritesBack) {
        this.formFields['宝贝所在地'] = this.typed || '广东省广州市'
      }
      const isSubmit = this.submitClickIncludes.some((marker) => selector.includes(marker))
      if (isSubmit && this.submitHref !== '') this.href = this.submitHref
      return (this.selectors.has(selector) ? 'ok' : 'missing') as T
    }
    return (this.selectors.has(selector) ? true : false) as T
  }

  async waitFor(expression: string, opts: WaitForOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 500
    const deadline = Date.now() + Math.min(timeoutMs, 500)
    while (Date.now() < deadline) {
      if (await this.matches(expression)) return
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('等待超时：' + expression)
  }

  async command<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ method, params })
    if (method === 'Input.insertText') {
      this.typed = String(params.text ?? '')
      this.readbackValue = this.typed
      return {} as T
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } } as T
    if (method === 'DOM.querySelectorAll') return { nodeIds: this.fileInputs } as T
    return {} as T
  }

  async navigate(url: string): Promise<void> {
    this.navigated.push(url)
    this.href = url
  }

  async screenshot(path: string): Promise<void> {
    this.screenshots.push(path)
  }

  private async matches(expression: string): Promise<boolean> {
    const quoted = extractQuoted(expression)
    if (expression.includes('!!document.querySelector(')) return this.selectors.has(quoted[0] ?? '')
    if (expression.includes('.innerText.indexOf(')) return this.bodyText.includes(quoted[0] ?? '')
    if (expression.includes('.length >=')) {
      const minimum = Number(/length >= (\d+)/.exec(expression)?.[1] ?? '0')
      return (this.counts[quoted[0] ?? ''] ?? 0) >= minimum
    }
    return false
  }
}

function extractQuoted(expression: string): string[] {
  const matches = expression.match(/"(?:[^"\\]|\\.)*"/g) ?? []
  return matches.map((raw) => {
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : raw
    } catch {
      return raw
    }
  })
}

function makeCtx(): PublishContext {
  return { log: () => {}, now: () => 1_700_000_000_000 }
}

function asPage(page: FakePage): CdpPage {
  return page as unknown as CdpPage
}

const DRAFT: PublishDraft = {
  title: '九成新机械键盘',
  desc: '自用一年，青轴，无拆修，顺丰包邮。',
  priceCents: 9_900,
  images: ['D:\\Github\\big fish\\.scratch\\demo-1.jpg'],
}

function readyPage(overrides: Partial<FakePage> = {}): FakePage {
  const page = new FakePage()
  page.selectors.add('div[contenteditable="true"], textarea[placeholder*="描述"], textarea')
  page.selectors.add('input[type=file]')
  page.selectors.add('button[class*="publish-button"]')
  page.selectors.add('input[placeholder="0.00"]')
  page.counts['div[class*="preview-container"]'] = 3
  page.counts['input[placeholder="0.00"]'] = 3
  page.texts.add('包邮')
  // 真发布前会预检「分类」「宝贝所在地」是否有值（页面上这两项由系统预填）。
  page.texts.add('分类')
  page.texts.add('宝贝所在地')
  Object.assign(page, overrides)
  return page
}

test('priceToYuanText：整数分转元文本，不做浮点运算', () => {
  assert.equal(priceToYuanText(9_900), '99')
  assert.equal(priceToYuanText(9_990), '99.9')
  assert.equal(priceToYuanText(12_34), '12.34')
  assert.equal(priceToYuanText(1), '0.01')
  assert.equal(priceToYuanText(0), '0')
})

test('priceToYuanText：非法价格是 VALIDATION', () => {
  assert.throws(() => priceToYuanText(-1), /整数分/)
  assert.throws(() => priceToYuanText(1.5), /整数分/)
})

test('extractItemId：从商品 URL 取 id，发布页取不到', () => {
  assert.equal(extractItemId('https://www.goofish.com/item?id=812345678901'), '812345678901')
  assert.equal(extractItemId('https://www.goofish.com/item/123456789'), '123456789')
  assert.equal(extractItemId('https://www.goofish.com/publish'), undefined)
})

test('assertValidDraft：空描述/零价/无图/相对路径都拒绝', () => {
  assert.throws(() => assertValidDraft({ ...DRAFT, title: '', desc: '' }), /标题与描述/)
  assert.throws(() => assertValidDraft({ ...DRAFT, desc: '' }), /描述不能为空/)
  assert.throws(() => assertValidDraft({ ...DRAFT, priceCents: 0 }), /正整数分/)
  assert.throws(() => assertValidDraft({ ...DRAFT, images: [] }), /至少需要一张图片/)
  assert.throws(() => assertValidDraft({ ...DRAFT, images: ['demo.jpg'] }), /绝对路径/)
})

test('createPublishSteps：dryRun 默认不提交，提交步只在 dryRun:false 出现', () => {
  const dry = createPublishSteps(DRAFT).map((step) => step.name)
  assert.deepEqual(dry, ['打开发布页', '上传图片', '填写文案', '填写价格', 'dry-run 收尾'])
  const real = createPublishSteps(DRAFT, { dryRun: false }).map((step) => step.name)
  assert.deepEqual(real, ['打开发布页', '上传图片', '填写文案', '填写价格', '必填项预检', '提交并验证'])
  const full = createPublishSteps(
    { ...DRAFT, pricingMode: '元/次', address: '广州大学城' },
    { dryRun: false },
  ).map((step) => step.name)
  assert.deepEqual(full.filter((name) => name === '选择计价方式' || name === '填写地址'), ['选择计价方式', '填写地址'])
})

test('dry-run 全流程：填完表、不动提交按钮、返回 ok', async () => {
  const page = readyPage()
  const result = await publishItem(asPage(page), DRAFT, makeCtx(), { dryRun: true })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(page.navigated, ['https://www.goofish.com/publish'])
  assert.ok(page.clicked.includes('button[class*="publish-button"]') === false)
  assert.ok(page.commands.some((call) => call.method === 'DOM.setFileInputFiles'))
  const uploaded = page.commands.find((call) => call.method === 'DOM.setFileInputFiles')
  assert.deepEqual(uploaded?.params.files, DRAFT.images)
})

test('上传失败：没有文件输入框也没有「添加首图」→ 停在「上传图片」', async () => {
  const page = readyPage()
  page.selectors.delete('input[type=file]')
  const result = await publishItem(asPage(page), DRAFT, makeCtx(), { dryRun: true })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.step, '上传图片')
  assert.match(result.error, /添加首图/)
  assert.equal(page.clicked.length, 0)
})

test('提交成功：URL 出现 item id 才算成功，并回传 itemId', async () => {
  const page = readyPage({ submitHref: 'https://www.goofish.com/item?id=812345678901' })
  const result = await publishItem(asPage(page), DRAFT, makeCtx(), { dryRun: false, successTimeoutMs: 200 })
  assert.deepEqual(result, { ok: true, itemId: '812345678901' })
})

test('提交后没看到成功标记：按失败处理，报错带页面提示', async () => {
  const page = readyPage({ bodyText: '请选择商品分类\n重新发布' })
  const result = await publishItem(asPage(page), DRAFT, makeCtx(), { dryRun: false, successTimeoutMs: 50 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.step, '提交并验证')
  assert.match(result.error, /没有看到成功标记/)
  assert.match(result.error, /请选择商品分类/)
})

test('提交后页面出现「发布成功」也算成功', async () => {
  const page = readyPage({ bodyText: '发布成功，可在「我的闲鱼」查看' })
  const result = await publishItem(asPage(page), DRAFT, makeCtx(), { dryRun: false, successTimeoutMs: 200 })
  assert.deepEqual(result, { ok: true })
})

test('setFileInputFiles：页面没有 file input 时是 VALIDATION', async () => {
  const page = new FakePage()
  page.fileInputs = []
  await assert.rejects(setFileInputFiles(page, DRAFT.images), /文件输入框/)
})

test('selectors 可覆盖：自定义提交按钮与价格框生效', async () => {
  const page = new FakePage()
  const selectors: Partial<PublishSelectors> = {
    description: 'textarea#desc',
    fileInput: 'input.upload',
    previewImage: 'img.preview',
    priceInput: 'input.price',
    submitButton: 'button#go',
  }
  page.selectors.add('textarea#desc')
  page.selectors.add('input.upload')
  page.selectors.add('button#go')
  page.counts['img.preview'] = 1
  page.counts['input.price'] = 1
  page.texts.add('包邮')
  page.texts.add('分类')
  page.texts.add('宝贝所在地')
  page.submitHref = 'https://www.goofish.com/item/99887766'
  page.submitClickIncludes.push('button#go')
  const result = await publishItem(asPage(page), DRAFT, makeCtx(), { dryRun: false, selectors, successTimeoutMs: 200 })
  assert.deepEqual(result, { ok: true, itemId: '99887766' })
  assert.ok(page.clicked.includes('button#go'))
})

test('填写地址：走真实输入触发联想，点候选后回读地址', async () => {
  const page = readyPage()
  page.selectors.add('div[class*="addressWrap--"]')
  page.selectors.add('input[placeholder*="搜索地点"]')
  page.selectors.add('div[class*="addressItem--"]')
  const result = await publishItem(asPage(page), { ...DRAFT, address: '广州大学城' }, makeCtx(), { dryRun: true })
  assert.deepEqual(result, { ok: true })
  assert.ok(page.commands.some((call) => call.method === 'Input.insertText'))
  assert.equal(page.typed, '广州大学城')
})

test('填写地址：点了候选但地址没写回表单 → 停在「填写地址」', async () => {
  const page = readyPage()
  page.selectors.add('div[class*="addressWrap--"]')
  page.selectors.add('input[placeholder*="搜索地点"]')
  page.selectors.add('div[class*="addressItem--"]')
  page.addressWritesBack = false
  page.formFields['宝贝所在地'] = '请选择地址'
  const result = await publishItem(asPage(page), { ...DRAFT, address: '广州大学城' }, makeCtx(), { dryRun: true, timeoutMs: 60 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.step, '填写地址')
  assert.match(result.error, /地址没写回表单/)
})

