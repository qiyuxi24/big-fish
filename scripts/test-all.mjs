#!/usr/bin/env node
/**
 * 单进程测试入口。
 *
 * 为什么要这个脚本：本机沙箱禁止 spawn 子进程，`node --test` 会为每个测试文件
 * 起子进程并直接 EPERM，所以改为在一个进程里按顺序 import 所有 *.test.ts / *.test.mjs。
 * node:test 在进程内同样会打印 TAP 汇总，并在有失败时把退出码置为 1。
 *
 * 收集范围：packages/*​/test/**​/*.test.(ts|mjs|js) + integration/**​/*.test.(ts|mjs|js)
 * 用法：node scripts/test-all.mjs [相对路径前缀 ...]
 */
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const filters = process.argv.slice(2)

/** 递归收集测试文件（保持稳定排序）。 */
async function collect(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await collect(full))
    else if (entry.isFile() && /\.test\.(ts|mjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

const roots = [join(root, 'packages'), join(root, 'integration')]
let files = []
for (const dir of roots) files.push(...await collect(dir))
files = files
  .map((file) => ({ full: file, rel: relative(root, file).replaceAll('\\', '/') }))
  .filter(({ rel }) => filters.length === 0 || filters.some((f) => rel.startsWith(f.replace(/^\/+/, ''))))
  .map(({ full }) => full)
files = [...new Set(files)].sort()

if (files.length === 0) {
  console.error('test-all: 没找到任何测试文件（先按路径过滤？）')
  process.exit(1)
}

console.log(`test-all: 顺序加载 ${files.length} 个测试文件`)
for (const file of files) {
  const rel = relative(root, file).replaceAll('\\', '/')
  try {
    await import(pathToFileURL(file).href)
    console.log(`  loaded ${rel}`)
  } catch (error) {
    console.error(`  FAILED to load ${rel}`)
    console.error(error)
    process.exitCode = 1
  }
}
