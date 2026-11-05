import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BUNDLE_PUB_NAME,
  BUNDLE_SRC_NAME,
  PLUGIN_PUB_NAME,
  PLUGIN_SRC_NAME,
  REPO_URL,
  buildPublish,
  rewriteText,
} from './build-publish.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, '.scratch', 'publish-test')

function read(file) {
  return readFileSync(file, 'utf8')
}

test('rewriteText：两个包名逐字替换，且互不影响', () => {
  const text = `${PLUGIN_SRC_NAME} 依赖 ${BUNDLE_SRC_NAME}，还有 ${PLUGIN_SRC_NAME} 一次`
  const out = rewriteText(text)
  assert.equal(out, `${PLUGIN_PUB_NAME} 依赖 ${BUNDLE_PUB_NAME}，还有 ${PLUGIN_PUB_NAME} 一次`)
  assert.equal(rewriteText(''), '')
})

test('版本号非法时 fail loud', () => {
  for (const bad of [undefined, '', '0.1', 'v0.1.0', '0.1.0.0', 'latest']) {
    assert.throws(() => buildPublish({ version: bad, outDir }), /版本号不合法/)
  }
})

test('buildPublish：生成自洽的双包快照', () => {
  const summary = buildPublish({ version: '0.1.0', outDir })
  assert.equal(summary.version, '0.1.0')
  assert.equal(summary.plugin.name, PLUGIN_PUB_NAME)
  assert.equal(summary.bundle.name, BUNDLE_PUB_NAME)

  const pluginPkg = JSON.parse(read(join(summary.plugin.dir, 'package.json')))
  const bundlePkg = JSON.parse(read(join(summary.bundle.dir, 'package.json')))

  // 身份与版本
  assert.equal(pluginPkg.name, PLUGIN_PUB_NAME)
  assert.equal(bundlePkg.name, BUNDLE_PUB_NAME)
  assert.equal(pluginPkg.version, '0.1.0')
  assert.equal(bundlePkg.version, '0.1.0')
  assert.equal('private' in pluginPkg, false)
  assert.equal('private' in bundlePkg, false)

  // 发布元数据
  for (const pkg of [pluginPkg, bundlePkg]) {
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.repository.type, 'git')
    assert.equal(pkg.repository.url, REPO_URL)
    assert.deepEqual(pkg.publishConfig, { access: 'public' })
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0)
  }
  assert.deepEqual(pluginPkg.files, ['index.js', 'client.js', 'cordis.patch.yml', 'src'])
  assert.deepEqual(bundlePkg.files, ['index.js', 'cordis.patch.yml'])

  // bundle 依赖从 workspace:* 转成真实版本号
  assert.deepEqual(bundlePkg.dependencies, { [PLUGIN_PUB_NAME]: '0.1.0' })
  assert.equal('workspace:*' in (bundlePkg.dependencies ?? {}), false)

  // 源码里的运行时身份也一起改
  assert.match(read(join(summary.plugin.dir, 'client.js')), /id: 'bigfish-plugin-ops'/)
  assert.match(read(join(summary.plugin.dir, 'index.js')), /export const version = '0\.1\.0'/)
  assert.match(read(join(summary.bundle.dir, 'cordis.patch.yml')), /name: "bigfish-plugin-ops"/)

  // 每个包各自带 LICENSE 与 README
  for (const dir of [summary.plugin.dir, summary.bundle.dir]) {
    assert.ok(existsSync(join(dir, 'LICENSE')))
    assert.ok(existsSync(join(dir, 'README.md')))
  }
})

test('buildPublish：快照里不残留任何 @bigfish 包名', () => {
  const summary = buildPublish({ version: '1.2.3-beta.1', outDir })
  const leftovers = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(js|mjs|cjs|ts|json|yml|yaml|md|txt)$/.test(e.name)) {
        const text = read(full)
        if (text.includes(PLUGIN_SRC_NAME) || text.includes(BUNDLE_SRC_NAME)) leftovers.push(full)
      }
    }
  }
  walk(summary.plugin.dir)
  walk(summary.bundle.dir)
  assert.deepEqual(leftovers, [], `快照里残留旧包名：${leftovers.join(', ')}`)
})

test('buildPublish 可被 import 而不触发 CLI（pathToFileURL 守卫）', async () => {
  // 本文件 import 了 build-publish.mjs；若守卫写错，import 时会因缺版本号直接抛错。
  // 能执行到这里就说明守卫成立。
  const mod = await import(pathToFileURL(join(root, 'scripts', 'build-publish.mjs')).href)
  assert.equal(typeof mod.buildPublish, 'function')
  assert.equal(typeof mod.rewriteText, 'function')
})
