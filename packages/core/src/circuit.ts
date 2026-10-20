/**
 * 账号级熔断。命中 RGV587 风控后默认熔断 10 分钟，状态必须原子落盘：
 * daemon 重启后仍要挡住写操作，否则会反复触风控。
 * 读写都用同步 fs：状态文件很小，且构造后必须立刻能回答 isOpen，
 * 用异步加载会让调用方每次都要先 await 一次初始化。
 * @module @bigfish/core/circuit
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { XianyuError } from './errors.ts'
import { redactString } from './redact.ts'

/** 一条熔断记录。 */
export interface CircuitState {
  accountId: string
  reason: string
  /** 熔断开始时间（epoch ms）。 */
  trippedAt: number
  /** 冷却结束时间（epoch ms）；到点后自动放行。 */
  until: number
}

export interface CircuitBreakerOptions {
  /** 状态文件路径；目录不存在会自动创建。 */
  path: string
  /** 熔断时长，默认 10 分钟（RGV587 风控的经验值）。 */
  cooldownMs?: number
  now?: () => number
  /** 最多保留多少条记录，默认 200，防止文件无限膨胀。 */
  maxEntries?: number
}

const DEFAULT_COOLDOWN_MS = 600_000
const DEFAULT_MAX_ENTRIES = 200
const FILE_VERSION = 1

interface CircuitFile {
  v: number
  circuits: CircuitState[]
}

export class CircuitBreaker {
  readonly path: string
  readonly cooldownMs: number
  readonly maxEntries: number
  readonly now: () => number
  states: Map<string, CircuitState>

  constructor(options: CircuitBreakerOptions) {
    if (options.path.trim() === '') throw new TypeError('CircuitBreaker.path 不能为空')
    const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1) {
      throw new TypeError('CircuitBreaker.cooldownMs 非法: ' + String(cooldownMs))
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('CircuitBreaker.maxEntries 非法: ' + String(maxEntries))
    }
    this.path = options.path
    this.cooldownMs = cooldownMs
    this.maxEntries = maxEntries
    this.now = options.now ?? Date.now
    this.states = loadStates(this.path, this.maxEntries)
  }

  /** 是否处于熔断冷却中。 */
  isOpen(accountId: string, at?: number): boolean {
    const state = this.states.get(accountId)
    if (state === undefined) return false
    return Math.trunc(at ?? this.now()) < state.until
  }

  /** 记录一次熔断并落盘。 */
  trip(accountId: string, reason: string): CircuitState {
    if (accountId === '') throw new TypeError('熔断 accountId 不能为空')
    const at = Math.trunc(this.now())
    const state: CircuitState = {
      accountId,
      reason: redactString(reason),
      trippedAt: at,
      until: at + this.cooldownMs,
    }
    this.states.set(accountId, state)
    trimToCapacity(this.states, this.maxEntries)
    saveStates(this.path, this.states)
    return { ...state }
  }

  /** 手动解除熔断。 */
  reset(accountId: string): void {
    if (!this.states.delete(accountId)) return
    saveStates(this.path, this.states)
  }

  /** 当前仍在熔断中的账号（/status 用）。 */
  list(): CircuitState[] {
    const at = Math.trunc(this.now())
    return [...this.states.values()]
      .filter(state => at < state.until)
      .map(state => ({ ...state }))
  }
}

function loadStates(path: string, maxEntries: number): Map<string, CircuitState> {
  const states = new Map<string, CircuitState>()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // 文件不存在或读不了：按空状态继续。熔断是安全缓存，丢了只是少挡一会儿，
    // 不能因为状态文件不可读拖垮 daemon 启动。
    return states
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // 文件损坏（半截写入、手工改坏）同样当空状态，不能抛。
    return states
  }
  for (const item of extractRawStates(parsed)) {
    const state = toCircuitState(item)
    if (state !== undefined) states.set(state.accountId, state)
  }
  trimToCapacity(states, maxEntries)
  return states
}

function extractRawStates(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed as unknown[]
  if (!isRecord(parsed)) return []
  const circuits = parsed['circuits']
  return Array.isArray(circuits) ? (circuits as unknown[]) : []
}

function toCircuitState(value: unknown): CircuitState | undefined {
  if (!isRecord(value)) return undefined
  const accountId = value['accountId']
  const reason = value['reason']
  const trippedAt = value['trippedAt']
  const until = value['until']
  if (typeof accountId !== 'string' || accountId === '') return undefined
  if (typeof reason !== 'string') return undefined
  if (!isInteger(trippedAt) || !isInteger(until)) return undefined
  return { accountId, reason, trippedAt, until }
}

function trimToCapacity(states: Map<string, CircuitState>, maxEntries: number): void {
  if (states.size <= maxEntries) return
  // 先丢最早到期的记录：它们最接近解除，信息价值最低。
  const sorted = [...states.values()].sort((left, right) => left.until - right.until)
  for (const state of sorted.slice(0, states.size - maxEntries)) states.delete(state.accountId)
}

function saveStates(path: string, states: Map<string, CircuitState>): void {
  const payload: CircuitFile = { v: FILE_VERSION, circuits: [...states.values()] }
  const tmp = path + '.tmp'
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    // 先写临时文件再 rename：进程被杀时不会留下半截 JSON。
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件可能根本没写出来，清理失败不覆盖原始错误。
    }
    throw new XianyuError({ code: 'STORAGE', message: '熔断状态写入失败: ' + path, cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
