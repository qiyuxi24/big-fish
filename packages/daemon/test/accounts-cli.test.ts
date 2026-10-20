/**
 * import-account 子命令测试：参数解析 + runCli 导入路径。
 * 导入器用假实现注入，避免本机沙箱 spawn/连 Chrome；凭据目录用临时 .scratch。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'
import type { EnvLike } from '@bigfish/core'

import type { ImportAccountDeps, ImportAccountInput, ImportedAccount } from '../src/accounts.ts'
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
    assert.equal(error.code, 'VALIDATION')
    return error
  }
  throw new Error('期望解析失败：' + argv.join(' '))
}

describe('import-account 参数解析', () => {
  it('识别子命令与全部参数（空格/等号两种写法）', () => {
    const options = parseArgs(['import-account', '--data-dir', 'D:/tmp/bf', '--account-id=main', '--chrome-port=9333'])
    assert.equal(options.command, 'import-account')
    assert.equal(options.dataDir, 'D:/tmp/bf')
    assert.equal(options.accountId, 'main')
    assert.equal(options.chromePort, 9333)
  })

  it('默认是 serve，且 --data-dir 在两种模式下都可用', () => {
    assert.equal(parseArgs([]).command, 'serve')
    assert.equal(parseArgs(['--data-dir', 'D:/tmp/bf']).command, 'serve')
  })

  it('未知子命令 / 模式串参数 / 非法 chrome 端口都是 VALIDATION', () => {
    assert.match(parseFailure(['nope']).message, /未知子命令/)
    assert.match(parseFailure(['publish']).message, /--draft/)
    // serve 模式不该静默吞掉导入参数：用户很容易以为它会顺手导入。
    assert.match(parseFailure(['--account-id', 'main']).message, /只用于 import-account/)
    assert.match(parseFailure(['--chrome-port', '9222']).message, /只用于 import-account/)
    assert.match(parseFailure(['import-account', '--port', '47001']).message, /只接受/)
    assert.match(parseFailure(['import-account', '--print-config']).message, /print-config/)
    assert.match(parseFailure(['import-account', '--chrome-port', '0']).message, /chrome-port/)
    assert.match(parseFailure(['import-account', '--chrome-port', '70000']).message, /chrome-port/)
  })
})

describe('import-account 运行', () => {
  it('注入假导入器：打印摘要、退出码 0、凭据目录取自 --data-dir', async (t) => {
    await mkdir(SCRATCH_ROOT, { recursive: true })
    const dir = await mkdtemp(join(SCRATCH_ROOT, 'cli-import-'))
    t.after(async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true })
    })
    const seen: Array<{ deps: ImportAccountDeps; input: ImportAccountInput }> = []
    const deps: RunCliDeps = {
      importAccount: async (input): Promise<ImportedAccount> => {
        seen.push({ deps: input, input })
        return { accountId: '12345', savedFieldCount: 2, updatedAt: 1_700_000_000_000, source: 'chrome-cdp' }
      },
    }
    const { io, output } = capture()
    const code = await runCli(
      ['import-account', '--data-dir', dir, '--account-id', 'main', '--chrome-port', '9333'],
      EMPTY_ENV,
      io,
      deps,
    )
    assert.equal(code, 0)
    assert.equal(output.stderr.length, 0)
    assert.equal(seen.length, 1)
    const call = seen[0]
    assert.ok(call !== undefined)
    assert.equal(call.deps.credentials.constructor.name, 'CredentialStore')
    assert.equal(call.input.accountId, 'main')
    assert.equal(call.input.port, 9333)
    const printed = JSON.parse(output.stdout[0] ?? '{}') as Record<string, unknown>
    assert.equal(printed['accountId'], '12345')
    assert.equal(printed['savedFieldCount'], 2)
    assert.match(output.stdout.join('\n'), /已导入账号 12345/)
  })

  it('导入失败（如 Chrome 没开调试端口）→ 退出码 1 且提示可操作', async (t) => {
    await mkdir(SCRATCH_ROOT, { recursive: true })
    const dir = await mkdtemp(join(SCRATCH_ROOT, 'cli-import-'))
    t.after(async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true })
    })
    const deps: RunCliDeps = {
      importAccount: async (): Promise<ImportedAccount> => {
        throw new XianyuError({ code: 'NETWORK', message: '连不上 DevTools（端口 9222）' })
      },
    }
    const { io, output } = capture()
    assert.equal(await runCli(['import-account', '--data-dir', dir], EMPTY_ENV, io, deps), 1)
    assert.match(output.stderr.join('\n'), /导入登录态失败/)
    assert.match(output.stderr.join('\n'), /DevTools/)
  })

  it('--help 提到 import-account 子命令', async () => {
    const { io, output } = capture()
    assert.equal(await runCli(['--help'], EMPTY_ENV, io), 0)
    assert.match(output.stdout.join('\n'), /import-account/)
  })
})
