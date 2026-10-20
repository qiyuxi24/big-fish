/**
 * publish 子命令测试：参数解析 + runCli 发布路径（发布器注入假实现，不连 Chrome）。
 * 覆盖安全默认：不加 --submit 一律 dry-run。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'
import type { EnvLike } from '@bigfish/core'

import type { PublishViaCdpInput, PublishViaCdpResult } from '../src/cdp-publish.ts'
import { parseArgs, runCli } from '../src/cli.ts'
import type { RunCliDeps } from '../src/cli.ts'

const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-http/', import.meta.url))
const EMPTY_ENV: EnvLike = {}

interface Captured {
  stdout: string[]
  stderr: string[]
}

function capture(): { io: { stdout(line: string): void; stderr(line: string): void }; output: Captured } {
  const output: Captured = { stdout: [], stderr: [] }
  return {
    output,
    io: {
      stdout: (line: string): void => {
        output.stdout.push(line)
      },
      stderr: (line: string): void => {
        output.stderr.push(line)
      },
    },
  }
}

function parseFailure(argv: string[]): XianyuError {
  try {
    parseArgs(argv)
  } catch (error) {
    assert.ok(error instanceof XianyuError)
    return error
  }
  throw new Error('期望解析失败：' + argv.join(' '))
}

async function writeDraft(t: { after(fn: () => Promise<void>): void }): Promise<{ dir: string; draftPath: string }> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'cli-publish-'))
  t.after(async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  })
  const draftPath = join(dir, 'draft.json')
  await writeFile(
    draftPath,
    JSON.stringify({ title: '测试', desc: '描述', priceCents: 1990, images: ['D:\\\\pics\\\\a.png'] }),
    'utf8',
  )
  return { dir, draftPath }
}

function resultOf(input: PublishViaCdpInput, itemId?: string): PublishViaCdpResult {
  return {
    accountId: input.accountId ?? '12345',
    dryRun: !input.submit,
    href: 'https://www.goofish.com/publish',
    durationMs: 12,
    ...(itemId === undefined ? {} : { itemId }),
  }
}

describe('publish 参数解析', () => {
  it('默认 dry-run（submit 未设置），透传草稿与端口', () => {
    const options = parseArgs(['publish', '--draft', 'D:/d.json', '--account-id', 'main', '--chrome-port=9333'])
    assert.equal(options.command, 'publish')
    assert.equal(options.draft, 'D:/d.json')
    assert.equal(options.accountId, 'main')
    assert.equal(options.chromePort, 9333)
    assert.notEqual(options.submit, true)
  })

  it('--submit / --screenshots / --draft= 等号写法', () => {
    const options = parseArgs(['publish', '--draft=D:/d.json', '--screenshots', 'D:/shots', '--submit'])
    assert.equal(options.draft, 'D:/d.json')
    assert.equal(options.screenshots, 'D:/shots')
    assert.equal(options.submit, true)
  })

  it('缺 --draft、publish 带 serve 参数、serve/import 带 publish 参数都是 VALIDATION', () => {
    assert.match(parseFailure(['publish']).message, /--draft/)
    assert.match(parseFailure(['publish', '--draft', 'D:/d.json', '--port', '47001']).message, /只接受/)
    assert.match(parseFailure(['publish', '--draft', 'D:/d.json', '--data-dir', 'D:/bf']).message, /只接受/)
    assert.match(parseFailure(['publish', '--draft', 'D:/d.json', '--print-config']).message, /print-config/)
    assert.match(parseFailure(['--submit']).message, /只用于 publish/)
    assert.match(parseFailure(['import-account', '--data-dir', 'D:/bf', '--draft', 'D:/d.json']).message, /只用于 publish/)
  })
})

describe('publish 运行', () => {
  it('默认 dry-run：打印摘要与「没有点提交」提示，退出码 0', async (t) => {
    const { draftPath } = await writeDraft(t)
    const seen: PublishViaCdpInput[] = []
    const deps: RunCliDeps = {
      publish: async (input): Promise<PublishViaCdpResult> => {
        seen.push(input)
        input.onLog?.('打开发布页', '已打开')
        return resultOf(input)
      },
    }
    const { io, output } = capture()
    const code = await runCli(['publish', '--draft', draftPath, '--account-id', '12345', '--chrome-port', '9333'], EMPTY_ENV, io, deps)
    assert.equal(code, 0)
    assert.equal(output.stderr.length, 0)
    const input = seen[0]
    assert.ok(input !== undefined)
    assert.equal(input.submit, false)
    assert.equal(input.accountId, '12345')
    assert.equal(input.chromePort, 9333)
    assert.equal(input.draft.priceCents, 1990)
    const printed = output.stdout.join('\n')
    assert.match(printed, /dry-run 完成/)
    assert.match(printed, /没有点提交/)
    assert.match(printed, /--submit/)
    assert.match(printed, /打开发布页/)
  })

  it('--submit 真发：打印 itemId 与账号', async (t) => {
    const { draftPath } = await writeDraft(t)
    const deps: RunCliDeps = {
      publish: async (input): Promise<PublishViaCdpResult> => resultOf(input, '777888'),
    }
    const { io, output } = capture()
    assert.equal(await runCli(['publish', '--draft', draftPath, '--submit'], EMPTY_ENV, io, deps), 0)
    assert.match(output.stdout.join('\n'), /已发布：itemId 777888/)
  })

  it('发布失败 → 退出码 1 且错误打到 stderr', async (t) => {
    const { draftPath } = await writeDraft(t)
    const deps: RunCliDeps = {
      publish: async (): Promise<PublishViaCdpResult> => {
        throw new XianyuError({ code: 'NETWORK', message: '连不上 DevTools（端口 9222）' })
      },
    }
    const { io, output } = capture()
    assert.equal(await runCli(['publish', '--draft', draftPath], EMPTY_ENV, io, deps), 1)
    assert.match(output.stderr.join('\n'), /发布失败/)
    assert.match(output.stderr.join('\n'), /DevTools/)
  })

  it('草稿文件不存在 / 不是 JSON → VALIDATION 提示', async (t) => {
    const { dir } = await writeDraft(t)
    const { io, output } = capture()
    assert.equal(await runCli(['publish', '--draft', join(dir, 'missing.json')], EMPTY_ENV, io), 1)
    assert.match(output.stderr.join('\n'), /读不到草稿文件/)
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{oops', 'utf8')
    const second = capture()
    assert.equal(await runCli(['publish', '--draft', bad], EMPTY_ENV, second.io), 1)
    assert.match(second.output.stderr.join('\n'), /不是合法 JSON/)
  })

  it('--help 提到 publish 子命令', async () => {
    const { io, output } = capture()
    assert.equal(await runCli(['--help'], EMPTY_ENV, io), 0)
    const printed = output.stdout.join('\n')
    assert.match(printed, /子命令 publish/)
    assert.match(printed, /--submit/)
  })
})
