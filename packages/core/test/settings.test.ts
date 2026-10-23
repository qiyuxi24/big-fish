import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { XianyuError } from '../src/errors.ts'
import {
  COPY_STYLES,
  DEFAULT_SETTINGS,
  KEEPALIVE_INTERVAL_RANGE,
  MAX_BATCH_ITEMS_RANGE,
  PUBLISH_MIN_INTERVAL_RANGE,
  mergeSettings,
  parseSettingsPatch,
  readSettingsFile,
  writeSettingsFile,
} from '../src/settings.ts'
import type { Settings } from '../src/settings.ts'

const scratchRoot = fileURLToPath(new URL('../../../.scratch/', import.meta.url))
let workDir = ''
let dirSeq = 0

before(async () => {
  await mkdir(scratchRoot, { recursive: true })
  workDir = await mkdtemp(join(scratchRoot, 'core-settings-'))
})

after(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function dirIn(name: string): string {
  dirSeq += 1
  return join(workDir, String(dirSeq) + '-' + name)
}

function validationError(error: unknown): boolean {
  assert.ok(error instanceof XianyuError, '应抛 XianyuError')
  assert.equal(error.code, 'VALIDATION')
  return true
}

function storageError(error: unknown): boolean {
  assert.ok(error instanceof XianyuError, '应抛 XianyuError')
  assert.equal(error.code, 'STORAGE')
  return true
}

test('DEFAULT_SETTINGS 是文档化的默认值，且未被冻结以外的共享对象污染', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    copyStyle: 'plain',
    defaultCategory: '',
    defaultAddress: '',
    shipping: 'free',
    publishMinIntervalMs: 180_000,
    maxBatchItems: 20,
    activeAccountId: '',
    keepAliveEnabled: false,
    keepAliveIntervalMs: 300_000,
    imageProvider: { endpointUrl: '', model: '', enabled: false },
  })
  assert.deepEqual(COPY_STYLES, ['plain', 'warm', 'professional', 'urgent', 'story'])
  assert.deepEqual(PUBLISH_MIN_INTERVAL_RANGE, { min: 30_000, max: 3_600_000 })
  assert.deepEqual(MAX_BATCH_ITEMS_RANGE, { min: 1, max: 20 })
  assert.deepEqual(KEEPALIVE_INTERVAL_RANGE, { min: 60_000, max: 3_600_000 })
})

test('parseSettingsPatch 窄化合法字段，未知字段与 undefined 被忽略', () => {
  const patch = parseSettingsPatch({
    copyStyle: 'warm',
    shipping: 'none',
    defaultCategory: '  电子资料  ',
    defaultAddress: ' 西安市  ',
    publishMinIntervalMs: 90_000,
    maxBatchItems: 5,
    imageProvider: { endpointUrl: 'https://img.local/v1', model: 'flux', enabled: true },
    activeAccountId: '  2206569289277  ',
    keepAliveEnabled: true,
    keepAliveIntervalMs: 600_000,
    legacyField: 'ignored',
    anotherLegacy: 42,
    copyStyleUndefined: undefined,
    maxBatchItemsUndefined: undefined,
  })
  assert.deepEqual(patch, {
    copyStyle: 'warm',
    shipping: 'none',
    defaultCategory: '电子资料',
    defaultAddress: '西安市',
    publishMinIntervalMs: 90_000,
    maxBatchItems: 5,
    activeAccountId: '2206569289277',
    keepAliveEnabled: true,
    keepAliveIntervalMs: 600_000,
    imageProvider: { endpointUrl: 'https://img.local/v1', model: 'flux', enabled: true },
  })
  // 输入对象不被改写
  const input = { copyStyle: 'warm' }
  parseSettingsPatch(input)
  assert.deepEqual(input, { copyStyle: 'warm' })
})

