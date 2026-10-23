/**
 * POST /accounts/import 路由测试：鉴权、能力未注入、参数透传与校验。
 * 不连 Chrome：导入能力用假实现注入，只验 HTTP 层行为。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'

import type { ImportedAccount } from '../src/accounts.ts'
import type { ImportAccountInput } from '../src/accounts.ts'
import type { AccountSummary } from '../src/account-list.ts'
import { createHarness, dataOf, errorOf } from './harness.ts'

const IMPORTED: ImportedAccount = {
  accountId: '12345',
  savedFieldCount: 2,
  updatedAt: 1_700_000_000_000,
  source: 'chrome-cdp',
}

function stubImporter(calls: ImportAccountInput[]): (input: ImportAccountInput) => Promise<ImportedAccount> {
  return async (input: ImportAccountInput): Promise<ImportedAccount> => {
    calls.push(input)
    return IMPORTED
  }
}

describe('POST /accounts/import', () => {
  it('缺少 Bearer token → 401 UNAUTHORIZED', async (t) => {
    const harness = await createHarness(t, { importAccount: stubImporter([]) })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/import', token: null, body: '{}' })
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })

  it('未注入导入能力 → 500 UNSUPPORTED（不假装成功）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/import', body: '{}' })
    assert.equal(response.status, 500)
    const error = errorOf(response)
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /未注入账号导入能力/)
  })

  it('空对象 → 调用导入器且不带可选字段，返回摘要', async (t) => {
    const calls: ImportAccountInput[] = []
    const harness = await createHarness(t, { importAccount: stubImporter(calls) })
    const response = await harness.rawRequest({ method: 'POST', path: '/accounts/import', body: '{}' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), IMPORTED)
    assert.deepEqual(calls, [{}])
  })

  it('accountId 与 port 透传给导入器', async (t) => {
    const calls: ImportAccountInput[] = []
    const harness = await createHarness(t, { importAccount: stubImporter(calls) })
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/accounts/import',
      body: JSON.stringify({ accountId: 'main-shop', port: 9333 }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{ accountId: 'main-shop', port: 9333 }])
  })

  it('非法 port / 非字符串 accountId → 400 VALIDATION', async (t) => {
    const harness = await createHarness(t, { importAccount: stubImporter([]) })
    for (const body of ['{"port":0}', '{"port":70000}', '{"port":"9222"}', '{"port":1.5}', '{"accountId":42}']) {
      const response = await harness.rawRequest({ method: 'POST', path: '/accounts/import', body })
      assert.equal(response.status, 400, body)
      assert.equal(errorOf(response).code, 'VALIDATION', body)
    }
  })
})

const SUMMARIES: AccountSummary[] = [
  { accountId: '2206569289277', updatedAt: 1_700_000_000_000, savedFieldCount: 18, ready: true, unb: '2206569289277', ageMs: 4_000, active: true },
]

describe('GET /accounts', () => {
  it('缺少 Bearer token → 401 UNAUTHORIZED', async (t) => {
    const harness = await createHarness(t, { accountSummaries: async () => SUMMARIES })
    const response = await harness.rawRequest({ method: 'GET', path: '/accounts', token: null })
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })

  it('未注入摘要能力 → 200 空数组（开发态不报错）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'GET', path: '/accounts' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), [])
  })

  it('注入摘要能力 → 原样返回（不含 cookie 值）', async (t) => {
    const harness = await createHarness(t, { accountSummaries: async () => SUMMARIES })
    const response = await harness.rawRequest({ method: 'GET', path: '/accounts' })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), SUMMARIES)
  })

  it('摘要能力抛 STORAGE → 500 且错误码保留', async (t) => {
    const harness = await createHarness(t, {
      accountSummaries: async () => {
        throw new XianyuError({ code: 'STORAGE', message: '凭据目录读取失败' })
      },
    })
    const response = await harness.rawRequest({ method: 'GET', path: '/accounts' })
    assert.equal(response.status, 500)
    assert.equal(errorOf(response).code, 'STORAGE')
  })
})
