#!/usr/bin/env node
/**
 * 生成「可发布快照」：把仓库里的 @bigfish/* 包复制成无 scope 的 npm 双包。
 *
 * 为什么不直接改仓库里的包名（决策见 docs/adr/0008-npm-publish-snapshot.md）：
 * - @bigfish 这个 npm scope 归第三方 bigfish.tv，用户账号发不进去；发布名必须是
 *   bigfish-plugin-ops / bigfish-ops-bundle（用户 2026-11-05 拍板「无 scope 双包」）。
 * - 本机 DSH profile 用 junction 装的是 @bigfish/ops-bundle / @bigfish/plugin-ops，
 *   cordis.yml 里写的也是这两个名字；client.js 的 loader id 按 AGENTS.md §4 必须等于包名。
 *   直接改源码身份会让正在运行的 profile 找不到 node_modules/bigfish-plugin-ops。
 * 所以：源码与 live profile 保持 @bigfish/* 不变，只在发布时生成一份**整体自洽**的副本。
 *
 * 快照里逐字替换 @bigfish/plugin-ops → bigfish-plugin-ops、
 * @bigfish/ops-bundle → bigfish-ops-bundle（含 client.js 的 loader id、cordis.patch.yml
 * 的 name、README、@module 注释），再补版本/许可证/repository/publishConfig、
 * 去掉 private、把 workspace:* 换成真实版本号。
 *
 * 用法：node scripts/build-publish.mjs <version> [--out <dir>]
 * 例：  node scripts/build-publish.mjs 0.1.0
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PLUGIN_SRC_NAME = '@bigfish/plugin-ops'
export const BUNDLE_SRC_NAME = '@bigfish/ops-bundle'
export const PLUGIN_PUB_NAME = 'bigfish-plugin-ops'
export const BUNDLE_PUB_NAME = 'bigfish-ops-bundle'
export const REPO_URL = 'git+https://github.com/qiyuxi24/big-fish.git'

const root = fileURLToPath(new URL('..', import.meta.url))
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml', '.md', '.txt', '.part.js'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.scratch'])

/** 逐字替换包名；这是快照保持自洽的唯一改写规则。 */
export function rewriteText(text) {
  return text
    .replaceAll(PLUGIN_SRC_NAME, PLUGIN_PUB_NAME)
    .replaceAll(BUNDLE_SRC_NAME, BUNDLE_PUB_NAME)
}

function versionArg(argv) {
  const v = argv[0]
  if (v === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) {
    throw new Error(`版本号不合法（要 x.y.z 或 x.y.z-pre）：${String(v)}`)
  }
  return v
}

function outDirArg(argv) {
  const i = argv.indexOf('--out')
  return i >= 0 && argv[i + 1] !== undefined ? resolve(argv[i + 1]) : join(root, '.scratch', 'publish')
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, visit)
    else if (entry.isFile()) visit(full)
  }
}

function rewriteAll(dir) {
  let count = 0
  walk(dir, (file) => {
    const ext = file.slice(file.lastIndexOf('.'))
    if (!TEXT_EXT.has(ext) && !file.endsWith('.part.js')) return
    const before = readFileSync(file, 'utf8')
    const after = rewriteText(before)
    if (after !== before) {
      writeFileSync(file, after, 'utf8')
      count += 1
    }
  })
  return count
}

