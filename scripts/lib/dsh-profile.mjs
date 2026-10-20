/**
 * 隔离 DSH_HOME + profile 的准备工作（dsh-dump.mjs 与 dsh-dev.mjs 共用）。
 *
 * 只碰 `.scratch/.dshcheck` / `.scratch/.dshdev`，绝不改用户的 ~/.dsh：
 * - profile 的 bundles 里插入 @bigfish/ops-bundle，从而装配 @bigfish/plugin-ops；
 * - node_modules 用 junction 借用本机已装好的 @deepseek-ai/*，并把本仓 @bigfish/* 链进去。
 *
 * @module scripts/lib/dsh-profile
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本仓 dev profile 的名字。 */
export const DEV_PROFILE = 'bigfish-dev'

/** 默认 bundle 栈：base 提供核心服务，ops-bundle 插入插件行，web-app 提供 GUI 与 client 模块系统。 */
export const DEV_BUNDLES = ['@deepseek-ai/dsh-base', '@bigfish/ops-bundle', '@deepseek-ai/dsh-web-app']

/**
 * 定位 DSH CLI。
 * @returns {{cli: string, checkout: string}} bin 路径与 checkout 根。
 */
export function resolveCli() {
  const candidates = [process.env.DSH_CHECKOUT, 'C:/Users/34239/Documents/GitHub/deepseek-harness'].filter(Boolean)
  for (const checkout of candidates) {
    const cli = join(checkout, 'apps/cli/lib/bin.js')
    if (existsSync(cli)) return { cli, checkout }
  }
  throw new Error('找不到 DSH CLI：设置 DSH_CHECKOUT 指向 deepseek-harness checkout。')
}

/**
 * 找一个已经装好 @deepseek-ai/dsh-base 的 node_modules 借用（junction，不复制）。
 * @returns {string} node_modules 绝对路径。
 */
export function findTemplateModules() {
  const profilesRoot = join(homedir(), '.dsh/profiles')
  if (!existsSync(profilesRoot)) throw new Error('找不到 ~/.dsh/profiles：先在本机装过一次 DSH profile。')
  const candidates = [join(profilesRoot, 'node_modules')]
  for (const name of readdirSync(profilesRoot)) {
    if (name === 'node_modules') continue
    const dir = join(profilesRoot, name)
    if (statSync(dir).isDirectory()) candidates.push(join(dir, 'node_modules'))
  }
  const found = candidates.find((modules) => existsSync(join(modules, '@deepseek-ai/dsh-base')))
  if (found === undefined) throw new Error('找不到可借用的 profile node_modules（需要至少装过一次 dsh-base）。')
  return found
}

/** Windows 上 junction 不需要管理员权限；其他平台用 dir。 */
function link(target, path) {
  try {
    symlinkSync(target, path, 'junction')
  } catch (error) {
    throw new Error(`建 junction 失败：${path} -> ${target}：${error.message}`)
  }
}

/**
 * 准备（或复用）一个隔离 profile。
 *
 * @param {{repoRoot: string, dshHome: string, profile?: string, bundles?: string[]}} options - 位置与 bundle 栈。
 * @returns {{dshHome: string, profileDir: string, cli: string}} 可直接交给 spawn 的信息。
 */
export function ensureProfile({ repoRoot, dshHome, profile = DEV_PROFILE, bundles = DEV_BUNDLES }) {
  const { cli } = resolveCli()
  const templateModules = findTemplateModules()
  const profileDir = join(dshHome, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + profile,
    private: true,
    dependencies: {
      '@bigfish/ops-bundle': 'link:' + join(repoRoot, 'packages/ops-bundle').replace(/\\/g, '/'),
      '@deepseek-ai/dsh-web-app': '0.1.5-rc.2',
    },
    dsh: { profile: { bundles, patchReload: 'live' } },
  }, null, 2) + '\n')
  writeFileSync(join(profileDir, 'cordis.yml'), '# 隔离测试 profile：插件树由 bundle 层拼装\n[]\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# profile 用户层：故意为空，bigfish 行来自 @bigfish/ops-bundle 层\n[]\n')
  const dst = join(profileDir, 'node_modules')
  mkdirSync(join(dst, '@bigfish'), { recursive: true })
  for (const entry of readdirSync(templateModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '@bigfish') continue
    const path = join(dst, entry.name)
    if (!existsSync(path)) link(join(templateModules, entry.name), path)
  }
  for (const pkg of ['plugin-ops', 'ops-bundle', 'core']) {
    const path = join(dst, '@bigfish', pkg)
    if (!existsSync(path)) link(join(repoRoot, 'packages', pkg), path)
  }
  return { dshHome, profileDir, cli }
}

/**
 * 跑一次 DSH CLI 并等它退出。
 *
 * @param {{cli: string, dshHome: string, repoRoot: string}} target - ensureProfile 的结果。
 * @param {string[]} args - CLI 参数。
 * @param {{timeoutMs?: number, onStdout?: (chunk: string) => void}} [options] - 超时与流式回调。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 退出码与输出。
 */
export function runDsh(target, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [target.cli, ...args], {
      cwd: target.repoRoot,
      env: { ...process.env, DSH_HOME: target.dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      options.onStdout?.(text)
    })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill(), options.timeoutMs)
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}
