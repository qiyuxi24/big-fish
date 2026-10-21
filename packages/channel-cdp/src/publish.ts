/**
 * 闲鱼网页发布步骤（CDP 表单自动化）：打开发布页 → 传图 → 文案 → 计价 → 价格/包邮/地址 → 提交校验。
 *
 * 默认 dryRun：只填表、截图，绝不点提交。真发布必须显式 { dryRun: false }，
 * 且成功判定只有两条：URL 出现 item id，或页面出现「发布成功」。
 * 提交后没看到这两条一律按失败处理（禁止自动重试：重放可能重复上架，AGENTS §1.2）。
 *
 * 选择器来自逆向事实（research/notes/A-cores.md §上架六步），并已用测试小号在真机校准
 * （Edge 155 + CDP，2026-10-21）：dry-run 全绿，选择器表见 docs/architecture.md §13。
 * 页面改版后按截图重新校准 PublishOptions.selectors。
 * @module @bigfish/channel-cdp/publish
 */
import { XianyuError } from '@bigfish/core'
import {
  clickByText,
  clickSelector,
  countElements,
  elementExists,
  fillFieldAt,
  fillText,
  readBodyText,
  readLocationHref,
  setFileInputFiles,
  typeInto,
  waitForCount,
  waitForElement,
  waitForText,
} from './dom.ts'
import { pickAddressOption } from './address.ts'
import { assertCategoryPublishable, stepSelectCategory } from './category.ts'
import { readFormFieldText, waitFormFieldText } from './form.ts'
import type { DomPage } from './dom.ts'
import type { CdpPage } from './page.ts'
import { runRiskGuardedSteps } from './risk.ts'
import type { PublishContext, PublishRunResult, PublishStep } from './steps.ts'

/** 闲鱼 PC 发布页；发布请求的 Referer 也是它（research/notes/A-cores.md）。 */
export const PUBLISH_URL = 'https://www.goofish.com/publish'

/** 页面锚点。默认值是按逆向事实猜的，真机校准后可通过 options.selectors 覆盖。 */
export interface PublishSelectors {
  /** 描述框；真机是 contenteditable 富文本（textarea 兜底），标题并入描述。 */
  description: string
  /** 独立标题输入框；没有就不填，标题与描述合并写进描述框。 */
  title: string | undefined
  /** 文件输入框。 */
  fileInput: string
  /** 「添加首图」触发文字：页面上没有现成 input 时先点它。 */
  addImageText: string
  /** 上传成功后的预览图计数选择器。 */
  previewImage: string
  /** 价格输入框（0=售价，1=原价，2=运费，都是 placeholder="0.00"）。 */
  priceInput: string
  /** 提交按钮。 */
  submitButton: string
  /** 地址容器（点击后展开地点搜索）。 */
  addressContainer: string
  /** 地点搜索输入框。 */
  addressSearchInput: string
  /** 地点候选条目（真机是 div[class*="addressItem--"]）。 */
  addressOption: string
}

export const DEFAULT_SELECTORS: PublishSelectors = {
  description: 'div[contenteditable="true"], textarea[placeholder*="描述"], textarea',
  title: undefined,
  fileInput: 'input[type=file]',
  addImageText: '添加首图',
  previewImage: 'div[class*="preview-container"]',
  priceInput: 'input[placeholder="0.00"]',
  submitButton: 'button[class*="publish-button"]',
  addressContainer: 'div[class*="addressWrap--"]',
  addressSearchInput: 'input[placeholder*="搜索地点"]',
  addressOption: 'div[class*="addressItem--"]',
}

/** 一次发布的输入（图片是本机绝对路径，由 Chrome 进程读取）。 */
export interface PublishDraft {
  title: string
  desc: string
  /** 售价，整数分。 */
  priceCents: number
  images: string[]
  /** 服务类计价方式（元/次 等）；不传就跳过「请选择计价方式」。 */
  pricingMode?: string
  /** 包邮开关；默认包邮。 */
  shipping?: 'free' | 'none'
  /** 地点文字（如 广州大学城）；不传就不改地址。 */
  address?: string
  /**
   * 目标类目名（如「电子资料」）。不传就沿用页面 AI 识别结果。
   * 网页端只支持部分类目，选到不支持的会立刻失败（见 category.ts）。
   */
  category?: string
}

