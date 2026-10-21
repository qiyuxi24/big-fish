/**
 * 账号级发布 pacing 的纯函数测试：默认值/环境变量解析/夹取边界/排队语义。
 * 不 sleep、不联网，时间全部由参数传入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_PUBLISH_MIN_INTERVAL_MS,
  PUBLISH_MIN_INTERVAL_MAX_MS,
  PUBLISH_MIN_INTERVAL_MIN_MS,
  nextPublishAvailableAt,
  resolvePublishMinIntervalMs,
} from '../src/limiter.ts'

const T0 = 1_700_000_000_000

test('默认间隔 180s，允许区间 30s..3600s', () => {
  assert.equal(DEFAULT_PUBLISH_MIN_INTERVAL_MS, 180_000)
  assert.equal(PUBLISH_MIN_INTERVAL_MIN_MS, 30_000)
  assert.equal(PUBLISH_MIN_INTERVAL_MAX_MS, 3_600_000)
  assert.equal(resolvePublishMinIntervalMs(undefined), 180_000)
})

test('接受数字与数字字符串，非法值回退默认值', () => {
  assert.equal(resolvePublishMinIntervalMs(120_000), 120_000)
  assert.equal(resolvePublishMinIntervalMs('300000'), 300_000)
  assert.equal(resolvePublishMinIntervalMs(' 60000 '), 60_000)
  assert.equal(resolvePublishMinIntervalMs('abc'), 180_000)
  assert.equal(resolvePublishMinIntervalMs(''), 180_000)
  assert.equal(resolvePublishMinIntervalMs(null), 180_000)
  assert.equal(resolvePublishMinIntervalMs(true), 180_000)
  assert.equal(resolvePublishMinIntervalMs(Number.NaN), 180_000)
  assert.equal(resolvePublishMinIntervalMs(Number.POSITIVE_INFINITY), 180_000)
})

test('超出区间夹到边界，小数向下取整', () => {
  assert.equal(resolvePublishMinIntervalMs(0), PUBLISH_MIN_INTERVAL_MIN_MS)
  assert.equal(resolvePublishMinIntervalMs(1_000), PUBLISH_MIN_INTERVAL_MIN_MS)
  assert.equal(resolvePublishMinIntervalMs(PUBLISH_MIN_INTERVAL_MAX_MS + 1), PUBLISH_MIN_INTERVAL_MAX_MS)
  assert.equal(resolvePublishMinIntervalMs(90_500.9), 90_500)
})

test('首条取 now，后续按 previousAt + interval 递增，不早于 now', () => {
  assert.equal(nextPublishAvailableAt(undefined, T0, 180_000), T0)
  assert.equal(nextPublishAvailableAt(T0, T0, 180_000), T0 + 180_000)
  assert.equal(nextPublishAvailableAt(T0 + 180_000, T0, 180_000), T0 + 360_000)
  // 排队时间已经落后于当前时刻（比如队列积压很久）时，从 now 重新起算，不排到过去。
  assert.equal(nextPublishAvailableAt(T0, T0 + 1_000_000, 180_000), T0 + 1_000_000)
})

test('非法参数 → VALIDATION（不静默算错时间）', () => {
  assert.throws(() => nextPublishAvailableAt(undefined, -1, 180_000), /nowMs/)
  assert.throws(() => nextPublishAvailableAt(undefined, 1.5, 180_000), /nowMs/)
  assert.throws(() => nextPublishAvailableAt(undefined, T0, 0), /intervalMs/)
  assert.throws(() => nextPublishAvailableAt(undefined, T0, 1.5), /intervalMs/)
  assert.throws(() => nextPublishAvailableAt(-1, T0, 180_000), /previousAt/)
  assert.throws(() => nextPublishAvailableAt(1.5, T0, 180_000), /previousAt/)
})
