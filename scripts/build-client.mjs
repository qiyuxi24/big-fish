#!/usr/bin/env node
/**
 * 把 packages/plugin-ops/src/client-bundle/*.part.js 拼成 packages/plugin-ops/client.js。
 *
 * 为什么需要这一步：宿主（DSH）按包解析 `exports["./client"]`，**一个包只读一个文件**
 * （`resolveMeta` 取单个 clientPath，boot graph 以包名为键），手写 loader 里也没有模块解析，
 * 所以「多文件开发 + 单文件交付」只能靠这个拼接器。它零第三方依赖、纯文本 concat，
 * 不改写任何一行代码——产物与片段的拼接结果必须逐字节相等（由 client-parts.test.mjs 守护）。
 *
 * 片段不是独立模块：它们是 loader factory 函数体的**连续切片**，单独打开会报语法错误，属预期。
 * 拼接顺序 = 文件名排序 = bundle 内的声明顺序。
 *
 * 用法：
 *   node scripts/build-client.mjs          生成 client.js
 *   node scripts/build-client.mjs --check  只校验产物与片段是否同步（不同步退出码 1）
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const partsDir = join(root, 'packages', 'plugin-ops', 'src', 'client-bundle')
const bundlePath = join(root, 'packages', 'plugin-ops', 'client.js')

/** 产物必须至少注册一次 loader，且 id 等于包名（宿主按 id 校验 bundle 与包的一致性）。 */
const REQUIRED_SNIPPETS = ["window.__ModuleLoader__.load({", "id: '@bigfish/plugin-ops'"]

function readParts() {
  const names = readdirSync(partsDir).filter((name) => name.endsWith('.part.js')).sort()
  if (names.length === 0) throw new Error('client-bundle 目录里没有 .part.js 片段：' + partsDir)
  return names.map((name) => ({ name, text: readFileSync(join(partsDir, name), 'utf8') }))
}

function build() {
  const parts = readParts()
  return { parts, text: parts.map((part) => part.text).join('') }
}

/** 第一个不同的行号与上下文：不同步时给人看的定位信息，不做自动修复。 */
function firstDifference(left, right) {
  const leftLines = left.split('\n')
  const rightLines = right.split('\n')
  for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return { index: index + 1, expected: leftLines[index] ?? '<EOF>', actual: rightLines[index] ?? '<EOF>' }
    }
  }
  return null
}

const checkOnly = process.argv.includes('--check')
const { parts, text } = build()

for (const snippet of REQUIRED_SNIPPETS) {
  if (!text.includes(snippet)) throw new Error('拼接结果缺少必需的 loader 片段：' + snippet)
}

const current = readFileSync(bundlePath, 'utf8')
if (current === text) {
  console.log('✔ client.js 与 ' + parts.length + ' 个片段同步（' + String(text.split('\n').length) + ' 行）')
  for (const part of parts) console.log('  ' + part.name.padEnd(22) + String(part.text.split('\n').length - 1).padStart(5) + ' 行')
  process.exit(0)
}

if (checkOnly) {
  const diff = firstDifference(text, current)
  console.error('✖ client.js 与片段不同步：' + relative(root, bundlePath) + ' 第 ' + String(diff?.index ?? '?') + ' 行')
  console.error('  片段拼接：' + String(diff?.expected ?? '').slice(0, 200))
  console.error('  现有产物：' + String(diff?.actual ?? '').slice(0, 200))
  console.error('  修：node scripts/build-client.mjs')
  process.exit(1)
}

writeFileSync(bundlePath, text)
console.log('✔ 已写入 ' + relative(root, bundlePath) + '（' + String(text.split('\n').length) + ' 行，来自 ' + parts.length + ' 个片段）')