test('parseSettingsPatch 类型错一律 VALIDATION', () => {
  for (const bad of [
    null,
    [],
    'settings',
    42,
    { copyStyle: 'loud' },
    { copyStyle: 1 },
    { shipping: 'paid' },
    { defaultCategory: 1 },
    { defaultAddress: false },
    { publishMinIntervalMs: '180000' },
    { publishMinIntervalMs: 30_000.5 },
    { maxBatchItems: null },
    { imageProvider: 'https://img.local' },
    { imageProvider: [] },
    { imageProvider: { endpointUrl: 1 } },
    { imageProvider: { model: false } },
    { imageProvider: { enabled: 'yes' } },
    { activeAccountId: 42 },
    { activeAccountId: 'bad id' },
    { activeAccountId: '../escape' },
    { keepAliveEnabled: 'yes' },
    { keepAliveIntervalMs: 60_000.5 },
  ]) {
    assert.throws(() => parseSettingsPatch(bad), validationError)
  }
})

test('数值字段夹取到允许范围（不报错）', () => {
  const low = parseSettingsPatch({ publishMinIntervalMs: 1, maxBatchItems: 0, keepAliveIntervalMs: 1 })
  assert.equal(low.publishMinIntervalMs, 30_000)
  assert.equal(low.maxBatchItems, 1)
  assert.equal(low.keepAliveIntervalMs, 60_000)
  const high = parseSettingsPatch({ publishMinIntervalMs: 99_999_999, maxBatchItems: 99, keepAliveIntervalMs: 99_999_999 })
  assert.equal(high.publishMinIntervalMs, 3_600_000)
  assert.equal(high.maxBatchItems, 20)
  assert.equal(high.keepAliveIntervalMs, 3_600_000)
})

test('activeAccountId 允许空串（未选中），非空必须是账号 id 白名单', () => {
  assert.equal(parseSettingsPatch({ activeAccountId: '' }).activeAccountId, '')
  assert.equal(parseSettingsPatch({ activeAccountId: '2206569289277' }).activeAccountId, '2206569289277')
  assert.throws(() => parseSettingsPatch({ activeAccountId: 'a b' }), validationError)
  assert.throws(() => parseSettingsPatch({ activeAccountId: '..' }), validationError)
})

test('mergeSettings 深合并 imageProvider，且不修改 base', () => {
  const base: Settings = {
    ...DEFAULT_SETTINGS,
    copyStyle: 'urgent',
    defaultCategory: '电子资料',
    imageProvider: { endpointUrl: 'https://img.local/v1', model: 'flux', enabled: true },
  }
  const snapshot: Settings = structuredClone(base)
  const merged = mergeSettings(base, {
    copyStyle: 'story',
    imageProvider: { enabled: false },
  })
  assert.equal(merged.copyStyle, 'story')
  assert.equal(merged.defaultCategory, '电子资料')
  assert.equal(merged.imageProvider.endpointUrl, 'https://img.local/v1')
  assert.equal(merged.imageProvider.model, 'flux')
  assert.equal(merged.imageProvider.enabled, false)
  assert.deepEqual(base, snapshot, 'base 不能被原地修改')
  // 空补丁返回一份全新的等价设置
  const copy = mergeSettings(base, {})
  assert.deepEqual(copy, base)
  assert.notEqual(copy, base)
  assert.notEqual(copy.imageProvider, base.imageProvider)
})

test('readSettingsFile：文件不存在返回默认值副本', async () => {
  const path = join(dirIn('missing'), 'settings.json')
  const settings = await readSettingsFile(path)
  assert.deepEqual(settings, DEFAULT_SETTINGS)
  settings.copyStyle = 'story'
  settings.imageProvider.enabled = true
  assert.deepEqual(DEFAULT_SETTINGS, {
    copyStyle: 'plain',
    defaultCategory: '',
    defaultAddress: '',
    shipping: 'free',
    publishMinIntervalMs: 180_000,
    maxBatchItems: 20,
    activeAccountId: '',
    keepAliveEnabled: false,
    keepAliveIntervalMs: 300_000,
    imageProvider: { endpointUrl: '', model: '', enabled: false },
  })
})

