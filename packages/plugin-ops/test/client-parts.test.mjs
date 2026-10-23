/**
 * client bundle 的拆分守护：片段有界、产物与片段同步。
 *
 * 为什么要有这个测试：宿主只按 `exports["./client"]` 读单个文件，client.js 必须由
 * src/client-bundle/*.part.js 拼出来（scripts/build-client.mjs）。一旦有人直接改了产物
 * 或改了片段忘记重建，面板就会跑在「与源码不一致」的代码上，且肉眼不可见。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const partsDir = join(packageRoot, 'src', 'client-bundle')
const bundlePath = join(packageRoot, 'client.js')

/** AGENTS §3：文件 ≤ 400 行（client bundle 曾靠例外条款撑到 1200，拆分后回到通用上限）。 */
const MAX_PART_LINES = 400

function readParts() {
  return readdirSync(partsDir)
    .filter((name) => name.endsWith('.part.js'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(partsDir, name), 'utf8') }))
}

test('片段目录非空，且按文件名排序后能拼出完整 bundle', () => {
  const parts = readParts()
  assert.ok(parts.length >= 2, '只有一个片段等于没拆')
  // loader 头尾必须在首末两个片段里，否则拼出来的不是合法 bundle。
  assert.match(parts[0].text, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(parts[parts.length - 1].text, /return \{ apply, inject: \['slots', 'connection'\] \}/)
})

test('每个片段都不超过 400 行（拆分的目的是让单文件回到通用上限）', () => {
  for (const part of readParts()) {
    const lines = part.text.split('\n').length
    assert.ok(lines <= MAX_PART_LINES, part.name + ' 有 ' + String(lines) + ' 行，超过 ' + String(MAX_PART_LINES) + '：继续拆或再分一个片段')
  }
})

test('client.js 等于片段拼接的结果（改片段后必须跑 node scripts/build-client.mjs）', () => {
  const expected = readParts().map((part) => part.text).join('')
  assert.equal(readFileSync(bundlePath, 'utf8'), expected, '产物与片段不同步：跑 node scripts/build-client.mjs')
})

test('产物首行标注是生成物，避免有人直接改它', () => {
  const firstLine = readFileSync(bundlePath, 'utf8').split('\n')[0]
  assert.match(firstLine, /生成物/)
  assert.match(firstLine, /scripts\/build-client\.mjs/)
})
