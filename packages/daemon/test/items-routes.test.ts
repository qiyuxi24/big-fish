/**
 * items / status / circuits 路由测试：商品表过滤、账号列表透传、熔断状态与手动解除。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CircuitBreaker } from '@bigfish/core'
import type { ItemRepository, ItemSummary } from '@bigfish/core'

import { createHarness, dataOf, errorOf } from './harness.ts'

function makeItems(rows: ItemSummary[]): ItemRepository {
  return {
    upsert(input) {
      return { ...input, updatedAt: input.updatedAt ?? 1 }
    },
    get(itemId) {
      return rows.find(row => row.itemId === itemId)
    },
    list(filter = {}) {
      let result = rows
      if (filter.accountId !== undefined) result = result.filter(row => row.accountId === filter.accountId)
      if (filter.state !== undefined) result = result.filter(row => row.state === filter.state)
      if (filter.limit !== undefined) result = result.slice(0, filter.limit)
      return result
    },
    count(accountId) {
      return accountId === undefined ? rows.length : rows.filter(row => row.accountId === accountId).length
    },
  }
}

const ROWS: ItemSummary[] = [
  { itemId: 'i1', accountId: 'acc1', title: '商品一', priceCents: 1000, state: 'online', updatedAt: 1 },
  { itemId: 'i2', accountId: 'acc1', title: '商品二', priceCents: 2000, state: 'offline', updatedAt: 2 },
  { itemId: 'i3', accountId: 'acc2', title: '商品三', priceCents: 3000, state: 'online', updatedAt: 3 },
]

describe('daemon /items 路由', () => {
  it('注入仓储后返回全部商品', async (t) => {
    const h = await createHarness(t, { items: makeItems(ROWS) })
    const data = dataOf(await h.rawRequest({ method: 'GET', path: '/items' })) as ItemSummary[]
    assert.equal(data.length, 3)
    assert.deepEqual(data.map(row => row.itemId), ['i1', 'i2', 'i3'])
  })

  it('按 state / accountId / limit 过滤', async (t) => {
    const h = await createHarness(t, { items: makeItems(ROWS) })
    const online = dataOf(await h.rawRequest({ method: 'GET', path: '/items?state=online' })) as ItemSummary[]
    assert.deepEqual(online.map(row => row.itemId), ['i1', 'i3'])
    const acc = dataOf(await h.rawRequest({ method: 'GET', path: '/items?accountId=acc2' })) as ItemSummary[]
    assert.deepEqual(acc.map(row => row.itemId), ['i3'])
    const limited = dataOf(await h.rawRequest({ method: 'GET', path: '/items?limit=2' })) as ItemSummary[]
    assert.equal(limited.length, 2)
  })

  it('非法 state / 空 accountId / 非法 limit → 400 VALIDATION', async (t) => {
    const h = await createHarness(t, { items: makeItems(ROWS) })
    for (const path of ['/items?state=nope', '/items?accountId=', '/items?limit=0']) {
      const response = await h.rawRequest({ method: 'GET', path })
      assert.equal(response.status, 400, path)
      assert.equal(errorOf(response).code, 'VALIDATION')
    }
  })

  it('/status 返回注入的账号列表；未注入时为空数组', async (t) => {
    const withAccounts = await createHarness(t, { accounts: () => ['acc1', 'acc2'] })
    const status = dataOf(await withAccounts.rawRequest({ method: 'GET', path: '/status' })) as { accounts: string[]; circuits: Record<string, string> }
    assert.deepEqual(status.accounts, ['acc1', 'acc2'])
    assert.deepEqual(status.circuits, {})

    const empty = await createHarness(t)
    const status2 = dataOf(await empty.rawRequest({ method: 'GET', path: '/status' })) as { accounts: string[] }
    assert.deepEqual(status2.accounts, [])
  })

  it('/status.circuits 反映熔断；POST /circuits/reset 解除并回显 reset:true', async (t) => {
    const h = await createHarness(t)
    const breaker = new CircuitBreaker({ path: h.config.circuitPath, now: () => 1_700_000_000_000 })
    breaker.trip('acc1', 'RGV587')
    // 换一个注入熔断器的 harness（同一个 circuitPath，共享落盘状态）。
    const h2 = await createHarness(t, { circuits: breaker })
    const status = dataOf(await h2.rawRequest({ method: 'GET', path: '/status' })) as { circuits: Record<string, string> }
    assert.equal(status.circuits['acc1'], 'RGV587')

    const reset = await h2.rawRequest({ method: 'POST', path: '/circuits/reset', body: JSON.stringify({ accountId: 'acc1' }) })
    assert.equal(reset.status, 200)
    assert.deepEqual(dataOf(reset), { accountId: 'acc1', reset: true })
    assert.equal(breaker.isOpen('acc1'), false)
  })
})
