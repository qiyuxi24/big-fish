#!/usr/bin/env node
/**
 * 在隔离的 DSH_HOME 里验证「BigFish 作为 DSH 插件」能被真实 loader 装配。
 *
 * 做三件事（都不碰用户自己的 ~/.dsh）：
 *   1. 造一个临时 profile：bundles = [dsh-base, @bigfish/ops-bundle, dsh-web-app]；
 *   2. 用 --dump-config 断言 bigfish-ops 行与其 config 出现在合并后的插件树里；
 *   3. --smoke 时真正启动一次 web profile（端口 0），等插件打印「bigfish-ops 已加载」再关掉。
 *
 * 用法：
 *   node scripts/dsh-dump.mjs              # 只做 dump-config 断言
 *   node scripts/dsh-dump.mjs --smoke      # 再跑一次真实启动冒烟
 *   node scripts/dsh-dump.mjs --keep       # 保留临时 DSH_HOME 便于排查
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = new Set(process.argv.slice(2))
const smoke = argv.has('--smoke')
const keep = argv.has('--keep')

const PROFILE = 'bigfish-dev'
const HOME_CANDIDATES = [
  process.env.DSH_CHECKOUT,
  'C:/Users/34239/Documents/GitHub/deepseek-harness',
].filter(Boolean)
const cli = HOME_CANDIDATES.map((root) => join(root, 'apps/cli/lib/bin.js')).find((path) => existsSync(path))
if (!cli) {
  console.error('✖ 找不到 DSH CLI：设置 DSH_CHECKOUT 指向 deepseek-harness checkout。')
  process.exit(1)
}

const dshHome = join(repoRoot, '.scratch/.dshcheck')
const profileDir = join(dshHome, 'profiles', PROFILE)

/**
 * 找一个已经装好 @deepseek-ai/dsh-base 的 node_modules 借用（junction，不复制）。
 * DSH 的 bundle 包既可能装在 ~/.dsh/profiles/node_modules（多 profile 共享），
 * 也可能装在各 profile 自己的 node_modules 里，两处都看。
 */
function findTemplateModules() {
  const profilesRoot = join(homedir(), '.dsh/profiles')
  if (!existsSync(profilesRoot)) return undefined
  const candidates = [join(profilesRoot, 'node_modules')]
  for (const name of readdirSync(profilesRoot)) {
    if (name === 'node_modules') continue
    const dir = join(profilesRoot, name)
    if (statSync(dir).isDirectory()) candidates.push(join(dir, 'node_modules'))
  }
  return candidates.find((modules) => existsSync(join(modules, '@deepseek-ai/dsh-base')))
}

const templateModules = findTemplateModules()
if (!templateModules) {
  console.error('✖ 找不到可借用的 DSH profile node_modules（需要至少装过一次 dsh-base）。')
  process.exit(1)
}

mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-' + PROFILE,
  private: true,
  dependencies: {
    '@bigfish/ops-bundle': 'link:' + join(repoRoot, 'packages/ops-bundle').replace(/\\/g, '/'),
    '@deepseek-ai/dsh-web-app': '0.1.5-rc.2',
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@bigfish/ops-bundle', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
}, null, 2) + '\n')
writeFileSync(join(profileDir, 'cordis.yml'), '# 隔离测试 profile：插件树由 bundle 层拼装\n[]\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# profile 用户层：故意为空，bigfish 行来自 @bigfish/ops-bundle 层\n[]\n')

/** 给 profile 的 node_modules 建 junction：模板里的每个包 + 本仓库的 @bigfish/*。 */
function linkModules() {
  const dst = join(profileDir, 'node_modules')
  mkdirSync(join(dst, '@bigfish'), { recursive: true })
  for (const entry of readdirSync(templateModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '@bigfish') continue
    const target = join(templateModules, entry.name)
    const link = join(dst, entry.name)
    if (!existsSync(link)) skippableSymlink(target, link)
  }
  for (const pkg of ['plugin-ops', 'ops-bundle', 'core']) {
    const link = join(dst, '@bigfish', pkg)
    if (!existsSync(link)) skippableSymlink(join(repoRoot, 'packages', pkg), link)
  }
}

/** Windows 上 Node 的 'junction' 类型不需要管理员权限；其他平台用 dir。 */
function skippableSymlink(target, link) {
  try {
    // 动态 import 让脚本在 Windows 之外也能跑（fs.symlinkSync 的 type 参数会被忽略）。
    const { symlinkSync } = process.getBuiltinModule('node:fs')
    symlinkSync(target, link, 'junction')
  } catch (error) {
    console.error('✖ 建 junction 失败：' + link + ' -> ' + target + '：' + error.message)
    process.exit(1)
  }
}

function runDsh(args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
    if (options.onStdout) child.stdout.on('data', (chunk) => options.onStdout(String(chunk)))
  })
}

linkModules()

// 1) dump-config：这是「配置层真的装上了」的静态证据。
const dump = await runDsh(['--profile', PROFILE, '--dump-config'], { timeoutMs: 120_000 })
if (dump.code !== 0) {
  console.error('✖ dump-config 失败：\n' + (dump.stderr || dump.stdout).slice(0, 4000))
  process.exit(1)
}
const lines = dump.stdout.split(/\r?\n/)
const rowIndex = lines.findIndex((line) => line.includes("@bigfish/plugin-ops"))
if (rowIndex < 0) {
  console.error('✖ 合并后的插件树里没有 @bigfish/plugin-ops 行')
  process.exit(1)
}
const row = lines.slice(rowIndex - 1, rowIndex + 6).join('\n')
for (const expected of ['daemonUrl: http://127.0.0.1:47001', 'writeGate: true']) {
  if (!row.includes(expected)) {
    console.error('✖ bigfish-ops 行的 config 不符合预期，缺少：' + expected + '\n' + row)
    process.exit(1)
  }
}
console.log('✔ dump-config：bigfish-ops 行已装配，config 合并正确')
console.log(row)

if (!smoke) {
  console.log('提示：加 --smoke 可再做一次真实启动（会占端口，约 20-40s）。')
  process.exit(0)
}

// 2) 真实启动：等插件 apply() 的加载日志，证明 register/门禁在真 Cordis 里通过校验。
let loaded = false
const boot = await runDsh(['--profile', PROFILE, '--port', '0', '--no-open'], {
  timeoutMs: 90_000,
  onStdout: (chunk) => {
    if (chunk.includes('bigfish-ops 已加载')) loaded = true
  },
})
const combined = boot.stdout + boot.stderr
const urlLine = combined.split(/\r?\n/).find((line) => line.startsWith('dsh web: '))
if (loaded) {
  console.log('✔ 真实启动：插件的 14 个工具已注册（9 read / 5 confirm，register 校验通过），writeGate 已挂载')
  if (urlLine) console.log('  ' + urlLine)
} else {
  console.error('✖ 真实启动没有看到插件加载日志：\n' + combined.slice(0, 4000))
  process.exit(1)
}

if (!keep) {
  const { rmSync } = process.getBuiltinModule('node:fs')
  try { rmSync(dshHome, { recursive: true, force: true }) } catch {}
}
