/**
 * 导入时记录浏览器给的 cookie 过期时间（meta.expires），供面板展示「登录态还剩多久」。
 *
 * 为什么单独测：CookieJar 只有 name→value，expires 只能从 CDP 原始 cookie 数组换算；
 * 登录扫码路径拿不到原始数组，所以「没有 expires 也不报错」同样是契约的一部分。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CredentialStore } from '@bigfish/core'
import type { BrowserCookie } from '@bigfish/channel-cdp'

import { saveImportedAccount } from '../src/accounts.ts'
import type { ImportAccountDeps } from '../src/accounts.ts'

const SCRATCH_ROOT = fileURLToPath(new URL('../../../.scratch/daemon-accounts-expiry/', import.meta.url))
const NOW = 1_700_000_000_000

async function makeDeps(t: { after(fn: () => Promise<void>): void }): Promise<ImportAccountDeps> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'run-'))
  t.after(async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  })
  return { credentials: new CredentialStore({ dir, now: (): number => NOW }), now: (): number => NOW }
}

function jar(goofish: Record<string, string>, others = 0): { goofish: Record<string, string>; others: number } {
  return { goofish, others }
}

function cookie(name: string, value: string, expires?: number, domain = '.goofish.com'): BrowserCookie {
  return {
    name,
    value,
    domain,
    path: '/',
    ...(expires === undefined ? {} : { expires }),
  }
}

describe('saveImportedAccount 记录 meta.expires', () => {
  it('把 CDP 秒级 expires 换算成毫秒写进 meta，同时保留已有 meta 字段', async (t) => {
    const deps = await makeDeps(t)
    const cookies: BrowserCookie[] = [
      cookie('unb', '12345', 1_800_000_000),
      cookie('_m_h5_tk', 'tk-value', 1_800_003_600, '.taobao.com'),
    ]
    await saveImportedAccount(deps, jar({ unb: '12345', _m_h5_tk: 'tk-value' }, 3), {}, cookies)

    const record = await deps.credentials.load('12345')
    assert.ok(record !== undefined)
    assert.deepEqual(record.meta, {
      source: 'chrome-cdp',
      importedAt: NOW,
      otherCookies: 3,
      expires: { unb: 1_800_000_000_000, _m_h5_tk: 1_800_003_600_000 },
    })
    // 敏感边界：过期时间可以落盘，cookie 值只出现在加密 cookies 字段里。
    assert.equal(JSON.stringify(record.meta).includes('tk-value'), false)
  })

  it('不传原始 cookie 数组（扫码登录路径）→ 不写 expires 字段，也不报错', async (t) => {
    const deps = await makeDeps(t)
    await saveImportedAccount(deps, jar({ unb: '12345', _m_h5_tk: 'tk' }))
    const record = await deps.credentials.load('12345')
    assert.ok(record !== undefined)
    assert.deepEqual(record.meta, { source: 'chrome-cdp', importedAt: NOW, otherCookies: 0 })
    assert.equal(Object.hasOwn(record.meta ?? {}, 'expires'), false)
  })

  it('全是会话 cookie（无 expires）→ 同样不写 expires（不编造过期时间）', async (t) => {
    const deps = await makeDeps(t)
    await saveImportedAccount(
      deps,
      jar({ unb: '12345', _m_h5_tk: 'tk' }),
      {},
      [cookie('unb', '12345'), cookie('_m_h5_tk', 'tk')],
    )
    const record = await deps.credentials.load('12345')
    assert.ok(record !== undefined)
    assert.equal('expires' in (record.meta ?? {}), false)
  })

  it('非闲鱼/淘宝域的 cookie 过期时间不写入（只记登录域）', async (t) => {
    const deps = await makeDeps(t)
    const cookies: BrowserCookie[] = [
      cookie('unb', '12345', 1_800_000_000),
      cookie('other', 'x', 1_900_000_000, '.example.com'),
    ]
    await saveImportedAccount(deps, jar({ unb: '12345', _m_h5_tk: 'tk' }, 1), {}, cookies)
    const record = await deps.credentials.load('12345')
    assert.ok(record !== undefined)
    const expires = record.meta?.['expires']
    assert.deepEqual(expires, { unb: 1_800_000_000_000 })
  })
})
