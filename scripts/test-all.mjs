#!/usr/bin/env node
/**
 * 单进程测试入口。
 *
 * 为什么要这个脚本：本机沙箱禁止 spawn 子进程，`node --test` 会为每个测试文件
 * 起子进程并直接 EPERM，所以改为在一个进程里按顺序 import 所有 *.test.ts / *.test.mjs。
 * node:test 在进程内同样会打印 TAP 汇总，并在有失败时把退出码置为 1。
 *
 * 收集范围：packages/*​/test/**​/*.test.(ts|mjs|js) + integration/**​/*.test.(ts|mjs|js)
 *          + scripts/**​/*.test.(ts|mjs|js)（tools 脚本的纯函数单测也纳入全量）
 * 用法：node scripts/test-all.mjs [相对路径前缀 ...]
 */
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const filters = process.argv.slice(2)

/**
 * 给被测代码一个「现在跑在单测里」的确定信号。
 *
 * 为什么要它：`node:test` 在单进程 import 模式下不设 `NODE_TEST_CONTEXT`（实测 undefined），
 * 于是生产代码没法判断自己是不是在被测。后果见 2026-10-27 的假绿事故：三条 `loginAndSave`
 * 用例忘了注入 `ensureBrowser`，落到默认实现真的去 `launchChrome`（还用真人 profile），
 * 端口没监听时白等 30s 再报 NETWORK，同一份代码在不同机器上红绿不同、全量从 22s 变 112s。
 *
 * 现在被测代码可以据此把「默认真实 IO」换成立即报错，把 30s 的静默挂起换成一行可读的断言失败。
 */
process.env.BF_TEST_ALL = '1'

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

const roots = [join(root, 'packages'), join(root, 'integration'), join(root, 'scripts')]
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