test('readSettingsFile：部分字段文件用默认值补齐', async () => {
  const dir = dirIn('partial')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'settings.json')
  await writeFile(path, JSON.stringify({ copyStyle: 'warm', imageProvider: { enabled: true } }), 'utf8')
  const settings = await readSettingsFile(path)
  assert.equal(settings.copyStyle, 'warm')
  assert.equal(settings.shipping, 'free')
  assert.equal(settings.publishMinIntervalMs, 180_000)
  assert.deepEqual(settings.imageProvider, { endpointUrl: '', model: '', enabled: true })
})

test('readSettingsFile：非法 JSON / 非法字段是 STORAGE（不能静默回落默认值）', async () => {
  const brokenDir = dirIn('broken')
  await mkdir(brokenDir, { recursive: true })
  const broken = join(brokenDir, 'settings.json')
  await writeFile(broken, '{ not json', 'utf8')
  await assert.rejects(readSettingsFile(broken), storageError)

  const invalidDir = dirIn('invalid')
  await mkdir(invalidDir, { recursive: true })
  const invalid = join(invalidDir, 'settings.json')
  await writeFile(invalid, JSON.stringify({ copyStyle: 'loud' }), 'utf8')
  await assert.rejects(readSettingsFile(invalid), storageError)

  const notObject = join(invalidDir, 'array.json')
  await writeFile(notObject, '[]', 'utf8')
  await assert.rejects(readSettingsFile(notObject), storageError)
})

test('writeSettingsFile 写入后再读回一致，父目录自动创建，且不留临时文件', async () => {
  const dir = dirIn('roundtrip')
  const path = join(dir, 'nested', 'settings.json')
  const settings: Settings = {
    copyStyle: 'professional',
    defaultCategory: '学习笔记',
    defaultAddress: '西安市长安区',
    shipping: 'none',
    publishMinIntervalMs: 120_000,
    maxBatchItems: 8,
    activeAccountId: '2206569289277',
    keepAliveEnabled: true,
    keepAliveIntervalMs: 120_000,
    imageProvider: { endpointUrl: 'https://img.local/v1', model: 'flux-1', enabled: true },
  }
  await writeSettingsFile(path, settings)
  assert.deepEqual(await readSettingsFile(path), settings)
  assert.deepEqual(await readdir(join(dir, 'nested')), ['settings.json'])
  const text = await readFile(path, 'utf8')
  assert.ok(text.endsWith('\n'))
  assert.deepEqual(JSON.parse(text), settings)
})

test('writeSettingsFile 落盘前夹取数值、丢掉未知字段', async () => {
  const path = join(dirIn('normalize'), 'settings.json')
  const dirty = { ...DEFAULT_SETTINGS, publishMinIntervalMs: 1, maxBatchItems: 1_000, legacy: 'x' } as unknown as Settings
  await writeSettingsFile(path, dirty)
  const settings = await readSettingsFile(path)
  assert.equal(settings.publishMinIntervalMs, 30_000)
  assert.equal(settings.maxBatchItems, 20)
  assert.equal((settings as unknown as Record<string, unknown>)['legacy'], undefined)
})

test('writeSettingsFile 失败时抛 STORAGE 并清理临时文件', async () => {
  const dir = dirIn('rename-fail')
  await mkdir(dir, { recursive: true })
  // 目标是已存在的目录：writeFile 到临时名能成功，rename 到目录会失败。
  const target = join(dir, 'settings.json')
  await mkdir(target)
  await assert.rejects(writeSettingsFile(target, DEFAULT_SETTINGS), storageError)
  const leftovers = (await readdir(dir)).filter((name) => name !== 'settings.json')
  assert.deepEqual(leftovers, [])
})

test('空路径是 VALIDATION，不是 STORAGE', async () => {
  await assert.rejects(readSettingsFile('   '), validationError)
  await assert.rejects(writeSettingsFile('', DEFAULT_SETTINGS), validationError)
})
