/**
 * daemon 的 CDP 发布通道：接本机 Chrome（用户自己登录）→ 校验账号 → 跑发布步骤机。
 *
 * 为什么发布不走 mtop：发布载荷含图片上传后的 imageInfoDOList，且部分类目只支持 App，
 * 网页端 CDP 是唯一能同时覆盖「图片 + 类目属性 + 地址」的通道（见 docs/xianyu-4q-research.md）。
 *
 * 安全默认：
 * - dry-run（submit=false）只填表、不点提交，供真机校准选择器；
 * - 真提交前先比对浏览器里的 unb 与期望账号，发错账号比发不出去更糟；
 * - 步骤失败一律不重试（INTERNAL 非可重试），交给人工到闲鱼后台确认。
 * @module @bigfish/daemon/cdp-publish
 */
import { XianyuError, fail } from '@bigfish/core'
import {
  CdpConnection,
  CdpCookieSource,
  CdpPage,
  DEFAULT_PORT,
  attachChrome,
  attachChromePage,
  publishItem,
  readLocationHref,
} from '@bigfish/channel-cdp'
import type {
  PublishContext,
  PublishDraft as CdpPublishDraft,
  PublishOptions,
  PublishRunResult,
} from '@bigfish/channel-cdp'

import type { PublishDraft } from './executors.ts'

/** CLI 草稿文件：daemon 必填字段 + 步骤机认识的可选字段。 */
export interface PublishDraftFile extends PublishDraft {
  /** 服务类计价方式（元/次 等）；不传就跳过「请选择计价方式」。 */
  pricingMode?: string
}

/** 一次发布调用的输入。 */
export interface PublishViaCdpInput {
  draft: PublishDraftFile
  /** 期望账号 id；传了就要求与浏览器里登录的一致（防止发到错账号）。 */
  accountId?: string
  /** true = 真提交；false = 只填表。调用方必须显式选择，这里不猜默认值。 */
  submit: boolean
  /** Chrome DevTools 端口，默认 9222。 */
  chromePort?: number
  /** 传了就每步截图（真机校准选择器时必开）。 */
  screenshotsDir?: string
  signal?: AbortSignal
  /** 每一步的日志回调（CLI 打到终端；daemon 里可以不传）。 */
  onLog?: (step: string, message: string) => void
}

/** 发布结果（非敏感摘要）。 */
export interface PublishViaCdpResult {
  accountId: string
  dryRun: boolean
  itemId?: string
  href: string
  durationMs: number
}

/** 步骤机调用签名（测试可注入假步骤机）。 */
export type RunPublishSteps = (
  page: CdpPage,
  draft: CdpPublishDraft,
  ctx: PublishContext,
  options: PublishOptions,
) => Promise<PublishRunResult & { itemId?: string }>

/** 发布通道依赖；默认实现连真 Chrome，测试注入假页面与假步骤机。 */
export interface PublishViaCdpDeps {
  /** 读浏览器里当前登录的闲鱼账号（默认 CDP 读 unb）。 */
  readBrowserAccountId?: (port: number) => Promise<string>
  /** 打开一个空白页面，交给 fn 用完清理（默认 attachChromePage + CdpPage.open）。 */
  withPage?: <T>(port: number, fn: (page: CdpPage) => Promise<T>) => Promise<T>
  /** 跑步骤机（默认 channel-cdp 的 publishItem）。 */
  runSteps?: RunPublishSteps
  now?: () => number
}

/**
 * 发布主流程：读浏览器账号 → 校验 → 开页面 → 跑步骤机 → 收尾。
 *
 * 失败语义：步骤机返回 ok:false 时抛 INTERNAL（不可重试）；真提交后拿不到 itemId 也按失败处理，
 * 因为「提交了但不知道发到哪」比「明确失败」更需要人工确认。
 */
export async function publishViaCdp(
  input: PublishViaCdpInput,
  deps: PublishViaCdpDeps = {},
): Promise<PublishViaCdpResult> {
  const now = deps.now ?? Date.now
  const port = input.chromePort ?? DEFAULT_PORT
  const browserAccountId = await (deps.readBrowserAccountId ?? readBrowserAccountIdFromChrome)(port)
  assertSameAccount(input.accountId, browserAccountId)
  const cdpDraft = toCdpDraft(input.draft)
  const options: PublishOptions = {
    dryRun: !input.submit,
    ...(input.screenshotsDir === undefined ? {} : { screenshotsDir: input.screenshotsDir }),
  }
  const runSteps = deps.runSteps ?? publishItem
  const startedAt = now()
  let href = ''
  let itemId: string | undefined
  await (deps.withPage ?? withChromePage)(port, async (page: CdpPage): Promise<void> => {
    const ctx: PublishContext = {
      log: (step: string, message: string): void => {
        input.onLog?.(step, message)
      },
      now,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }
    const result = await runSteps(page, cdpDraft, ctx, options)
    if (!result.ok) {
      throw new XianyuError({
        code: 'INTERNAL',
        message:
          '发布步骤「' + result.step + '」失败：' + result.error + '（不自动重试，请人工确认页面状态）',
      })
    }
    itemId = result.itemId
    href = await readLocationHref(page)
  })
  if (input.submit && (itemId === undefined || itemId === '')) {
    fail(
      'INTERNAL',
      '提交后没解析到商品 id（当前 URL：' + (href === '' ? '未知' : href) + '），按失败处理：请人工到闲鱼后台确认是否已上架，不要直接重发',
    )
  }
  return {
    accountId: browserAccountId,
    dryRun: !input.submit,
    href,
    durationMs: now() - startedAt,
    ...(itemId === undefined || itemId === '' ? {} : { itemId }),
  }
}

