/**
 * CDP 发布通道测试：草稿解析、账号比对、dry-run/真提交分支、失败语义。
 * 步骤机与 Chrome 都用假实现注入，不 spawn、不联网。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'
import type { CdpPage } from '@bigfish/channel-cdp'

import { parsePublishDraftFile, publishViaCdp, toCdpDraft } from '../src/cdp-publish.ts'
import type { PublishViaCdpDeps, PublishViaCdpResult } from '../src/cdp-publish.ts'
import { createOperationPort } from '../src/operations.ts'
import type { PublishDraft, Session } from '../src/executors.ts'

const SESSION: Session = { accountId: '12345', cookies: { unb: '12345', _m_h5_tk: 'tk' } }

const VALID_DRAFT = {
  title: '测试商品',
  desc: '这是描述',
  priceCents: 1990,
  images: ['D:\\pics\\a.png'],
}

function asXianyuError(error: unknown): XianyuError {
  assert.ok(error instanceof XianyuError, '期望 XianyuError，实际 ' + String(error))
  return error
}

function assertCode(error: unknown, code: string): XianyuError {
  asXianyuError(error)
  assert.ok(error instanceof XianyuError, '期望 XianyuError，实际 ' + String(error))
  assert.equal(error.code, code)
  return error
}

/** 只实现 evaluate 的假页面：步骤机被替换掉，所以只需要能读 location.href。 */
function fakePage(href: string): CdpPage {
  return {
    async evaluate<T>(expression: string): Promise<T> {
      assert.match(expression, /location\.href/)
      return href as unknown as T
    },
  } as unknown as CdpPage
}

interface PageCall {
  port: number
}

function recordingDeps(record: {
  steps: Array<{ draft: unknown; options: unknown }>
  pages: PageCall[]
  browserAccountId: string
  pageHref: string
  stepResult: { ok: true; itemId?: string } | { ok: false; step: string; error: string }
}): PublishViaCdpDeps {
  return {
    readBrowserAccountId: async (): Promise<string> => record.browserAccountId,
    withPage: async <T>(port: number, fn: (page: CdpPage) => Promise<T>): Promise<T> => {
      record.pages.push({ port })
      return await fn(fakePage(record.pageHref))
    },
    runSteps: async (_page, draft, _ctx, options): Promise<{ ok: true; itemId?: string } | { ok: false; step: string; error: string }> => {
      record.steps.push({ draft, options })
      return record.stepResult
    },
    now: (): number => 1_000,
  }
}

describe('parsePublishDraftFile', () => {
  it('接受合法草稿并补默认标题', () => {
    const draft = parsePublishDraftFile(VALID_DRAFT)
    assert.equal(draft.title, '测试商品')
    assert.equal(draft.priceCents, 1990)
    assert.deepEqual(draft.images, ['D:\\pics\\a.png'])
    const noTitle = parsePublishDraftFile({ desc: '只有描述', priceCents: 100, images: ['/tmp/a.png'] })
    assert.equal(noTitle.title, '')
  })

  it('拒绝非对象 / 缺 desc / 价格非法 / 图片相对路径', () => {
    assertCode(catchOf((): unknown => parsePublishDraftFile(null)), 'VALIDATION')
    assert.match(catchOf((): unknown => parsePublishDraftFile({ ...VALID_DRAFT, desc: '  ' })).message, /desc/)
    assert.match(catchOf((): unknown => parsePublishDraftFile({ ...VALID_DRAFT, priceCents: 0 })).message, /priceCents/)
    assert.match(catchOf((): unknown => parsePublishDraftFile({ ...VALID_DRAFT, priceCents: 1.5 })).message, /priceCents/)
    assert.match(catchOf((): unknown => parsePublishDraftFile({ ...VALID_DRAFT, images: [] })).message, /images/)
    assert.match(catchOf((): unknown => parsePublishDraftFile({ ...VALID_DRAFT, images: ['pics/a.png'] })).message, /绝对路径/)
    assert.match(catchOf((): unknown => parsePublishDraftFile({ ...VALID_DRAFT, shipping: 'paid' })).message, /shipping/)
  })

  it('quantity 校验：正整数放行、0 拒绝；toCdpDraft 遇 quantity 显式拒收', () => {
    const withQuantity = parsePublishDraftFile({ ...VALID_DRAFT, quantity: 2 })
    assert.equal(withQuantity.quantity, 2)
    assert.match(catchOf((): unknown => parsePublishDraftFile({ ...VALID_DRAFT, quantity: 0 })).message, /quantity/)
    assert.match(catchOf((): unknown => toCdpDraft(withQuantity)).message, /quantity/)
  })

  it('category 可选：字符串透传给步骤机，非字符串拒绝', () => {
    const withCategory = parsePublishDraftFile({ ...VALID_DRAFT, category: '电子资料' })
    assert.equal(withCategory.category, '电子资料')
    assert.equal(toCdpDraft(withCategory).category, '电子资料')
    assert.equal(toCdpDraft(parsePublishDraftFile(VALID_DRAFT)).category, undefined)
    assert.match(catchOf((): unknown => parsePublishDraftFile({ ...VALID_DRAFT, category: 1 })).message, /category/)
  })
})

