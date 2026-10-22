/**
 * 队列发布的两个开关：BF_PUBLISH_DRYRUN（只填表）与 BF_PUBLISH_SUBMIT（真提交）。
 *
 * 为什么单独测：dry-run 是「对着真实账号校验队列链路」的唯一安全入口，
 * 一旦解析错（例如把 dry-run 当 submit）就会真的发出商品，必须在单测里钉死。
 * 发布实现全部注入 fake runner，不起浏览器、不触网。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError, loadDaemonConfig } from '@bigfish/core'

import { publishOptionsFromEnv } from '../src/cli.ts'
import type { PublishViaCdpInput, PublishViaCdpResult } from '../src/cdp-publish.ts'
import type { Session } from '../src/executors.ts'
import { createOperationPort } from '../src/operations.ts'

const CONFIG = loadDaemonConfig({}, { dbPath: 'C:\\data\\bigfish\\bigfish.db' })

const SESSION: Session = { accountId: 'acc-1', cookies: { unb: 'acc-1' } }
const DRAFT = {
  title: '测试草稿',
  desc: '描述',
  priceCents: 100,
  images: ['D:\\pics\\a.png'],
  category: '学习笔记',
  address: '西北工业大学长安校区星天苑',
}

function abortedSignal(): AbortSignal {
  return new AbortController().signal
}

interface RunnerRecord {
  inputs: PublishViaCdpInput[]
}

/** fake 发布实现：记录入参，按需返回 itemId。 */
function makeRunner(result: Omit<PublishViaCdpResult, 'accountId' | 'durationMs'>): RunnerRecord & {
  run: (input: PublishViaCdpInput) => Promise<PublishViaCdpResult>
} {
  const record: RunnerRecord = { inputs: [] }
  return {
    ...record,
    inputs: record.inputs,
    async run(input: PublishViaCdpInput): Promise<PublishViaCdpResult> {
      record.inputs.push(input)
      return { accountId: input.accountId ?? 'acc-1', durationMs: 1, ...result }
    },
  }
}

describe('publishOptionsFromEnv：队列发布开关', () => {
  it('两个开关都没开 → undefined（默认完全关闭）', () => {
    assert.equal(publishOptionsFromEnv({}, CONFIG), undefined)
    assert.equal(publishOptionsFromEnv({ BF_PUBLISH_SUBMIT: '0', BF_PUBLISH_DRYRUN: 'false' }, CONFIG), undefined)
  })

  it('BF_PUBLISH_SUBMIT=1 → submit:true，截图目录默认在 db 同目录', () => {
    const options = publishOptionsFromEnv({ BF_PUBLISH_SUBMIT: '1' }, CONFIG)
    assert.deepEqual(options, { submit: true, screenshotsDir: 'C:\\data\\bigfish\\publish-shots' })
  })

  it('BF_PUBLISH_DRYRUN=1 → submit:false + dryRun:true（安全默认）', () => {
    const options = publishOptionsFromEnv({ BF_PUBLISH_DRYRUN: 'true' }, CONFIG)
    assert.deepEqual(options, { submit: false, dryRun: true, screenshotsDir: 'C:\\data\\bigfish\\publish-shots' })
  })

  it('两个都开 → dryRun 优先，不得真提交', () => {
    const options = publishOptionsFromEnv({ BF_PUBLISH_SUBMIT: '1', BF_PUBLISH_DRYRUN: '1' }, CONFIG)
    assert.equal(options?.submit, false)
    assert.equal(options?.dryRun, true)
  })

  it('端口与截图目录可按环境变量覆盖；非法端口报 VALIDATION', () => {
    const options = publishOptionsFromEnv(
      { BF_PUBLISH_DRYRUN: '1', BF_CHROME_PORT: '9300', BF_PUBLISH_SCREENSHOTS: 'D:\\shots' },
      CONFIG,
    )
    assert.equal(options?.chromePort, 9300)
    assert.equal(options?.screenshotsDir, 'D:\\shots')
    assert.throws(
      () => publishOptionsFromEnv({ BF_PUBLISH_DRYRUN: '1', BF_CHROME_PORT: 'abc' }, CONFIG),
      (error: unknown): boolean => error instanceof XianyuError && error.code === 'VALIDATION',
    )
  })
})

describe('operations.publishItem：dry-run 语义', () => {
  it('未开任何开关 → UNSUPPORTED（宁可失败不留假成功）', async () => {
    const port = createOperationPort({})
    await assert.rejects(
      port.publishItem({ session: SESSION, draft: DRAFT, signal: abortedSignal() }),
      (error: unknown): boolean => error instanceof XianyuError && error.code === 'UNSUPPORTED',
    )
  })

  it('只给 submit:false、没给 dryRun → 仍 UNSUPPORTED', async () => {
    const port = createOperationPort({ publish: { submit: false } })
    await assert.rejects(
      port.publishItem({ session: SESSION, draft: DRAFT, signal: abortedSignal() }),
      (error: unknown): boolean => error instanceof XianyuError && error.code === 'UNSUPPORTED',
    )
  })

  it('dryRun → runner 收到 submit:false，任务成功且不要求 itemId', async () => {
    const runner = makeRunner({ dryRun: true, href: 'https://www.goofish.com/publish' })
    const port = createOperationPort({ publish: { submit: false, dryRun: true, run: runner.run } })
    const result = await port.publishItem({ session: SESSION, draft: DRAFT, signal: abortedSignal() })
    assert.deepEqual(result, {})
    assert.equal(runner.inputs.length, 1)
    assert.equal(runner.inputs[0]?.submit, false)
  })

  it('submit 真提交但结果没有 itemId → INTERNAL（提交了却不知道发到哪，必须人工确认）', async () => {
    const runner = makeRunner({ dryRun: false, href: 'https://www.goofish.com/publish' })
    const port = createOperationPort({ publish: { submit: true, run: runner.run } })
    await assert.rejects(
      port.publishItem({ session: SESSION, draft: DRAFT, signal: abortedSignal() }),
      (error: unknown): boolean => error instanceof XianyuError && error.code === 'INTERNAL',
    )
  })

  it('submit + itemId → 返回 itemId，runner 收到 submit:true', async () => {
    const runner = makeRunner({ dryRun: false, href: 'https://www.goofish.com/item?id=123', itemId: '123' })
    const port = createOperationPort({ publish: { submit: true, run: runner.run } })
    const result = await port.publishItem({ session: SESSION, draft: DRAFT, signal: abortedSignal() })
    assert.deepEqual(result, { itemId: '123' })
    assert.equal(runner.inputs[0]?.submit, true)
  })

  it('submit 与 dryRun 同时为真 → runner 仍收到 submit:false（防误发）', async () => {
    const runner = makeRunner({ dryRun: true, href: 'https://www.goofish.com/publish' })
    const port = createOperationPort({ publish: { submit: true, dryRun: true, run: runner.run } })
    const result = await port.publishItem({ session: SESSION, draft: DRAFT, signal: abortedSignal() })
    assert.deepEqual(result, {})
    assert.equal(runner.inputs[0]?.submit, false)
  })
})
