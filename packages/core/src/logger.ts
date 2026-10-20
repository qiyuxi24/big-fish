/**
 * 结构化 JSON 日志，daemon 与插件共用；字段名稳定，方便 grep 与落盘分析。
 * 安全底线：msg 与 fields 一律先脱敏；sink 抛错绝不影响业务。
 * @module @bigfish/core/logger
 */
import { redact, redactString } from './redact.ts'

/** 日志等级，数值越大越严重。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 供 config 校验用；顺序即严重度顺序。 */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 结构化字段；写盘前统一脱敏。 */
export type LogFields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** 派生 logger：绑定字段（如 accountId）会合并进每条日志。 */
  child(bindings: LogFields): Logger
}

export interface CreateLoggerOptions {
  /** 低于该等级的日志直接丢弃，默认 info。 */
  level?: LogLevel
  /** 日志来源名，默认 bigfish。 */
  name?: string
  /** 每行一个 JSON 字符串（不含换行）；默认写 stdout。 */
  sink?: (line: string) => void
  /** 时钟注入点，测试用假时钟。 */
  now?: () => number
}

const DEFAULT_SINK = (line: string): void => {
  process.stdout.write(line + '\n')
}

/** fields 脱敏后必须是普通对象；数组/标量没有字段语义，按空对象处理。 */
function redactFields(fields: LogFields): LogFields {
  const safe = redact(fields)
  return typeof safe === 'object' && safe !== null && !Array.isArray(safe) ? (safe as LogFields) : {}
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 创建 logger。
 * @param options 等级、名称、sink、时钟
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return buildLogger(
    options.level ?? 'info',
    options.name ?? 'bigfish',
    {},
    options.sink ?? DEFAULT_SINK,
    options.now ?? Date.now,
  )
}

function buildLogger(
  level: LogLevel,
  name: string,
  bindings: LogFields,
  sink: (line: string) => void,
  now: () => number,
): Logger {
  let sinkFailureReported = false

  const emit = (entryLevel: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return
    const payload: Record<string, unknown> = {
      t: Math.trunc(now()),
      level: entryLevel,
      name,
      msg: redactString(msg),
      ...bindings,
      ...(fields === undefined ? {} : redactFields(fields)),
    }
    let line: string
    try {
      line = JSON.stringify(payload)
    } catch {
      // fields 里若有 toJSON 抛错的对象，降级成最小行；日志不能反过来打断业务。
      line = JSON.stringify({ t: Math.trunc(now()), level: entryLevel, name, msg: '[unserializable]' })
    }
    try {
      sink(line)
    } catch (error) {
      if (sinkFailureReported) return
      sinkFailureReported = true
      try {
        process.stderr.write('[bigfish/logger] sink 写入失败: ' + describeError(error) + '\n')
      } catch {
        // stderr 也写不进去就无处上报了；绝不能递归回 logger，否则死循环。
      }
    }
  }

  const child = (extra: LogFields): Logger => {
    return buildLogger(level, name, { ...bindings, ...redactFields(extra) }, sink, now)
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child,
  }
}