describe('publishViaCdp', () => {
  it('dry-run：默认不提交，步骤机收到 dryRun=true', async () => {
    const record = {
      steps: [] as Array<{ draft: unknown; options: unknown }>,
      pages: [] as PageCall[],
      browserAccountId: '12345',
      pageHref: 'https://www.goofish.com/publish',
      stepResult: { ok: true } as const,
    }
    const result = await publishViaCdp(
      { draft: VALID_DRAFT, submit: false, chromePort: 9333 },
      recordingDeps(record),
    )
    assert.equal(result.dryRun, true)
    assert.equal(result.href, 'https://www.goofish.com/publish')
    assert.equal(result.accountId, '12345')
    assert.equal(result.itemId, undefined)
    assert.equal(result.durationMs, 0)
    assert.equal(record.pages.length, 1)
    assert.equal(record.pages[0]?.port, 9333)
    const options = record.steps[0]?.options as { dryRun?: boolean }
    assert.equal(options.dryRun, true)
  })

  it('账号不一致直接拒绝，且不打开页面', async () => {
    const record = {
      steps: [] as Array<{ draft: unknown; options: unknown }>,
      pages: [] as PageCall[],
      browserAccountId: '99999',
      pageHref: 'https://www.goofish.com/publish',
      stepResult: { ok: true } as const,
    }
    const error = await catchAsync(async (): Promise<unknown> =>
      publishViaCdp({ draft: VALID_DRAFT, submit: false, accountId: '12345' }, recordingDeps(record)),
    )
    assertCode(error, 'VALIDATION')
    assert.match(error.message, /不一致/)
    assert.equal(record.pages.length, 0)
  })

  it('真提交成功：返回 itemId，步骤机收到 dryRun=false', async () => {
    const record = {
      steps: [] as Array<{ draft: unknown; options: unknown }>,
      pages: [] as PageCall[],
      browserAccountId: '12345',
      pageHref: 'https://www.goofish.com/item?id=999888',
      stepResult: { ok: true, itemId: '999888' } as const,
    }
    const result: PublishViaCdpResult = await publishViaCdp(
      { draft: VALID_DRAFT, submit: true, accountId: '12345' },
      recordingDeps(record),
    )
    assert.equal(result.dryRun, false)
    assert.equal(result.itemId, '999888')
    const options = record.steps[0]?.options as { dryRun?: boolean }
    assert.equal(options.dryRun, false)
  })

  it('真提交拿不到 itemId → INTERNAL（按失败处理，不重发）', async () => {
    const record = {
      steps: [] as Array<{ draft: unknown; options: unknown }>,
      pages: [] as PageCall[],
      browserAccountId: '12345',
      pageHref: 'https://www.goofish.com/publish',
      stepResult: { ok: true } as const,
    }
    const error = await catchAsync(async (): Promise<unknown> =>
      publishViaCdp({ draft: VALID_DRAFT, submit: true }, recordingDeps(record)),
    )
    assertCode(error, 'INTERNAL')
    assert.match(error.message, /没解析到商品 id/)
  })

  it('步骤机失败 → INTERNAL 带步骤名', async () => {
    const record = {
      steps: [] as Array<{ draft: unknown; options: unknown }>,
      pages: [] as PageCall[],
      browserAccountId: '12345',
      pageHref: 'https://www.goofish.com/publish',
      stepResult: { ok: false, step: '填写价格', error: '没找到输入框' } as const,
    }
    const error = await catchAsync(async (): Promise<unknown> =>
      publishViaCdp({ draft: VALID_DRAFT, submit: false }, recordingDeps(record)),
    )
    assertCode(error, 'INTERNAL')
    assert.match(error.message, /填写价格/)
    assert.match(error.message, /没找到输入框/)
  })
})

