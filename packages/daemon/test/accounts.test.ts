import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CredentialStore, XianyuError } from '@bigfish/core'

import { saveImportedAccount } from '../src/accounts.ts'
import type { ImportAccountDeps } from '../src/accounts.ts'

/** 临时凭据目录放 .scratch（已 gitignore），便于失败后排查残留。 */
const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-accounts/', import.meta.url))
const NOW = 1_700_000_000_000

async function makeDeps(t: { after(fn: () => Promise<void>): void }): Promise<ImportAccountDeps> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'run-'))
  t.after(async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  })
  const credentials = new CredentialStore({ dir, now: (): number => NOW })
  return { credentials, now: (): number => NOW }
}

function jar(goofish: Record<string, string>, others = 0): { goofish: Record<string, string>; others: number } {
  return { goofish, others }
}

function assertCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof XianyuError, '期望 XianyuError，实际 ' + String(error))
    assert.equal(error.code, code)
    return true
  }
}

test('默认用 unb 作账号 id，cookie 加密落库且能读回', async (t) => {
  const deps = await makeDeps(t)
  const result = await saveImportedAccount(deps, jar({ unb: '12345', _m_h5_tk: 'tk-value' }, 3))

  assert.equal(result.accountId, '12345')
  assert.equal(result.savedFieldCount, 2)
  assert.equal(result.source, 'chrome-cdp')
  assert.equal(result.updatedAt, NOW)
  // 返回值绝不能带 cookie 值（插件日志/回显会用到它）。
  assert.equal(JSON.stringify(result).includes('tk-value'), false)

  const record = await deps.credentials.load('12345')
  assert.ok(record !== undefined)
  assert.deepEqual(record.cookies, { unb: '12345', _m_h5_tk: 'tk-value' })
  assert.deepEqual(record.meta, { source: 'chrome-cdp', importedAt: NOW, otherCookies: 3 })
})

test('显式 accountId 优先于 unb，便于给同一账号起稳定别名', async (t) => {
  const deps = await makeDeps(t)
  const result = await saveImportedAccount(deps, jar({ unb: '12345', _m_h5_tk: 'tk' }), { accountId: 'main-shop' })
  assert.equal(result.accountId, 'main-shop')
  const record = await deps.credentials.load('main-shop')
  assert.ok(record !== undefined)
  assert.equal(record.cookies['unb'], '12345')
})

test('缺 unb 又没指定 accountId → UNAUTHORIZED，且提示可操作', async (t) => {
  const deps = await makeDeps(t)
  await assert.rejects(
    async () => saveImportedAccount(deps, jar({ _m_h5_tk: 'tk' })),
    assertCode('UNAUTHORIZED'),
  )
  assert.deepEqual(await deps.credentials.list(), [])
})

test('空白 unb 按缺失处理', async (t) => {
  const deps = await makeDeps(t)
  await assert.rejects(async () => saveImportedAccount(deps, jar({ unb: '   ' })), assertCode('UNAUTHORIZED'))
})

test('非法 accountId（路径穿越）→ VALIDATION，不写任何文件', async (t) => {
  const deps = await makeDeps(t)
  await assert.rejects(
    async () => saveImportedAccount(deps, jar({ unb: '12345' }), { accountId: '../evil' }),
    assertCode('VALIDATION'),
  )
  assert.deepEqual(await deps.credentials.list(), [])
})

test('savedFieldCount 只统计闲鱼域 cookie，others 记进 meta', async (t) => {
  const deps = await makeDeps(t)
  const result = await saveImportedAccount(deps, jar({ unb: '1', a: 'x', b: 'y' }, 9))
  assert.equal(result.savedFieldCount, 3)
  const record = await deps.credentials.load('1')
  assert.ok(record !== undefined)
  assert.equal(record.meta?.['otherCookies'], 9)
})
