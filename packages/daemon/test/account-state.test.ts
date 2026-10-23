/**
 * account-state 单测：原子写、坏文件容错、remove 与并发串行化。
 *
 * 为什么这些边界值得测：account-state 只是可选缓存，任何读失败都必须退化成空表，
 * 否则一次断电写坏就会把整个 /accounts 拖垮。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { XianyuError } from '@bigfish/core'

import { createAccountStateStore } from '../src/account-state.ts'
import type { AccountRuntimeState, AccountStateStore } from '../src/account-state.ts'

const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-account-state/', import.meta.url))

interface Fixture {
  store: AccountStateStore
  path: string
}

async function makeStore(
  t: { after(fn: () => Promise<void>): void },
  now: () => number = () => 1_000,
): Promise<Fixture> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'run-'))
  t.after(async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  })
  const path = join(dir, 'account-state.json')
  return { store: createAccountStateStore({ path, now }), path }
}

function state(overrides: Partial<AccountRuntimeState> = {}): AccountRuntimeState {
  return { checkedAt: 10, online: true, refreshed: false, source: 'manual', ...overrides }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8')
  const parsed: unknown = JSON.parse(text)
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
  return parsed as Record<string, unknown>
}

describe('createAccountStateStore', () => {
  it('record 后 read 能读回，落盘形状带 version', async (t) => {
    const { store, path } = await makeStore(t)
    const failure = state({
      checkedAt: 20,
      online: false,
      code: 'AUTH_EXPIRED',
      message: '登录态已失效',
      source: 'keepalive',
    })
    await store.record('a1', failure)

    assert.deepEqual(await store.read(), { a1: failure })
    const file = await readJson(path)
    assert.equal(file['version'], 1)
    assert.deepEqual(file['accounts'], { a1: failure })
  })

  it('文件不存在 → 空表（首次运行不报错）', async (t) => {
    const { store } = await makeStore(t)
    assert.deepEqual(await store.read(), {})
  })

  it('坏 JSON → 空表，下一次 record 覆盖成好文件', async (t) => {
    const { store, path } = await makeStore(t)
    await writeFile(path, '{"version":1,"accounts":{"a1":', 'utf8')
    assert.deepEqual(await store.read(), {})

    await store.record('a1', state())
    assert.deepEqual(Object.keys(await store.read()), ['a1'])
  })

  it('版本不认识 → 空表（宁可丢缓存也不要读错格式）', async (t) => {
    const { store, path } = await makeStore(t)
    await writeFile(path, JSON.stringify({ version: 2, accounts: { a1: state() } }), 'utf8')
    assert.deepEqual(await store.read(), {})
  })

  it('非法条目只丢自己，合法条目保留', async (t) => {
    const { store, path } = await makeStore(t)
    const good = state({ checkedAt: 1 })
    await writeFile(
      path,
      JSON.stringify({ version: 1, accounts: { good, bad: { checkedAt: 'x' }, worse: null } }),
      'utf8',
    )
    assert.deepEqual(await store.read(), { good })
  })

  it('未知 code 丢弃该字段但保留整条检测记录', async (t) => {
    const { store, path } = await makeStore(t)
    await writeFile(
      path,
      JSON.stringify({ version: 1, accounts: { a1: { ...state(), code: 'WEIRD_NEW_CODE' } } }),
      'utf8',
    )
    const record = (await store.read())['a1']
    assert.ok(record !== undefined)
    assert.equal('code' in record, false)
    assert.equal(record.online, true)
  })

  it('checkedAt 不是安全整数 → 写入注入时钟（AGENTS §3：时间必须整数毫秒）', async (t) => {
    const { store } = await makeStore(t, () => 7_777)
    await store.record('a1', state({ checkedAt: 1.5 }))
    assert.equal((await store.read())['a1']?.checkedAt, 7_777)
  })

  it('remove 删单条；删不存在的账号不写文件也不报错', async (t) => {
    const { store, path } = await makeStore(t)
    await store.record('a1', state())
    await store.record('a2', state())
    await store.remove('a1')
    assert.deepEqual(Object.keys(await store.read()), ['a2'])

    await store.remove('missing')
    assert.deepEqual(Object.keys(await store.read()), ['a2'])
    assert.equal((await readJson(path))['version'], 1)
  })

  it('并发 record 串行化，两条都保留', async (t) => {
    const { store } = await makeStore(t)
    await Promise.all([store.record('a', state({ checkedAt: 1 })), store.record('b', state({ checkedAt: 2 }))])
    const all = await store.read()
    assert.deepEqual(Object.keys(all).sort(), ['a', 'b'])
    assert.equal(all['a']?.checkedAt, 1)
    assert.equal(all['b']?.checkedAt, 2)
  })

  it('写盘失败 → STORAGE（目录位置被普通文件占住）', async (t) => {
    await mkdir(SCRATCH_ROOT, { recursive: true })
    const dir = await mkdtemp(join(SCRATCH_ROOT, 'run-'))
    t.after(async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true })
    })
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    const store = createAccountStateStore({ path: join(blocker, 'account-state.json') })

    await assert.rejects(
      async () => store.record('a1', state()),
      (error: unknown): boolean => {
        assert.ok(error instanceof XianyuError)
        assert.equal(error.code, 'STORAGE')
        assert.match(error.message, /账号状态缓存写入失败/)
        return true
      },
    )
  })
})
