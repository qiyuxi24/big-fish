import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XianyuError } from '../src/errors.ts'
import { DEFAULT_BUCKETS, RateLimiter } from '../src/limiter.ts'
import type { AcquireResult } from '../src/limiter.ts'

const T0 = 1_700_000_000_000

function fakeClock(start = T0): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => { current += ms },
  }
}

function expectFailure(result: AcquireResult): { ok: false; retryAfterMs: number } {
  if (result.ok) assert.fail('预期配额耗尽')
  return result
}

function validationError(error: unknown): boolean {
  assert.ok(error instanceof XianyuError, '应抛 XianyuError')
  assert.equal(error.code, 'VALIDATION')
  return true
}

test('默认护栏：写 1/分钟、媒体 9/分钟、读 30/分钟', () => {
  assert.deepEqual(DEFAULT_BUCKETS, {
    write: { limit: 1, windowMs: 60_000 },
    media: { limit: 9, windowMs: 60_000 },
    read: { limit: 30, windowMs: 60_000 },
  })
})

test('写桶第二次 acquire 失败且 retryAfterMs 大于 0', () => {
  const clock = fakeClock()
  const limiter = new RateLimiter({ now: clock.now })
  assert.deepEqual(limiter.acquire('write', 'acc-1'), { ok: true, remaining: 0 })
  const second = expectFailure(limiter.acquire('write', 'acc-1'))
  assert.equal(second.retryAfterMs, 60_000)
})

test('滑动窗口 60s 边界：59.999s 仍失败、整 60s 放行', () => {
  const clock = fakeClock()
  const limiter = new RateLimiter({ now: clock.now })
  assert.equal(limiter.acquire('write', 'acc-1').ok, true)
  clock.advance(59_999)
  const blocked = expectFailure(limiter.acquire('write', 'acc-1'))
  assert.equal(blocked.retryAfterMs, 1)
  clock.advance(1)
  assert.deepEqual(limiter.acquire('write', 'acc-1'), { ok: true, remaining: 0 })
})

test('失败不退还预算：重复失败后 used 仍为 1', () => {
  const clock = fakeClock()
  const limiter = new RateLimiter({ now: clock.now })
  assert.equal(limiter.acquire('write', 'acc-1').ok, true)
  expectFailure(limiter.acquire('write', 'acc-1'))
  expectFailure(limiter.acquire('write', 'acc-1'))
  clock.advance(30_000)
  expectFailure(limiter.acquire('write', 'acc-1'))
  const snap = limiter.snapshot('acc-1')['write']
  assert.ok(snap !== undefined)
  assert.equal(snap.used, 1)
  assert.equal(snap.remaining, 0)
})

test('不同 key 的配额互不影响', () => {
  const clock = fakeClock()
  const limiter = new RateLimiter({ now: clock.now })
  assert.equal(limiter.acquire('write', 'acc-1').ok, true)
  assert.equal(limiter.acquire('write', 'acc-2').ok, true)
  expectFailure(limiter.acquire('write', 'acc-1'))
  const snap = limiter.snapshot('acc-2')['write']
  assert.ok(snap !== undefined)
  assert.equal(snap.used, 1)
})

test('cost 参与预算计算，超过剩余额度直接失败', () => {
  const clock = fakeClock()
  const limiter = new RateLimiter({ now: clock.now })
  assert.deepEqual(limiter.acquire('media', 'acc-1', 5), { ok: true, remaining: 4 })
  const blocked = expectFailure(limiter.acquire('media', 'acc-1', 5))
  assert.equal(blocked.retryAfterMs, 60_000)
  assert.deepEqual(limiter.acquire('media', 'acc-1', 4), { ok: true, remaining: 0 })
  expectFailure(limiter.acquire('media', 'acc-1'))
})

test('snapshot：按 key 时键为桶名并补齐空桶，不传 key 时键为 bucket:key', () => {
  const clock = fakeClock()
  const limiter = new RateLimiter({ now: clock.now })
  limiter.acquire('write', 'acc-1')
  const perKey = limiter.snapshot('acc-1')
  assert.deepEqual(Object.keys(perKey).sort(), ['media', 'read', 'write'])
  const write = perKey['write']
  assert.ok(write !== undefined)
  assert.deepEqual(write, { used: 1, limit: 1, remaining: 0, resetAt: T0 + 60_000 })
  const media = perKey['media']
  assert.ok(media !== undefined)
  assert.deepEqual(media, { used: 0, limit: 9, remaining: 9, resetAt: T0 })
  const global = limiter.snapshot()
  assert.deepEqual(Object.keys(global), ['write:acc-1'])
})

test('未知桶、空 key、非法 cost 抛 VALIDATION', () => {
  const limiter = new RateLimiter({ now: fakeClock().now })
  assert.throws(() => limiter.acquire('nope', 'acc-1'), validationError)
  assert.throws(() => limiter.acquire('write', ''), validationError)
  assert.throws(() => limiter.acquire('write', 'acc-1', 0), validationError)
  assert.throws(() => limiter.acquire('write', 'acc-1', 1.5), validationError)
})

test('非法桶规则在构造函数即拒绝', () => {
  assert.throws(() => new RateLimiter({ buckets: { write: { limit: 0, windowMs: 60_000 } } }), validationError)
  assert.throws(() => new RateLimiter({ buckets: { write: { limit: 1, windowMs: 0 } } }), validationError)
})
