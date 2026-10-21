/**
 * login 子命令测试：参数解析 + runCli 扫码登录路径。
 * 登录器用假实现注入，避免本机沙箱 spawn/连 Chrome；凭据目录用临时 .scratch。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { CredentialStore, XianyuError } from '@bigfish/core'
import type { EnvLike } from '@bigfish/core'

import type { LoginDeps, LoginInput, LoginResult } from '../src/login.ts'
import { parseArgs, runCli } from '../src/cli.ts'
import type { RunCliDeps } from '../src/cli.ts'

const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-login/', import.meta.url))
const EMPTY_ENV: EnvLike = {}
const NOW = 1_700_000_000_000

const LOGGED: LoginResult = {
  accountId: '12345',
  savedFieldCount: 2,
  updatedAt: NOW,
  source: 'chrome-cdp',
  elapsedMs: 12_345,
}

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

async function makeDataDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'cli-login-'))
  t.after(async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('login 参数解析', () => {
  it('识别子命令与全部参数（空格/等号两种写法）', () => {
    const options = parseArgs([
      'login',
      '--data-dir',
      'D:/tmp/bf',
      '--account-id=main',
      '--chrome-port=9333',
      '--timeout-ms=5000',
    ])
    assert.equal(options.command, 'login')
    assert.equal(options.dataDir, 'D:/tmp/bf')
    assert.equal(options.accountId, 'main')
    assert.equal(options.chromePort, 9333)
    assert.equal(options.timeoutMs, 5000)
  })

  it('login 默认不设超时（由 login.ts 用 180s 默认值）', () => {
    const options = parseArgs(['login'])
    assert.equal(options.command, 'login')
    assert.equal(options.timeoutMs, undefined)
  })

  it('login 不接受服务端参数 / print-config / publish 参数', () => {
    assert.match(parseFailure(['login', '--port', '47001']).message, /只接受/)
    assert.match(parseFailure(['login', '--token-path', 'x']).message, /只接受/)
    assert.match(parseFailure(['login', '--print-config']).message, /print-config/)
    assert.match(parseFailure(['login', '--submit']).message, /只用于 publish/)
    assert.match(parseFailure(['login', '--draft', 'x.json']).message, /只用于 publish/)
  })

  it('--timeout-ms 只属于 login，且必须是正整数', () => {
    assert.match(parseFailure(['--timeout-ms', '5000']).message, /只用于 login/)
    assert.match(parseFailure(['import-account', '--timeout-ms', '1000']).message, /只用于 login/)
    assert.match(parseFailure(['publish', '--draft', 'x.json', '--timeout-ms', '1000']).message, /只用于 login/)
    assert.match(parseFailure(['login', '--timeout-ms', '0']).message, /timeout-ms/)
    assert.match(parseFailure(['login', '--timeout-ms', 'abc']).message, /timeout-ms/)
    assert.match(parseFailure(['login', '--timeout-ms', '1.5']).message, /timeout-ms/)
  })
})

describe('login 运行', () => {
  it('注入假登录器：打印进程进度与摘要、退出码 0、参数透传', async (t) => {
    const dir = await makeDataDir(t)
    const seen: Array<{ deps: LoginDeps; input: LoginInput }> = []
    const deps: RunCliDeps = {
      login: async (loginDeps: LoginDeps, input: LoginInput): Promise<LoginResult> => {
        seen.push({ deps: loginDeps, input })
        input.onTick?.({ attempt: 1, elapsedMs: 2200 })
        return LOGGED
      },
    }
    const { io, output } = capture()
    const code = await runCli(
      ['login', '--data-dir', dir, '--account-id', 'main', '--chrome-port', '9333', '--timeout-ms', '4000'],
      EMPTY_ENV,
      io,
      deps,
    )
    assert.equal(code, 0)
    assert.equal(output.stderr.length, 0)
    assert.equal(seen.length, 1)
    const call = seen[0]
    assert.ok(call !== undefined)
    assert.ok(call.deps.credentials instanceof CredentialStore)
    assert.equal(call.input.accountId, 'main')
    assert.equal(call.input.port, 9333)
    assert.equal(call.input.timeoutMs, 4000)
    assert.ok(output.stdout.includes('等待扫码中（已等 2s，第 1 次检查）…'))
    assert.match(output.stdout.join('\n'), /已导入账号 12345/)
    assert.match(output.stdout.join('\n'), /耗时 12\.3s/)
    assert.match(output.stdout.join('\n'), /POST \/accounts\/login/)
    const printed = JSON.parse(output.stdout[1] ?? '{}') as Record<string, unknown>
    assert.equal(printed['accountId'], '12345')
    assert.equal(printed['elapsedMs'], 12_345)
  })

  it('扫码超时 → 退出码 1，中文提示可直接照做', async (t) => {
    const dir = await makeDataDir(t)
    const deps: RunCliDeps = {
      login: async (): Promise<LoginResult> => {
        throw new XianyuError({
          code: 'UNAUTHORIZED',
          message: '扫码超时：请确认浏览器窗口已打开并完成扫码（已等 180 秒，端口 9222）',
        })
      },
    }
    const { io, output } = capture()
    assert.equal(await runCli(['login', '--data-dir', dir, '--timeout-ms', '180000'], EMPTY_ENV, io, deps), 1)
    assert.match(output.stderr.join('\n'), /扫码登录失败/)
    assert.match(output.stderr.join('\n'), /扫码超时/)
  })

  it('--help 提到 login 子命令与 --timeout-ms', async () => {
    const { io, output } = capture()
    assert.equal(await runCli(['--help'], EMPTY_ENV, io), 0)
    const text = output.stdout.join('\n')
    assert.match(text, /子命令 login/)
    assert.match(text, /--timeout-ms MS/)
    assert.match(text, /扫码/)
  })
})
