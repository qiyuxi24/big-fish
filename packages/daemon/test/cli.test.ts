/**
 * CLI 测试：参数解析、--print-config、帮助与错误退出码。
 * 本沙箱禁止 spawn，所以直接调 runCli 并注入 io，不启动真实进程。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'
import type { EnvLike } from '@bigfish/core'

import { parseArgs, runCli, toConfigOverrides } from '../src/cli.ts'

interface Captured {
  stdout: string[]
  stderr: string[]
}

interface CapturedIo {
  io: { stdout(line: string): void; stderr(line: string): void }
  output: Captured
}

function capture(): CapturedIo {
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

const EMPTY_ENV: EnvLike = {}

/** 与 harness 相同的 .scratch 根目录（gitignore），CLI 用例的临时数据目录放这里。 */
const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-http/', import.meta.url))

/** 断言 parseArgs 抛 VALIDATION。 */
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

describe('CLI 参数解析', () => {
  it('支持空格与等号两种写法，--print-config/--help 开关', () => {
    const options = parseArgs([
      '--data-dir', 'D:/tmp/data',
      '--port=47999',
      '--host', 'localhost',
      '--token-path=D:/tmp/custom.token',
      '--print-config',
    ])
    assert.equal(options.dataDir, 'D:/tmp/data')
    assert.equal(options.port, 47999)
    assert.equal(options.host, 'localhost')
    assert.equal(options.tokenPath, 'D:/tmp/custom.token')
    assert.equal(options.printConfig, true)
    assert.equal(options.help, false)
    assert.equal(parseArgs(['-h']).help, true)
  })

  it('未知参数、缺取值、非法端口都是 VALIDATION', () => {
    assert.match(parseFailure(['--nope']).message, /未知参数/)
    assert.match(parseFailure(['--data-dir']).message, /缺少取值/)
    assert.match(parseFailure(['--port', 'abc']).message, /port/)
    assert.match(parseFailure(['--port', '65536']).message, /port/)
  assert.equal(parseArgs(['--port', '0']).port, 0)
    assert.match(parseFailure(['--port', '70000']).message, /port/)
  })

  it('--data-dir 会展开 dbPath/credentialsDir/circuitPath/tokenPath', () => {
    const overrides = toConfigOverrides(parseArgs(['--data-dir', 'D:/d', '--token-path', 'D:/t']))
    assert.equal(overrides.dbPath, join('D:/d', 'bigfish.db'))
    assert.equal(overrides.credentialsDir, join('D:/d', 'credentials'))
    assert.equal(overrides.circuitPath, join('D:/d', 'circuits.json'))
    assert.equal(overrides.tokenPath, 'D:/t')
  })
})

describe('CLI 运行', () => {
  it('--print-config 打印默认配置，退出码 0', async () => {
    const { io, output } = capture()
    assert.equal(await runCli(['--print-config'], EMPTY_ENV, io), 0)
    const config = JSON.parse(output.stdout.join('\n')) as Record<string, unknown>
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 47001)
    assert.match(String(config.dbPath), /bigfish\.db$/)
    assert.match(String(config.tokenPath), /daemon\.token$/)
    assert.equal(output.stderr.length, 0)
  })

  it('--data-dir + --token-path 覆盖配置', async () => {
    const { io, output } = capture()
    const exitCode = await runCli(['--data-dir', 'D:/tmp/bf', '--token-path', 'D:/tmp/t.token', '--port', '47900', '--print-config'], EMPTY_ENV, io)
    assert.equal(exitCode, 0)
    const config = JSON.parse(output.stdout.join('\n')) as Record<string, unknown>
    assert.equal(config.port, 47900)
    assert.equal(config.dbPath, join('D:/tmp/bf', 'bigfish.db'))
    assert.equal(config.tokenPath, 'D:/tmp/t.token')
  })

  it('--help 退出码 0 且输出用法', async () => {
    const { io, output } = capture()
    assert.equal(await runCli(['--help'], EMPTY_ENV, io), 0)
    assert.match(output.stdout.join('\n'), /用法/)
  })

  // 回归：publish 是唯一会真写闲鱼的子命令，也曾经是唯一 `--help` 报错退出 2 的子命令
  // （validateCommandFlags 先跑，缺 --draft 直接 fail）。帮助必须在必填校验之前短路。
  it('每个子命令的 --help 都是退出码 0（含 publish）', async () => {
    for (const command of ['import-account', 'login', 'publish'] as const) {
      const { io, output } = capture()
      assert.equal(await runCli([command, '--help'], EMPTY_ENV, io), 0, command)
      assert.match(output.stdout.join('\n'), /用法/, command)
    }
  })

  it('用法错误退出码 2', async () => {
    for (const argv of [['--nope'], ['--port', 'abc'], ['--port', '65536']]) {
      const { io, output } = capture()
      assert.equal(await runCli(argv, EMPTY_ENV, io), 2, argv.join(' '))
      assert.ok(output.stderr.length > 0)
    }
  })

  it('端口已被占用 → 退出码 1 且打印可读提示（不 spawn）', async (t) => {
    const occupied = createServer((_req, res) => {
      res.end('busy')
    })
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', () => resolve())
    })
    t.after(() => new Promise<void>((resolve) => {
      occupied.close(() => resolve())
    }))
    const address = occupied.address()
    assert.ok(address !== null && typeof address !== 'string')
    await mkdir(SCRATCH_ROOT, { recursive: true })
    const dir = await mkdtemp(join(SCRATCH_ROOT, 'cli-'))
    t.after(() => rm(dir, { recursive: true, force: true }))

    const { io, output } = capture()
    assert.equal(await runCli(['--data-dir', dir, '--port', String(address.port)], EMPTY_ENV, io), 1)
    assert.match(output.stderr.join('\n'), /端口已被占用/)
  })

  it('非回环 host 拒绝启动，退出码 1', async () => {
    const { io, output } = capture()
    assert.equal(await runCli(['--host', '0.0.0.0', '--print-config'], EMPTY_ENV, io), 1)
    assert.match(output.stderr.join('\n'), /回环/)
  })
})