describe('OperationPort.publishItem 门禁', () => {
  const draft: PublishDraft = { title: 't', desc: 'd', priceCents: 100, images: ['D:\\a.png'] }
  const signal = new AbortController().signal

  it('未配置 publish → UNSUPPORTED，提示 dry-run 与 BF_PUBLISH_SUBMIT', async () => {
    const port = createOperationPort({})
    const error = await catchAsync(async (): Promise<unknown> => port.publishItem({ session: SESSION, draft, signal }))
    assertCode(error, 'UNSUPPORTED')
    assert.match(error.message, /BF_PUBLISH_DRYRUN/)
    assert.match(error.message, /BF_PUBLISH_SUBMIT/)
  })

  it('publish.submit=false 仍然 UNSUPPORTED（不因配置存在就真发）', async () => {
    const port = createOperationPort({ publish: { submit: false } })
    const error = await catchAsync(async (): Promise<unknown> => port.publishItem({ session: SESSION, draft, signal }))
    assertCode(error, 'UNSUPPORTED')
  })

  it('submit=true 时调用注入实现并透传账号与端口', async () => {
    const seen: unknown[] = []
    const port = createOperationPort({
      publish: {
        submit: true,
        chromePort: 9333,
        screenshotsDir: 'D:/shots',
        run: async (input): Promise<PublishViaCdpResult> => {
          seen.push(input)
          return { accountId: input.accountId ?? '', dryRun: false, itemId: '555', href: 'https://www.goofish.com/item?id=555', durationMs: 1 }
        },
      },
    })
    const result = await port.publishItem({ session: SESSION, draft, signal })
    assert.equal(result.itemId, '555')
    const input = seen[0] as { accountId?: string; submit?: boolean; chromePort?: number; screenshotsDir?: string }
    assert.equal(input.accountId, '12345')
    assert.equal(input.submit, true)
    assert.equal(input.chromePort, 9333)
    assert.equal(input.screenshotsDir, 'D:/shots')
  })

  it('注入实现没给 itemId → INTERNAL', async () => {
    const port = createOperationPort({
      publish: {
        submit: true,
        run: async (): Promise<PublishViaCdpResult> => ({
          accountId: '12345',
          dryRun: false,
          href: 'https://www.goofish.com/publish',
          durationMs: 1,
        }),
      },
    })
    const error = await catchAsync(async (): Promise<unknown> => port.publishItem({ session: SESSION, draft, signal }))
    assertCode(error, 'INTERNAL')
    assert.match(error.message, /itemId/)
  })
})

async function catchAsync(fn: () => Promise<unknown>): Promise<XianyuError> {
  try {
    await fn()
  } catch (error) {
    return asXianyuError(error)
  }
  throw new Error('期望抛出错误')
}

function catchOf(fn: () => unknown): XianyuError {
  try {
    fn()
  } catch (error) {
    return asXianyuError(error)
  }
  throw new Error('期望抛出错误')
}