/** daemon 草稿 → 步骤机草稿；未接的字段（quantity）显式拒绝，不静默忽略。 */
export function toCdpDraft(draft: PublishDraftFile): CdpPublishDraft {
  if (draft.quantity !== undefined) {
    fail('VALIDATION', '草稿里的 quantity 还没接入 CDP 发布步骤（当前只会发布 1 件），请先去掉该字段')
  }
  return {
    title: draft.title,
    desc: draft.desc,
    priceCents: draft.priceCents,
    images: draft.images,
    ...(draft.pricingMode === undefined ? {} : { pricingMode: draft.pricingMode }),
    ...(draft.shipping === undefined ? {} : { shipping: draft.shipping }),
    ...(draft.address === undefined ? {} : { address: draft.address }),
    ...(draft.category === undefined ? {} : { category: draft.category }),
  }
}

/** 解析并校验草稿 JSON；错误一律 VALIDATION，文案直接告诉用户哪个字段该怎么改。 */
export function parsePublishDraftFile(raw: unknown): PublishDraftFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('VALIDATION', '草稿文件必须是 JSON 对象')
  }
  const record = raw as Record<string, unknown>
  const desc = readRequiredString(record, 'desc')
  const title = readOptionalString(record, 'title') ?? ''
  const priceCents = record['priceCents']
  if (typeof priceCents !== 'number' || !Number.isSafeInteger(priceCents) || priceCents <= 0) {
    fail('VALIDATION', '草稿的 priceCents 必须是正整数（分），收到 ' + JSON.stringify(record['priceCents']))
  }
  const images = readImages(record)
  const pricingMode = readOptionalString(record, 'pricingMode')
  const address = readOptionalString(record, 'address')
  const category = readOptionalString(record, 'category')
  const shipping = readShipping(record)
  const quantity = record['quantity']
  if (quantity !== undefined && (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1)) {
    fail('VALIDATION', '草稿的 quantity 必须是正整数')
  }
  return {
    title,
    desc,
    priceCents,
    images,
    ...(pricingMode === undefined ? {} : { pricingMode }),
    ...(shipping === undefined ? {} : { shipping }),
    ...(address === undefined ? {} : { address }),
    ...(category === undefined ? {} : { category }),
    ...(quantity === undefined ? {} : { quantity }),
  }
}

/** 只比对 unb；accountId 省略时以浏览器账号为准（不做隐式假设）。 */
function assertSameAccount(expected: string | undefined, actual: string): void {
  const wanted = expected?.trim()
  if (wanted === undefined || wanted === '' || wanted === actual) return
  fail(
    'VALIDATION',
    '浏览器里登录的账号（' + actual + '）与期望账号（' + wanted + '）不一致，拒绝发布：请确认 Chrome 登录的是要发布的那个账号',
  )
}

/** 默认实现：附加浏览器、读 Network.getAllCookies、取 goofish 的 unb。 */
async function readBrowserAccountIdFromChrome(port: number): Promise<string> {
  const target = await attachChrome(port)
  const connection = await CdpConnection.connect(target.browserWsUrl)
  try {
    const jar = await new CdpCookieSource(connection).readGoofishCookies()
    const unb = (jar.goofish['unb'] ?? '').trim()
    if (unb === '') {
      fail('UNAUTHORIZED', '浏览器里没有 unb cookie：请确认这个 Chrome 已登录 https://www.goofish.com/ 后重试')
    }
    return unb
  } finally {
    await connection.close()
    await target.close()
  }
}

/** 默认实现：建页面 target → 连 page ws → 打开空白页，用完整条连接。 */
async function withChromePage<T>(port: number, fn: (page: CdpPage) => Promise<T>): Promise<T> {
  const handle = await attachChromePage(port)
  const connection = await CdpConnection.connect(handle.pageWsUrl)
  try {
    const page = await CdpPage.open(connection, 'about:blank')
    try {
      return await fn(page)
    } finally {
      await page.close()
    }
  } finally {
    await connection.close()
    await handle.close()
  }
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    fail('VALIDATION', '草稿的 ' + key + ' 必须是非空字符串')
  }
  return value
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail('VALIDATION', '草稿的 ' + key + ' 必须是字符串')
  return value
}

function readShipping(record: Record<string, unknown>): 'free' | 'none' | undefined {
  const value = record['shipping']
  if (value === undefined) return undefined
  if (value !== 'free' && value !== 'none') {
    fail('VALIDATION', "草稿的 shipping 只能是 'free'（包邮）或 'none'（无需邮寄）")
  }
  return value
}

function readImages(record: Record<string, unknown>): string[] {
  const value = record['images']
  if (!Array.isArray(value) || value.length === 0) {
    fail('VALIDATION', '草稿的 images 必须是非空数组（本机图片绝对路径）')
  }
  const images: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') fail('VALIDATION', '草稿的 images 必须全是字符串路径')
    if (!isAbsolutePath(entry)) fail('VALIDATION', '图片必须是本机绝对路径：' + entry)
    images.push(entry)
  }
  return images
}

/** 与 channel-cdp 的判定保持一致：POSIX 绝对路径或 Windows 盘符绝对路径。 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}
