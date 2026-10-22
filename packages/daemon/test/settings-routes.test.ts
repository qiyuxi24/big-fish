/**
 * GET/PUT /settings 路由测试：默认值、补丁合并、非法补丁不落盘、未装配能力。
 * 设置存储用真实的 core 读写（临时目录），这样「HTTP → merge → 原子写 → 回读」是同一路径。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { DEFAULT_SETTINGS, readSettingsFile } from '@bigfish/core'

import { createHarness, dataOf, errorOf } from './harness.ts'
import { createSettingsStore } from '../src/settings.ts'

const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-settings/', import.meta.url))

/** 每个用例一个独立 settings.json；t.after 清理。 */
async function makeStore(t: { after(fn: () => Promise<void>): void }): Promise<{ path: string; store: ReturnType<typeof createSettingsStore> }> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'run-'))
  t.after(async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  })
  const path = join(dir, 'settings.json')
  return { path, store: createSettingsStore(path) }
}

describe('daemon GET/PUT /settings 路由', () => {
  it('未装配设置存储 → GET 500 UNSUPPORTED（开发态明确报错，不返回假默认值）', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({ method: 'GET', path: '/settings' })
    assert.equal(response.status, 500)
    assert.equal(errorOf(response).code, 'UNSUPPORTED')
  })

  it('未授权 → 401（设置含发布节奏，属写敏感配置）', async (t) => {
    const { store } = await makeStore(t)
    const h = await createHarness(t, { settings: store })
    const response = await h.rawRequest({ method: 'GET', path: '/settings', token: null })
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })

  it('首次 GET → DEFAULT_SETTINGS（文件不存在不报错）', async (t) => {
    const { store } = await makeStore(t)
    const h = await createHarness(t, { settings: store })
    const response = await h.rawRequest({ method: 'GET', path: '/settings' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), DEFAULT_SETTINGS)
  })

  it('PUT 补丁 → 200 返回合并后的完整设置，且落盘可回读', async (t) => {
    const { path, store } = await makeStore(t)
    const h = await createHarness(t, { settings: store })
    const response = await h.rawRequest({
      method: 'PUT',
      path: '/settings',
      body: JSON.stringify({ copyStyle: 'warm', publishMinIntervalMs: 60_000, defaultCategory: '学习笔记' }),
    })
    assert.equal(response.status, 200)
    const data = dataOf(response) as Record<string, unknown>
    assert.equal(data.copyStyle, 'warm')
    assert.equal(data.publishMinIntervalMs, 60_000)
    assert.equal(data.defaultCategory, '学习笔记')
    // 没给的字段保持默认值，不是被清空。
    assert.equal(data.shipping, DEFAULT_SETTINGS.shipping)
    assert.equal(data.maxBatchItems, DEFAULT_SETTINGS.maxBatchItems)

    const onDisk = await readSettingsFile(path)
    assert.deepEqual(onDisk, data)
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    assert.equal(raw.copyStyle, 'warm')
  })

  it('PUT 非法补丁 → 400 VALIDATION，且文件内容不变', async (t) => {
    const { path, store } = await makeStore(t)
    const h = await createHarness(t, { settings: store })
    const before = dataOf(await h.rawRequest({ method: 'GET', path: '/settings' }))
    const response = await h.rawRequest({
      method: 'PUT',
      path: '/settings',
      body: JSON.stringify({ copyStyle: '不存在的风格' }),
    })
    assert.equal(response.status, 400)
    assert.equal(errorOf(response).code, 'VALIDATION')
    const after = dataOf(await h.rawRequest({ method: 'GET', path: '/settings' }))
    assert.deepEqual(after, before)
    await assert.rejects(readFile(path, 'utf8'), /ENOENT/, '校验失败不应写出 settings.json')
  })

  it('PUT 未知字段 → 200 且只保留已知字段（未知字段忽略）', async (t) => {
    const { store } = await makeStore(t)
    const h = await createHarness(t, { settings: store })
    const response = await h.rawRequest({
      method: 'PUT',
      path: '/settings',
      body: JSON.stringify({ nope: 1, copyStyle: 'professional' }),
    })
    assert.equal(response.status, 200)
    const data = dataOf(response) as Record<string, unknown>
    assert.equal(data.copyStyle, 'professional')
    assert.equal(data.nope, undefined)
  })

  it('两次并发 PUT 串行落盘：最终文件可解析，且两个补丁都被保留', async (t) => {
    const { path, store } = await makeStore(t)
    const h = await createHarness(t, { settings: store })
    const [first, second] = await Promise.all([
      h.rawRequest({ method: 'PUT', path: '/settings', body: JSON.stringify({ copyStyle: 'urgent' }) }),
      h.rawRequest({
        method: 'PUT',
        path: '/settings',
        body: JSON.stringify({ defaultAddress: '西北工业大学长安校区星天苑' }),
      }),
    ])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const final = await readSettingsFile(path)
    assert.equal(final.copyStyle, 'urgent')
    assert.equal(final.defaultAddress, '西北工业大学长安校区星天苑')
  })
})