function patchManifest(dir, { name, version, isBundle }) {
  const file = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.name = name
  pkg.version = version
  delete pkg.private
  pkg.license = 'MIT'
  pkg.repository = { type: 'git', url: REPO_URL, directory: `packages/${isBundle ? 'ops-bundle' : 'plugin-ops'}` }
  pkg.publishConfig = { access: 'public' }
  // 显式白名单：npm 打包只带运行时需要的产物，既不带 test/，也不依赖 .gitignore
  // 的兜底规则（快照目录在 .scratch/ 下，父级 .gitignore 会把它整个忽略掉）。
  pkg.files = isBundle
    ? ['index.js', 'cordis.patch.yml']
    : ['index.js', 'client.js', 'cordis.patch.yml', 'src']
  if (isBundle) {
    pkg.dependencies = { [PLUGIN_PUB_NAME]: version }
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  return pkg
}

function bumpIndexVersion(dir, version) {
  const file = join(dir, 'index.js')
  const before = readFileSync(file, 'utf8')
  const after = before.replace(/export const version = '[^']*'/, `export const version = '${version}'`)
  if (after === before) throw new Error('index.js 里没找到 export const version，快照版本没写进去')
  writeFileSync(file, after, 'utf8')
}

const PLUGIN_README = `# bigfish-plugin-ops

BigFish 运营插件（Cordis / DSH）：把本地 daemon 的队列与状态暴露成 16 个 \`xy_*\` 工具
（10 个只读、6 个写类带审批门禁），并提供侧边栏面板与「是否启用」设置卡片。

- 纯 ESM JavaScript + JSDoc，**运行期零依赖、零构建**，由 DSH 宿主直接 import。
- 不 import \`@bigfish/core\`：自带最小 \`DaemonError\` 与错误码映射，跨进程只走 HTTP。
- 关掉设置页的「是否启用」会**真反注册** 16 个工具与门禁（省掉每轮工具 schema 固定税）。
- 需要搭配 [bigfish-ops-bundle](https://www.npmjs.com/package/bigfish-ops-bundle) 或手工写
  \`cordis.patch.yml\` 才能装进 DSH profile。

## 安装

在 DSH profile 的 \`package.json\` 里加依赖，并把 \`bigfish-ops-bundle\` 放进
\`dsh.profile.bundles\`（顺序在 \`dsh-base\` 之后、web/headless 之前）。详见
[发布与安装说明](https://github.com/qiyuxi24/big-fish/blob/main/docs/publishing.md)。

## 配置

来自 \`cordis.patch.yml\` 的 \`config\`：\`daemonUrl\`（默认 \`http://127.0.0.1:47001\`）、
\`tokenPath\`、\`timeoutMs\`、\`writeGate\`、\`enabled\`。

## 许可

MIT
`

const BUNDLE_README = `# bigfish-ops-bundle

BigFish 产品 bundle：只做一件事——声明 \`dsh.bundle.patch\`，把
[bigfish-plugin-ops](https://www.npmjs.com/package/bigfish-plugin-ops) 插进 DSH profile，
并给出默认 config（\`daemonUrl\`、\`writeGate\`、\`enabled\`）。

- \`cordis.patch.yml\` 里每一行是**整段替换 config**，覆盖已有行必须重述全部 key。
- 用法：profile 的 \`dsh.profile.bundles\` 里写 \`bigfish-ops-bundle\`
  （顺序在 \`dsh-base\` 之后、web/headless 之前）。详见
  [发布与安装说明](https://github.com/qiyuxi24/big-fish/blob/main/docs/publishing.md)。

## 许可

MIT
`

/** 生成快照，返回摘要（CLI 与单测共用）。 */
export function buildPublish({ version, outDir = join(root, '.scratch', 'publish') } = {}) {
  if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`版本号不合法（要 x.y.z 或 x.y.z-pre）：${String(version)}`)
  }
  const srcPlugin = join(root, 'packages', 'plugin-ops')
  const srcBundle = join(root, 'packages', 'ops-bundle')
  const destPlugin = join(outDir, 'plugin-ops')
  const destBundle = join(outDir, 'ops-bundle')
  const license = join(root, 'LICENSE')
  if (!existsSync(license)) throw new Error('仓库根目录缺 LICENSE，无法生成快照')

  // 只删这两个确切的生成目录，不碰 .scratch 下别的东西。
  for (const dir of [destPlugin, destBundle]) rmSync(dir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const [src, dest] of [[srcPlugin, destPlugin], [srcBundle, destBundle]]) {
    cpSync(src, dest, { recursive: true, filter: (s) => !SKIP_DIRS.has(s.split(/[\\/]/).pop()) })
  }

  const rewritten = rewriteAll(destPlugin) + rewriteAll(destBundle)
  const pluginPkg = patchManifest(destPlugin, { name: PLUGIN_PUB_NAME, version, isBundle: false })
  const bundlePkg = patchManifest(destBundle, { name: BUNDLE_PUB_NAME, version, isBundle: true })
  bumpIndexVersion(destPlugin, version)

  for (const [dest, content] of [
    [join(destPlugin, 'README.md'), PLUGIN_README],
    [join(destBundle, 'README.md'), BUNDLE_README],
  ]) writeFileSync(dest, content, 'utf8')
  for (const dir of [destPlugin, destBundle]) {
    cpSync(license, join(dir, 'LICENSE'))
  }

  // 自洽性校验：三处身份必须一致，且快照里不能再残留 @bigfish 包名。
  const client = readFileSync(join(destPlugin, 'client.js'), 'utf8')
  if (!client.includes(`id: '${PLUGIN_PUB_NAME}'`)) throw new Error('client.js 的 loader id 没改成发布名')
  const bundlePatch = readFileSync(join(destBundle, 'cordis.patch.yml'), 'utf8')
  if (!bundlePatch.includes(`name: "${PLUGIN_PUB_NAME}"`)) throw new Error('ops-bundle 的 cordis.patch.yml name 没改成发布名')
  let leftovers = 0
  for (const dir of [destPlugin, destBundle]) {
    walk(dir, (file) => {
      const ext = file.slice(file.lastIndexOf('.'))
      if (!TEXT_EXT.has(ext) && !file.endsWith('.part.js')) return
      const text = readFileSync(file, 'utf8')
      if (text.includes(PLUGIN_SRC_NAME) || text.includes(BUNDLE_SRC_NAME)) leftovers += 1
    })
  }
  if (leftovers > 0) throw new Error(`快照里还有 ${leftovers} 个文件残留 @bigfish 包名`)

  return {
    version,
    outDir,
    rewritten,
    plugin: { name: pluginPkg.name, version: pluginPkg.version, dir: destPlugin },
    bundle: { name: bundlePkg.name, version: bundlePkg.version, dir: destBundle },
  }
}

function main() {
  const argv = process.argv.slice(2)
  const summary = buildPublish({ version: versionArg(argv), outDir: outDirArg(argv) })
  console.log(`✔ 发布快照已生成：${summary.outDir}`)
  console.log(`  版本 ${summary.version}，改写 ${summary.rewritten} 个文件`)
  console.log(`  ${summary.plugin.name}@${summary.plugin.version}  ${relative(root, summary.plugin.dir)}`)
  console.log(`  ${summary.bundle.name}@${summary.bundle.version}  ${relative(root, summary.bundle.dir)}`)
  console.log('  下一步：分别在这两个目录里跑 npm publish（OIDC 由 workflow 提供）')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
