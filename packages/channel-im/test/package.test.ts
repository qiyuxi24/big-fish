import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sdk from '../src/index.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(packageRoot, 'src')

function readJson(name: string): unknown {
  const text = readFileSync(join(packageRoot, name), 'utf8')
  const parsed: unknown = JSON.parse(text)
  return parsed
}

test('package.json：workspace 包、exports 指向 src、运行时只依赖 core', () => {
  const pkg = readJson('package.json')
  assert.ok(sdk.isRecord(pkg))
  assert.equal(pkg['name'], '@bigfish/channel-im')
  assert.equal(pkg['type'], 'module')
  assert.equal(pkg['main'], './src/index.ts')
  assert.equal(sdk.readPath(pkg, ['exports', '.']), './src/index.ts')
  const dependencies = sdk.readPath(pkg, ['dependencies'])
  assert.ok(sdk.isRecord(dependencies))
  assert.deepEqual(Object.keys(dependencies), ['@bigfish/core'])
  assert.equal(sdk.readPath(pkg, ['devDependencies']), undefined)
})

test('barrel 导出公共 API（帧构造/解析 + 会话状态机）', () => {
  const functions = [
    'buildAckDiffFrame',
    'buildAckFrame',
    'buildHeartbeatFrame',
    'buildImTokenRequest',
    'buildRegFrame',
    'decodeBase64Json',
    'decodePushItems',
    'encodeFrame',
    'generateDeviceId',
    'generateMid',
    'isRecord',
    'parseFrameText',
    'parseImMessage',
    'parsePushMessages',
    'readInteger',
    'readPath',
    'readText',
  ]
  for (const name of functions) {
    const value: unknown = (sdk as unknown as Record<string, unknown>)[name]
    assert.equal(typeof value, 'function', name + ' 应当是函数')
  }
  assert.equal(typeof sdk.ImSession, 'function')
  assert.equal(sdk.IM_WS_URL, 'wss://wss-goofish.dingtalk.com')
  assert.equal(sdk.IM_APP_KEY, '444e9908a51d1cb236a27862abc769c9')
  assert.equal(sdk.HEARTBEAT_INTERVAL_MS, 15_000)
  assert.equal(sdk.ACK_DIFF_DELAY_MS, 1_000)
})

test('src 每个文件 ≤ 400 行（仓库硬规则）', () => {
  const files = readdirSync(srcRoot).filter((name) => name.endsWith('.ts'))
  assert.ok(files.length > 0)
  for (const name of files) {
    const text = readFileSync(join(srcRoot, name), 'utf8')
    const lines = text.split('\n').length
    assert.ok(lines <= 400, name + ' 有 ' + String(lines) + ' 行，超过 400 行上限')
  }
})

test('src 零第三方依赖、无 any', () => {
  const files = readdirSync(srcRoot).filter((name) => name.endsWith('.ts'))
  for (const name of files) {
    const text = readFileSync(join(srcRoot, name), 'utf8')
    const pattern = /from '([^']+)'/g
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? ''
      const allowed = specifier.startsWith('./') || specifier.startsWith('node:') || specifier === '@bigfish/core'
      assert.ok(allowed, name + ' 引入了不允许的模块：' + specifier)
    }
    assert.equal(/\bany\b/.test(text), false, name + ' 里出现了 any')
  }
})
