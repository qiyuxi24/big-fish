/**
 * items.ts 的行为测试：upsert / get / list / count 与入参校验。
 * 只用 ':memory:' 库 + 假时钟；不直接读表（表结构由 store.test.ts 断言）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { XianyuError } from '../src/errors.ts'
import type { ErrorCode } from '../src/errors.ts'
import { createItemRepository } from '../src/items.ts'
import { openStore } from '../src/store.ts'
import type { Store } from '../src/store.ts'
import type { ItemRepository, ItemState, ItemUpsertInput } from '../src/types.ts'

interface FakeClock {
  now(): number
  set(value: number): void
}

function fakeClock(start: number): FakeClock {
  let current = start
  return { now: () => current, set: (value) => { current = value } }
}

interface Fixture {
  store: Store
  repo: ItemRepository
  clock: FakeClock
}

function setup(t: TestContext, start = 1_000): Fixture {
  const clock = fakeClock(start)
  const store = openStore({ path: ':memory:', now: clock.now })
  t.after(() => store.close())
  const repo = createItemRepository({ store, now: clock.now })
  return { store, repo, clock }
}

function expectCode(code: ErrorCode, body: () => unknown): void {
  let caught: unknown
  try {
    body()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof XianyuError, `期望抛 XianyuError(${code})，实际：${String(caught)}`)
  assert.equal(caught.code, code)
}

/** 构造合法入参；显式解构 updatedAt 是为了在 exactOptionalPropertyTypes 下省略而非写 undefined。 */
function input(overrides: Partial<ItemUpsertInput> = {}): ItemUpsertInput {
  const { updatedAt, ...rest } = overrides
  return {
    itemId: rest.itemId ?? 'item-1',
    accountId: rest.accountId ?? 'acc-1',
    title: rest.title ?? '测试商品',
    priceCents: rest.priceCents ?? 1_999,
    state: rest.state ?? 'online',
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

test('upsert 新建：updatedAt 缺省用 now，get 读回同一份摘要', (t) => {
  const { repo, clock } = setup(t, 5_000)
  const created = repo.upsert(input({ itemId: 'i-1', title: '全新商品', priceCents: 12_800, state: 'online' }))
  assert.deepEqual(created, {
    itemId: 'i-1',
    accountId: 'acc-1',
    title: '全新商品',
    priceCents: 12_800,
    state: 'online',
    updatedAt: 5_000,
  })
  clock.set(9_000)
  assert.deepEqual(repo.get('i-1'), created)
  assert.deepEqual(repo.list(), [created])
})

test('upsert 同 itemId 覆盖写：字段全量替换、不新增记录', (t) => {
  const { repo, clock } = setup(t, 1_000)
  repo.upsert(input({ itemId: 'i-2', title: '旧标题', state: 'online' }))
  clock.set(2_000)
  const updated = repo.upsert(input({ itemId: 'i-2', title: '新标题', priceCents: 300, state: 'offline' }))
  assert.equal(updated.title, '新标题')
  assert.equal(updated.priceCents, 300)
  assert.equal(updated.state, 'offline')
  assert.equal(updated.updatedAt, 2_000)
  assert.equal(repo.count(), 1)
  assert.equal(repo.list().length, 1)
})

test('upsert 指定 updatedAt 时以入参为准；非法 updatedAt → VALIDATION', (t) => {
  const { repo } = setup(t, 7_000)
  const saved = repo.upsert(input({ itemId: 'i-3', updatedAt: 1_234 }))
  assert.equal(saved.updatedAt, 1_234)
  expectCode('VALIDATION', () => repo.upsert(input({ itemId: 'i-4', updatedAt: -1 })))
  expectCode('VALIDATION', () => repo.upsert(input({ itemId: 'i-4', updatedAt: 1.5 })))
  expectCode('VALIDATION', () => repo.upsert(input({ itemId: 'i-4', updatedAt: Number.NaN })))
})

test('get：不存在返回 undefined；非法 itemId → VALIDATION', (t) => {
  const { repo } = setup(t)
  assert.equal(repo.get('nope'), undefined)
  expectCode('VALIDATION', () => repo.get('   '))
  expectCode('VALIDATION', () => repo.get(42 as unknown as string))
})

test('list 排序：updated_at DESC，同毫秒按 itemId ASC', (t) => {
  const { repo, clock } = setup(t, 1_000)
  repo.upsert(input({ itemId: 'i-a' })) // 1000
  clock.set(2_000)
  repo.upsert(input({ itemId: 'i-c' })) // 2000
  repo.upsert(input({ itemId: 'i-b' })) // 2000
  clock.set(3_000)
  repo.upsert(input({ itemId: 'i-a', title: '更新过的' })) // i-a 提到最前
  assert.deepEqual(repo.list().map((item) => item.itemId), ['i-a', 'i-b', 'i-c'])
})

test('list 支持 accountId / state / 组合过滤', (t) => {
  const { repo, clock } = setup(t, 1_000)
  repo.upsert(input({ itemId: 'i-1', accountId: 'acc-a', state: 'online' }))
  clock.set(2_000)
  repo.upsert(input({ itemId: 'i-2', accountId: 'acc-a', state: 'offline' }))
  clock.set(3_000)
  repo.upsert(input({ itemId: 'i-3', accountId: 'acc-b', state: 'online' }))
  assert.deepEqual(repo.list({ accountId: 'acc-a' }).map((item) => item.itemId), ['i-2', 'i-1'])
  assert.deepEqual(repo.list({ state: 'online' }).map((item) => item.itemId), ['i-3', 'i-1'])
  assert.deepEqual(repo.list({ accountId: 'acc-a', state: 'online' }).map((item) => item.itemId), ['i-1'])
  assert.deepEqual(repo.list({ accountId: 'acc-c' }), [])
})

test('list limit：缺省 50、上限 500、越界 → VALIDATION', (t) => {
  const { repo, clock } = setup(t, 1_000)
  for (let index = 0; index < 51; index += 1) {
    clock.set(1_000 + index)
    repo.upsert(input({ itemId: `bulk-${String(index).padStart(2, '0')}` }))
  }
  assert.equal(repo.list().length, 50)
  assert.equal(repo.list({ limit: 10 }).length, 10)
  assert.equal(repo.list({ limit: 500 }).length, 51)
  expectCode('VALIDATION', () => repo.list({ limit: 0 }))
  expectCode('VALIDATION', () => repo.list({ limit: -1 }))
  expectCode('VALIDATION', () => repo.list({ limit: 1.5 }))
  expectCode('VALIDATION', () => repo.list({ limit: 501 }))
  expectCode('VALIDATION', () => repo.list({ limit: '10' as unknown as number }))
})

test('count：全量与按账号计数；非法 accountId → VALIDATION', (t) => {
  const { repo, clock } = setup(t, 1_000)
  assert.equal(repo.count(), 0)
  repo.upsert(input({ itemId: 'i-1', accountId: 'acc-a' }))
  clock.set(2_000)
  repo.upsert(input({ itemId: 'i-2', accountId: 'acc-a' }))
  clock.set(3_000)
  repo.upsert(input({ itemId: 'i-3', accountId: 'acc-b' }))
  assert.equal(repo.count(), 3)
  assert.equal(repo.count('acc-a'), 2)
  assert.equal(repo.count('acc-b'), 1)
  assert.equal(repo.count('acc-c'), 0)
  expectCode('VALIDATION', () => repo.count('acc a'))
})

test('入参校验：itemId / accountId / title / priceCents / state 非法 → VALIDATION', (t) => {
  const { repo } = setup(t)
  expectCode('VALIDATION', () => repo.upsert(input({ itemId: '' })))
  expectCode('VALIDATION', () => repo.upsert(input({ itemId: '   ' })))
  expectCode('VALIDATION', () => repo.upsert(input({ itemId: 'x'.repeat(65) })))
  expectCode('VALIDATION', () => repo.upsert(input({ accountId: '' })))
  expectCode('VALIDATION', () => repo.upsert(input({ accountId: '账号一' })))
  expectCode('VALIDATION', () => repo.upsert(input({ accountId: 'acc 1' })))
  expectCode('VALIDATION', () => repo.upsert(input({ accountId: 'a'.repeat(65) })))
  expectCode('VALIDATION', () => repo.upsert(input({ title: '' })))
  expectCode('VALIDATION', () => repo.upsert(input({ title: '   ' })))
  expectCode('VALIDATION', () => repo.upsert(input({ title: 'x'.repeat(201) })))
  expectCode('VALIDATION', () => repo.upsert(input({ priceCents: -1 })))
  expectCode('VALIDATION', () => repo.upsert(input({ priceCents: 1.5 })))
  expectCode('VALIDATION', () => repo.upsert(input({ priceCents: Number.MAX_SAFE_INTEGER + 1 })))
  expectCode('VALIDATION', () => repo.upsert(input({ priceCents: Number.NaN })))
  expectCode('VALIDATION', () => repo.upsert(input({ state: 'banned' as unknown as ItemState })))
  expectCode('VALIDATION', () => repo.upsert(null as unknown as ItemUpsertInput))
  assert.equal(repo.count(), 0)
})

test('参数绑定：含引号/分号/SQL 片段的标题按字面存取，不影响其它行', (t) => {
  const { repo, clock } = setup(t, 1_000)
  repo.upsert(input({ itemId: 'i-1', title: '正常商品' }))
  clock.set(2_000)
  const evil = `'; DROP TABLE items; --`
  repo.upsert(input({ itemId: 'i-2', title: evil }))
  assert.equal(repo.count(), 2)
  assert.equal(repo.get('i-2')?.title, evil)
  assert.equal(repo.get('i-1')?.title, '正常商品')
})

test('priceCents 边界：0 与 Number.MAX_SAFE_INTEGER 可往返', (t) => {
  const { repo, clock } = setup(t, 1_000)
  repo.upsert(input({ itemId: 'i-0', priceCents: 0 }))
  clock.set(2_000)
  repo.upsert(input({ itemId: 'i-max', priceCents: Number.MAX_SAFE_INTEGER }))
  assert.equal(repo.get('i-0')?.priceCents, 0)
  assert.equal(repo.get('i-max')?.priceCents, Number.MAX_SAFE_INTEGER)
})

test('store 关闭后调用 get/list/count/upsert → STORAGE', (t) => {
  const { store, repo } = setup(t)
  repo.upsert(input({ itemId: 'i-1' }))
  store.close()
  expectCode('STORAGE', () => repo.get('i-1'))
  expectCode('STORAGE', () => repo.list())
  expectCode('STORAGE', () => repo.count())
  expectCode('STORAGE', () => repo.upsert(input({ itemId: 'i-2' })))
})
