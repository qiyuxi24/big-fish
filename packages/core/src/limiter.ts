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

/** 发布账号级最小间隔默认值（毫秒）。
 *
 * 为什么是 180s：真机实测同账号 15s 内连发第二件就被风控（docs/module-architecture.md §5.1），
 * 而唯一已有的节流是写桶 1 次/60s——60s 仍会踩线。180s 给风控模型留出「同一账号两次发布
 * 互不相邻」的观察窗口，同时 20 条批量仍能在一小时内排完，不至于慢到不可用。
 */
export const DEFAULT_PUBLISH_MIN_INTERVAL_MS = 180_000

/** 允许配置的下限：再小就退化成 60s 写桶，失去账号级 pacing 的意义。 */
export const PUBLISH_MIN_INTERVAL_MIN_MS = 30_000

/** 允许配置的上限（1 小时）：再大批量发布实际上不可用，宁可让调用方改配置。 */
export const PUBLISH_MIN_INTERVAL_MAX_MS = 3_600_000

/**
 * 解析 BF_PUBLISH_MIN_INTERVAL_MS（数字或数字字符串）。
 *
 * 非法值回退默认值而不是抛错：这是「节奏」参数，配错了应该退回安全默认，
 * 而不是让 daemon/插件起不来或整批发布失败；超出上下限则夹到边界值。
 */
export function resolvePublishMinIntervalMs(raw?: unknown): number {
  const fallback = DEFAULT_PUBLISH_MIN_INTERVAL_MS
  let value = fallback
  if (typeof raw === 'number') value = raw
  else if (typeof raw === 'string' && raw.trim() !== '') value = Number(raw)
  if (!Number.isFinite(value)) value = fallback
  return Math.min(PUBLISH_MIN_INTERVAL_MAX_MS, Math.max(PUBLISH_MIN_INTERVAL_MIN_MS, Math.trunc(value)))
}

/**
 * 账号级发布排队：给出下一个可执行时间。
 *
 * 语义：同一账号的 N 条发布分别落在 now、now+interval、now+2*interval……
 * previousAt 是「该账号上一条已排定的 availableAt」；没有上一条就用 now。
 * 用 max(now, ...) 是为了批量里混入别的账号/人工插入时，不会把时间排到过去。
 */
export function nextPublishAvailableAt(
  previousAt: number | undefined,
  nowMs: number,
  intervalMs: number,
): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail('VALIDATION', 'nowMs 必须是 >=0 的整数毫秒: ' + String(nowMs))
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    fail('VALIDATION', 'intervalMs 必须是正整数毫秒: ' + String(intervalMs))
  }
  if (previousAt === undefined) return nowMs
  if (!Number.isSafeInteger(previousAt) || previousAt < 0) {
    fail('VALIDATION', 'previousAt 必须是 >=0 的整数毫秒: ' + String(previousAt))
  }
  return Math.max(nowMs, previousAt + intervalMs)
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
