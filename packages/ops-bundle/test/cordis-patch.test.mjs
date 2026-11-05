/**
 * ops-bundle 装配层（cordis.patch.yml）的静态契约回归。
 *
 * 为什么需要：scripts/dsh-dump.mjs 的 --dump-config 断言依赖 spawn 起真实 dsh CLI，
 * 而本沙箱禁止 spawn（AGENTS.md §5 / §7.11），那条命令在这里跑不起来。
 * 这里用纯文本断言把「三 key 全重述 + enabled 默认开」钉住，补上能在本仓验证的那一半。
 * @module @bigfish/ops-bundle/test/cordis-patch
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')

test('bigfish-ops 行的 config 必须重述全部 key（整段替换语义）', () => {
  assert.match(source, /id: bigfish-ops/)
  assert.match(source, /name: "@bigfish\/plugin-ops"/)
  assert.match(source, /daemonUrl: "http:\/\/127\.0\.0\.1:47001"/)
  assert.match(source, /writeGate: true/)
  assert.match(source, /enabled: true/)
})

test('enabled 是装配层硬开关，注释要说清与运行时软开关不互相覆盖', () => {
  assert.match(source, /enabled 是装配层硬开关/)
  assert.match(source, /两层互不覆盖/)
})

test('package.json 声明了 dsh.bundle.patch 指向本文件', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})
