#!/usr/bin/env node
/**
 * 把 @bigfish/ops-bundle 装进**你自己的** DSH profile（默认 desktop），让侧边栏
 * 「BigFish 闲鱼运营」出现在日常使用的 DSH 里；之后改 client.js 由 dsh-client-hmr
 * stat-poll 热替换，不用重启、不用刷新页面。
 *
 * 为什么不用 `dsh plugin --profile desktop add`：本仓是 pnpm workspace，
 * ops-bundle 依赖 `@bigfish/plugin-ops: workspace:*`，profile 侧 pnpm 解析不了
 * workspace 协议（离线环境也会 ERR_PNPM_NO_OFFLINE_META）。这里走等价但可控的做法：
 * 写 profile 的 dependencies/bundles + 在 profile 的 node_modules/@bigfish 下建 junction。
 *
 * 用法：
 *   node scripts/dsh-install.mjs                     # 装进 ~/.dsh/profiles/desktop
 *   node scripts/dsh-install.mjs --profile web       # 装进别的 profile
 *   node scripts/dsh-install.mjs --dry-run           # 只打印将要做的改动
 *   node scripts/dsh-install.mjs --uninstall         # 撤销（保留 .bak）
 *
 * 装完要**重启一次 DSH 桌面应用**（bundle 列表在启动时读取）；之后改 client.js 不用重启。
 */
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const dshHome = valueOf('--home', join(homedir(), '.dsh'))
const profileName = valueOf('--profile', 'desktop')
const profileDir = join(dshHome, 'profiles', profileName)
const packagePath = join(profileDir, 'package.json')
const bundleName = '@bigfish/ops-bundle'
const pluginName = '@bigfish/plugin-ops'
const dryRun = has('--dry-run')
const uninstall = has('--uninstall')

/** 本仓包目录（junction 目标）。 */
const packages = {
  [bundleName]: join(repoRoot, 'packages/ops-bundle'),
  [pluginName]: join(repoRoot, 'packages/plugin-ops'),
}

/** 把绝对路径写成 pnpm 能接受的 link: 形式（正斜杠）。 */
const linkOf = (path) => 'link:' + path.replace(/\\/g, '/')

function fail(message) {
  console.error('✖ ' + message)
  process.exitCode = 1
  throw new Error(message)
}

if (!existsSync(packagePath)) fail('找不到 profile：' + packagePath + '（先用 --profile/--home 指定）')
if (!existsSync(packages[bundleName]) || !existsSync(packages[pluginName])) fail('找不到本仓 packages/ops-bundle 或 packages/plugin-ops')

const original = readFileSync(packagePath, 'utf8')
const json = JSON.parse(original)
json.dependencies = json.dependencies ?? {}
json.dsh = json.dsh ?? {}
json.dsh.profile = json.dsh.profile ?? {}
const bundles = Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : (json.dsh.profile.bundles = [])

const changes = []

if (uninstall) {
  if (json.dependencies[bundleName] !== undefined) {
    delete json.dependencies[bundleName]
    changes.push('从 dependencies 移除 ' + bundleName)
  }
  const index = bundles.indexOf(bundleName)
  if (index >= 0) {
    bundles.splice(index, 1)
    changes.push('从 dsh.profile.bundles 移除 ' + bundleName)
  }
} else {
  if (json.dependencies[bundleName] === undefined) {
    json.dependencies[bundleName] = linkOf(packages[bundleName])
    changes.push('dependencies 增加 ' + bundleName + ' → ' + json.dependencies[bundleName])
  }
  if (!bundles.includes(bundleName)) {
    // 插在 web-app 之前：base → 我们的 bundle → web-app（client 模块系统最后装配）
    const webApp = bundles.indexOf('@deepseek-ai/dsh-web-app')
    if (webApp >= 0) bundles.splice(webApp, 0, bundleName)
    else bundles.push(bundleName)
    changes.push('dsh.profile.bundles 插入 ' + bundleName)
  }
}

console.log('profile：' + packagePath)
console.log('模式：' + (uninstall ? '卸载' : '安装') + (dryRun ? '（dry-run）' : ''))

// junction：profile 的 node_modules/@bigfish/<pkg> → 本仓 packages/<pkg>
const modulesDir = join(profileDir, 'node_modules')
const scopeDir = join(modulesDir, '@bigfish')
const junctions = []

if (!uninstall) {
  for (const [name, target] of Object.entries(packages)) {
    const path = join(scopeDir, name.slice('@bigfish/'.length))
    if (existsSync(path)) {
      let linked = false
      try { linked = statSync(path).isDirectory() || statSync(path).isSymbolicLink() } catch {}
      if (!linked) fail('已存在同名文件但不是目录：' + path)
      junctions.push({ path, action: '复用已有链接' })
      continue
    }
    junctions.push({ path, action: '建 junction', target })
  }
}

if (changes.length === 0 && junctions.every((j) => j.action !== '建 junction')) {
  console.log('✔ 已经是目标状态，无需改动')
} else {
  if (!dryRun) {
    if (uninstall) {
      for (const job of junctions) {
        try { unlinkSync(job.path) } catch {}
      }
      // 卸载时把 @bigfish 下剩余的链接也清掉（只删本脚本建的）
      for (const name of [bundleName, pluginName]) {
        const path = join(scopeDir, name.slice('@bigfish/'.length))
        try { unlinkSync(path) } catch {}
      }
    } else {
      const backup = packagePath + '.bak-bigfish-' + String(Date.now())
      writeFileSync(backup, original)
      console.log('  备份：' + backup)
      writeFileSync(packagePath, JSON.stringify(json, null, 2) + '\n')
      mkdirSync(scopeDir, { recursive: true })
      for (const job of junctions) {
        if (job.action === '建 junction') {
          try {
            symlinkSync(job.target, job.path, 'junction')
          } catch (error) {
            fail('建 junction 失败：' + job.path + '：' + error.message)
          }
        }
      }
    }
  }
}

for (const change of changes) console.log('  · ' + change)
for (const job of junctions) console.log('  · ' + job.action + '：' + job.path)

if (dryRun) {
  console.log('（dry-run，未写盘）')
  process.exitCode = 0
} else if (uninstall) {
  console.log('✔ 已卸载。重启 DSH 后生效。')
} else {
  console.log('')
  console.log('下一步：')
  console.log('  1. 完全退出并重开 DSH 桌面应用（bundle 列表只在启动时读取）');
  console.log('  2. 左侧应出现「BigFish 闲鱼运营」（🐟）栏位，点开即面板');
  console.log('  3. 之后改 packages/plugin-ops/client.js：不重启、不刷新页面，面板自动换新版');
  console.log('  4. 撤销：node scripts/dsh-install.mjs --uninstall');
}
