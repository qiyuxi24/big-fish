import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as sdk from '../src/index.ts'

const SRC_DIR = join(import.meta.dirname, '..', 'src')

async function sourceFiles(): Promise<Array<{ name: string; text: string }>> {
  const names = (await readdir(SRC_DIR)).filter((name) => name.endsWith('.ts')).sort()
  const files: Array<{ name: string; text: string }> = []
  for (const name of names) files.push({ name, text: await readFile(join(SRC_DIR, name), 'utf8') })
  return files
}

test('包内不引入 playwright / puppeteer 等重依赖', async () => {
  for (const file of await sourceFiles()) {
    assert.equal(/playwright|puppeteer|puppeteer-core/i.test(file.text), false, file.name + ' 出现了重依赖')
  }
})

test('child_process 只允许出现在 launch.ts（spawn Chrome）', async () => {
  const offenders: string[] = []
  for (const file of await sourceFiles()) {
    if (file.name !== 'launch.ts' && /child_process/.test(file.text)) offenders.push(file.name)
  }
  assert.deepEqual(offenders, [])
})

test('barrel 导出 §4.2 契约里的公共 API', () => {
  assert.equal(typeof sdk.resolveChromePath, 'function')
  assert.equal(typeof sdk.launchChrome, 'function')
  assert.equal(typeof sdk.attachChrome, 'function')
  assert.equal(typeof sdk.CdpConnection.connect, 'function')
  assert.equal(typeof sdk.CdpConnection, 'function')
  assert.equal(typeof sdk.CdpPage.open, 'function')
  assert.equal(typeof sdk.CdpPage, 'function')
  assert.equal(typeof sdk.runPublishSteps, 'function')
})

test('README 说明与 scripts/lib/cdp.mjs 的关系', async () => {
  const readme = await readFile(join(import.meta.dirname, '..', 'README.md'), 'utf8')
  assert.ok(readme.includes('scripts/lib/cdp.mjs'))
})