export interface PublishOptions {
  publishUrl?: string
  /** 默认 true：只填表不提交。 */
  dryRun?: boolean
  /** 传了就每步截图，便于真机校准选择器。 */
  screenshotsDir?: string
  selectors?: Partial<PublishSelectors>
  /** 单步等待超时；默认 20s。 */
  timeoutMs?: number
  /** 提交后等成功标记的时长；默认 20s。 */
  successTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_SUCCESS_TIMEOUT_MS = 20_000
const POLL_MS = 500

/** 整数分 → 输入框里的元文本（不做浮点乘法）。 */
export function priceToYuanText(priceCents: number): string {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
    throw new XianyuError({ code: 'VALIDATION', message: '价格必须是 >=0 的整数分，收到 ' + String(priceCents) })
  }
  const yuan = Math.floor(priceCents / 100)
  const fen = priceCents % 100
  // 末尾的 0 去掉（99.90 → 99.9），输入框里更像人手填的价格。
  const fenText = String(fen).padStart(2, '0').replace(/0$/, '')
  return fen === 0 ? String(yuan) : String(yuan) + '.' + fenText
}

/** 从商品 URL 里取 itemId（没有就返回 undefined，调用方不得据此声称成功以外的东西）。 */
export function extractItemId(url: string): string | undefined {
  const matched = /(?:\/item\b|item\?id=|itemId=)(?:[^0-9]{0,4})(\d{4,})/.exec(url)
  return matched?.[1]
}

/** 校验草稿：缺字段直接 VALIDATION，避免把半成品提交到线上。 */
export function assertValidDraft(draft: PublishDraft): void {
  if (draft.title.trim() === '' && draft.desc.trim() === '') {
    throw new XianyuError({ code: 'VALIDATION', message: '标题与描述不能同时为空' })
  }
  if (draft.desc.trim() === '') {
    throw new XianyuError({ code: 'VALIDATION', message: '描述不能为空（闲鱼网页发布必填）' })
  }
  if (!Number.isSafeInteger(draft.priceCents) || draft.priceCents <= 0) {
    throw new XianyuError({ code: 'VALIDATION', message: '售价必须是正整数分，收到 ' + String(draft.priceCents) })
  }
  if (draft.images.length === 0) {
    throw new XianyuError({ code: 'VALIDATION', message: '至少需要一张图片' })
  }
  for (const image of draft.images) {
    if (!isAbsolutePath(image)) {
      throw new XianyuError({ code: 'VALIDATION', message: '图片必须是本机绝对路径：' + image })
    }
  }
}

/**
 * 生成发布步骤。
 * 顺序与逆向事实一致：传图 → 文案 → 分类计价 → 价格/包邮/地址 → 提交。
 */
export function createPublishSteps(draft: PublishDraft, options: PublishOptions = {}): PublishStep[] {
  assertValidDraft(draft)
  const selectors: PublishSelectors = { ...DEFAULT_SELECTORS, ...options.selectors }
  const publishUrl = options.publishUrl ?? PUBLISH_URL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const steps: PublishStep[] = [
    { name: '打开发布页', run: (page, ctx) => stepOpenPage(page, ctx, publishUrl, selectors, timeoutMs, options) },
    { name: '上传图片', run: (page, ctx) => stepUploadImages(page, ctx, draft, selectors, options) },
    { name: '填写文案', run: (page, ctx) => stepFillText(page, ctx, draft, selectors, options) },
  ]
  if (draft.category !== undefined) {
    steps.push({ name: '选择分类', run: (page, ctx) => stepSelectCategory(page, ctx, draft.category ?? '', options) })
  }
  if (draft.pricingMode !== undefined) {
    steps.push({ name: '选择计价方式', run: (page, ctx) => stepPricingMode(page, ctx, draft.pricingMode ?? '', options) })
  }
  steps.push({ name: '填写价格', run: (page, ctx) => stepPriceAndShipping(page, ctx, draft, selectors, options) })
  if (draft.address !== undefined) {
    steps.push({ name: '填写地址', run: (page, ctx) => stepAddress(page, ctx, draft.address ?? '', selectors, options) })
  }
  if (options.dryRun === false) {
    steps.push({ name: '必填项预检', run: (page, ctx) => stepCheckRequired(page, ctx, options) })
    steps.push({ name: '提交并验证', run: (page, ctx) => stepSubmitAndVerify(page, ctx, selectors, options) })
  } else {
    steps.push({ name: 'dry-run 收尾', run: (page, ctx) => stepDryRun(page, ctx, options) })
  }
  return steps
}

