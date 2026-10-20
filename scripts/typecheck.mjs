#!/usr/bin/env node
/**
 * 用本机已有的 tsc 对 TypeScript 包做 --noEmit 类型检查（不引入构建产物、不改 package.json 依赖）。
 *
 * tsc 与 @types/node 的来源按顺序探测：
 *   1. 环境变量 BF_TSC / BF_TYPES_DIR（显式指定）
 *   2. 仓库自己的 node_modules（pnpm add -D typescript @types/node 之后）
 *   3. DeepSeek Harness checkout（DSH_CHECKOUT 或默认安装路径）的 node_modules
 *
 * 用法：node scripts/typecheck.mjs [包路径前缀...]
 * 退出码：0 全通过；1 有类型错误或找不到 tsc。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const paths = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))

/** 常见 DSH checkout 位置，按顺序尝试。 */
const CHECKOUT_CANDIDATES = [
  process.env.DSH_CHECKOUT,
  'C:/Users/34239/Documents/GitHub/deepseek-harness',
].filter(Boolean)

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? undefined
}

const tscBin = firstExisting([
  process.env.BF_TSC,
  join(repoRoot, 'node_modules/typescript/bin/tsc'),
  ...CHECKOUT_CANDIDATES.map((root) => join(root, 'node_modules/typescript/bin/tsc')),
])
const typesDir = firstExisting([
  process.env.BF_TYPES_DIR,
  join(repoRoot, 'node_modules/@types'),
  ...CHECKOUT_CANDIDATES.map((root) => join(root, 'node_modules/@types')),
])

if (!tscBin) {
  console.error('✖ 找不到 tsc：设置 BF_TSC，或在仓库 node_modules 里安装 typescript。')
  process.exit(1)
}

/** 收集 packages/* 下声明了 tsconfig.json 的包（JS 包不参与）。 */
function collectProjects() {
  const packagesDir = join(repoRoot, 'packages')
  const projects = []
  for (const name of readdirSync(packagesDir)) {
    const dir = join(packagesDir, name)
    if (!statSync(dir).isDirectory()) continue
    const tsconfig = join(dir, 'tsconfig.json')
    if (!existsSync(tsconfig)) continue
    const rel = 'packages/' + name
    if (paths.length > 0 && !paths.some((prefix) => rel.startsWith(prefix))) continue
    projects.push({ name, dir, tsconfig })
  }
  return projects
}

const projects = collectProjects()
if (projects.length === 0) {
  console.error('✖ 没有匹配的 TypeScript 包（未找到 packages/*/tsconfig.json）。')
  process.exit(1)
}

let failed = 0
for (const project of projects) {
  const args = [tscBin, '--noEmit', '--pretty', 'false', '-p', project.tsconfig]
  if (typesDir) args.push('--typeRoots', typesDir)
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' })
  // 子进程起不来（沙箱禁 spawn 时是 EPERM）不能当成类型错误吞掉，否则只看到「失败」没有诊断。
  const spawned = !result.error && result.status !== null
  const output = spawned
    ? (result.stdout ?? '') + (result.stderr ?? '')
    : 'spawn tsc 失败（不是类型错误）：' + String(result.error?.message ?? 'status=' + String(result.status))
  if (result.status === 0) {
    console.log('✔ ' + project.name + ' 类型检查通过')
    continue
  }
  failed += 1
  console.log('✖ ' + project.name + ' 类型检查失败')
  console.log(output.trim().split('\n').slice(0, 80).join('\n'))
}
process.exit(failed === 0 ? 0 : 1)
