/**
 * 滑动窗口限流。护栏依据 goofish-cli 的实测：写 1 次/分钟、媒体 9 次/分钟、
 * 读 30 次/分钟；失败不退还预算（AGENTS 架构不变量 3）。
 * 时间一律整数毫秒，now 由外部注入以便测试。
 * @module @bigfish/core/limiter
 */
import { fail } from './errors.ts'

/** 单个桶的规则。 */
export interface BucketRule {
  /** 窗口内允许的最大次数。 */
  limit: number
  /** 滑动窗口长度（毫秒）。 */
  windowMs: number
}

export interface LimiterOptions {
  buckets?: Record<string, BucketRule>
  now?: () => number
}

export type AcquireResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number }

/** /status 用的快照项。 */
export interface BucketSnapshot {
  used: number
  limit: number
  remaining: number
  /** 最早可再次放行的时间点；无占用时等于当前时间。 */
  resetAt: number
}

interface WindowEntry {
  at: number
  cost: number
}

/** 默认护栏：写 1/分钟、媒体 9/分钟、读 30/分钟。 */
export const DEFAULT_BUCKETS: Record<string, BucketRule> = {
  write: { limit: 1, windowMs: 60_000 },
  media: { limit: 9, windowMs: 60_000 },
  read: { limit: 30, windowMs: 60_000 },
}

export default DEFAULT_BUCKETS

export class RateLimiter {
  readonly buckets: Record<string, BucketRule>
  readonly now: () => number
  /** bucket -> key -> 窗口内占用记录（按 at 升序）。 */
  readonly windows = new Map<string, Map<string, WindowEntry[]>>()

  constructor(options: LimiterOptions = {}) {
    this.buckets = options.buckets ?? DEFAULT_BUCKETS
    this.now = options.now ?? Date.now
    for (const [bucket, rule] of Object.entries(this.buckets)) {
      assertPositiveInteger('limit', bucket, rule.limit)
      assertPositiveInteger('windowMs', bucket, rule.windowMs)
    }
  }

  /**
   * 申请一次配额。失败不占用、也不退还在途预算。
   */
  acquire(bucket: string, key: string, cost = 1): AcquireResult {
    const rule = this.buckets[bucket]
    if (rule === undefined) fail('VALIDATION', '未知限流桶: ' + bucket)
    if (key === '') fail('VALIDATION', '限流 key 不能为空')
    if (!Number.isSafeInteger(cost) || cost < 1) fail('VALIDATION', '限流 cost 必须是正整数: ' + String(cost))
    const nowMs = Math.trunc(this.now())
    let perKey = this.windows.get(bucket)
    if (perKey === undefined) {
      perKey = new Map<string, WindowEntry[]>()
      this.windows.set(bucket, perKey)
    }
    const entries = pruneEntries(perKey.get(key) ?? [], nowMs - rule.windowMs)
    perKey.set(key, entries)
    const available = rule.limit - sumCost(entries)
    if (cost > available) {
      const oldest = entries[0]
      const retryAfterMs = oldest === undefined || cost > rule.limit
        ? rule.windowMs
        : Math.max(1, Math.trunc(oldest.at + rule.windowMs - nowMs))
      return { ok: false, retryAfterMs }
    }
    entries.push({ at: nowMs, cost })
    return { ok: true, remaining: available - cost }
  }

  /**
   * 快照。传 key 时键是桶名（/status?account= 用），不传时键是 bucket:key（全局用）。
   */
  snapshot(key?: string): Record<string, BucketSnapshot> {
    const nowMs = Math.trunc(this.now())
    const out: Record<string, BucketSnapshot> = {}
    for (const [bucket, rule] of Object.entries(this.buckets)) {
      const perKey = this.windows.get(bucket)
      if (key !== undefined) {
        const entries = pruneEntries(perKey?.get(key) ?? [], nowMs - rule.windowMs)
        if (perKey !== undefined) perKey.set(key, entries)
        out[bucket] = toSnapshot(entries, rule, nowMs)
        continue
      }
      if (perKey === undefined) continue
      for (const [accountKey, raw] of perKey) {
        const entries = pruneEntries(raw, nowMs - rule.windowMs)
        perKey.set(accountKey, entries)
        if (entries.length === 0) continue
        out[bucket + ':' + accountKey] = toSnapshot(entries, rule, nowMs)
      }
    }
    return out
  }
}

function assertPositiveInteger(field: string, bucket: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('VALIDATION', '限流桶 ' + bucket + ' 的 ' + field + ' 必须是正整数: ' + String(value))
  }
}

function pruneEntries(entries: readonly WindowEntry[], windowStart: number): WindowEntry[] {
  // 窗口左开右闭：at 恰好等于 windowStart 的记录已过期，60s 边界可立刻放行。
  return entries.filter(entry => entry.at > windowStart)
}

function sumCost(entries: readonly WindowEntry[]): number {
  let total = 0
  for (const entry of entries) total += entry.cost
  return total
}

function toSnapshot(entries: readonly WindowEntry[], rule: BucketRule, nowMs: number): BucketSnapshot {
  const used = sumCost(entries)
  const oldest = entries[0]
  return {
    used,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - used),
    resetAt: oldest === undefined ? nowMs : Math.trunc(oldest.at + rule.windowMs),
  }
}