/** 校验草稿并顺序执行；返回 runPublishSteps 的契约结果（ok=false 时带失败步骤）。 */
export async function publishItem(
  page: CdpPage,
  draft: PublishDraft,
  ctx: PublishContext,
  options: PublishOptions = {},
): Promise<PublishRunResult & { itemId?: string }> {
  // 用带风控检查的包装执行：页面级风控要翻译成 RISK_CONTROL（daemon 靠它 trip 熔断）。
  const result = await runRiskGuardedSteps(page, createPublishSteps(draft, options), ctx)
  if (!result.ok) return result
  if (options.dryRun !== false) return { ok: true }
  const itemId = extractItemId(await readLocationHref(page))
  return itemId === undefined ? { ok: true } : { ok: true, itemId }
}

async function stepOpenPage(
  page: CdpPage,
  ctx: PublishContext,
  publishUrl: string,
  selectors: PublishSelectors,
  timeoutMs: number,
  options: PublishOptions,
): Promise<void> {
  await page.navigate(publishUrl)
  await waitForElement(page, selectors.description, { timeoutMs, label: '发布页文案输入框' })
  ctx.log('打开发布页', '已到 ' + publishUrl)
  await shot(page, options, '01-open')
}

async function stepUploadImages(
  page: CdpPage,
  ctx: PublishContext,
  draft: PublishDraft,
  selectors: PublishSelectors,
  options: PublishOptions,
): Promise<void> {
  if (!(await elementExists(page, selectors.fileInput))) {
    // 页面常见的隐藏式上传：先点「添加首图」把 input 挂出来。
    await clickByText(page, selectors.addImageText, '添加首图')
    await waitForElement(page, selectors.fileInput, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, label: '文件输入框' })
  }
  await setFileInputFiles(page, draft.images, selectors.fileInput)
  const minimum = Math.max(1, Math.min(draft.images.length, 3))
  await waitForCount(page, selectors.previewImage, minimum, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  ctx.log('上传图片', '已提交 ' + String(draft.images.length) + ' 张图片')
  await shot(page, options, '02-images')
}

async function stepFillText(
  page: CdpPage,
  ctx: PublishContext,
  draft: PublishDraft,
  selectors: PublishSelectors,
  options: PublishOptions,
): Promise<void> {
  if (selectors.title !== undefined && (await elementExists(page, selectors.title))) {
    await fillText(page, selectors.title, draft.title, '标题')
    await fillText(page, selectors.description, draft.desc, '描述')
    ctx.log('填写文案', '标题与描述分开填写')
  } else {
    // 网页版只有一个文案框：标题与描述同段文案（A 笔记 §上架六步）。
    const merged = draft.title.trim() === '' ? draft.desc : draft.title + '\n' + draft.desc
    await fillText(page, selectors.description, merged, '描述')
    ctx.log('填写文案', '标题并入描述（网页版单文案框）')
  }
  await shot(page, options, '03-text')
}

async function stepPricingMode(
  page: CdpPage,
  ctx: PublishContext,
  pricingMode: string,
  options: PublishOptions,
): Promise<void> {
  await clickByText(page, '请选择计价方式', '计价方式入口')
  await clickByText(page, pricingMode, '计价方式：' + pricingMode)
  ctx.log('选择计价方式', pricingMode)
  await shot(page, options, '04-pricing')
}

async function stepPriceAndShipping(
  page: CdpPage,
  ctx: PublishContext,
  draft: PublishDraft,
  selectors: PublishSelectors,
  options: PublishOptions,
): Promise<void> {
  const count = await countElements(page, selectors.priceInput)
  if (count === 0) throw new XianyuError({ code: 'VALIDATION', message: '页面上没有价格输入框（' + selectors.priceInput + '）' })
  await fillFieldAt(page, selectors.priceInput, 0, priceToYuanText(draft.priceCents), '售价')
  if (draft.shipping === 'none') {
    await clickByText(page, '无需邮寄', '发货方式：无需邮寄')
  } else {
    await clickByText(page, '包邮', '发货方式：包邮')
  }
  ctx.log('填写价格', '售价 ' + priceToYuanText(draft.priceCents) + ' 元，' + (draft.shipping === 'none' ? '无需邮寄' : '包邮'))
  await shot(page, options, '05-price')
}

async function stepAddress(
  page: CdpPage,
  ctx: PublishContext,
  address: string,
  selectors: PublishSelectors,
  options: PublishOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  await clickSelector(page, selectors.addressContainer, '地址容器')
  await waitForElement(page, selectors.addressSearchInput, { timeoutMs, label: '地点搜索框' })
  // 联想是接口驱动的：必须走真实键盘输入，改 value 不触发搜索。
  await typeInto(page, selectors.addressSearchInput, address, '地点搜索')
  // 按文本挑候选：第一个候选经常不是目标地址（搜「广州大学城」首条曾是垃圾分类驿站）。
  const chosen = await pickAddressOption(page, selectors.addressOption, address, timeoutMs)
  // 点候选后地址会写回表单项；回读校验实际地址，防止点错候选却静默成功。
  const picked = await waitFormFieldText(page, '宝贝所在地', timeoutMs)
  if (picked === '' || picked === '请选择地址') {
    throw new XianyuError({ code: 'VALIDATION', message: '点了地点候选但地址没写回表单：' + address })
  }
  ctx.log('填写地址', '目标「' + address + '」→ 候选「' + chosen + '」→ 表单「' + picked + '」')
  await shot(page, options, '06-address')
}

async function stepSubmitAndVerify(
  page: CdpPage,
  ctx: PublishContext,
  selectors: PublishSelectors,
  options: PublishOptions,
): Promise<void> {
  await clickSelector(page, selectors.submitButton, '发布按钮')
  const timeoutMs = options.successTimeoutMs ?? DEFAULT_SUCCESS_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const href = await readLocationHref(page)
    if (extractItemId(href) !== undefined) {
      ctx.log('提交并验证', '成功：已跳转到商品页 ' + href)
      await shot(page, options, '07-success')
      return
    }
    if (await pageHasSuccessText(page)) {
      ctx.log('提交并验证', '成功：页面出现「发布成功」')
      await shot(page, options, '07-success')
      return
    }
    await delay(POLL_MS)
  }
  await shot(page, options, '07-failed')
  const text = await readBodyText(page)
  const hint = findProblemHint(text)
  throw new XianyuError({
    code: 'INTERNAL',
    message:
      '提交后 ' +
      String(timeoutMs) +
      'ms 内没有看到成功标记（URL 仍是发布页、也没出现「发布成功」），按失败处理；不要自动重试，交给人工确认。' +
      (hint === undefined ? '' : '页面提示：' + hint),
  })
}

/**
 * 真发布前的必填项预检。
 * 「分类」由页面按图片/文案自动识别，代码不去选类目；为空说明识别失败，点提交也只会被拦。
 */
async function stepCheckRequired(page: CdpPage, ctx: PublishContext, options: PublishOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const category = await waitFormFieldText(page, '分类', timeoutMs)
  await assertCategoryPublishable(page, category)
  if (category === '') {
    throw new XianyuError({ code: 'VALIDATION', message: '分类为空：页面没识别出类目，本工具不自动选类目，需人工先选好分类再发布' })
  }
  const address = await waitFormFieldText(page, '宝贝所在地', timeoutMs)
  if (address === '') throw new XianyuError({ code: 'VALIDATION', message: '宝贝所在地为空，提交会被闲鱼拦下' })
  ctx.log('必填项预检', '分类「' + category + '」，所在地「' + address + '」')
  await shot(page, options, '05b-required')
}

async function stepDryRun(page: CdpPage, ctx: PublishContext, options: PublishOptions): Promise<void> {
  const href = await readLocationHref(page)
  const category = await readFormFieldText(page, '分类')
  const address = await readFormFieldText(page, '宝贝所在地')
  ctx.log('dry-run 收尾', '表单已填完但**没有点提交**；分类「' + category + '」、所在地「' + address + '」；当前 URL ' + href)
  await shot(page, options, '99-dry-run')
}

/** 提交后成功判定的第二条：页面出现「发布成功」。 */
async function pageHasSuccessText(page: DomPage): Promise<boolean> {
  const text = await readBodyText(page)
  return text.includes('发布成功')
}

/** 从页面文本里摘一条可能的原因（只用于报错提示，不参与成功判定）。 */
function findProblemHint(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const keywords = ['请选择', '请填写', '不能为空', '暂不支持', '扫码', '失败', '错误']
  const hit = lines.find((line) => keywords.some((keyword) => line.includes(keyword)))
  return hit === undefined ? undefined : hit.slice(0, 80)
}

async function shot(page: CdpPage, options: PublishOptions, name: string): Promise<void> {
  if (options.screenshotsDir === undefined) return
  const target = options.screenshotsDir + '/' + name + '.png'
  await page.screenshot(target)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
