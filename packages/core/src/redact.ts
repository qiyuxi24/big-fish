/**
 * 脱敏工具：任何字符串在进入日志 sink、异常详情、状态文件之前都要过这里。
 * 为什么收口在 core：daemon、插件、HTTP 客户端都会写日志，只要有一处漏脱敏，
 * cookie/token 就会落盘，所以脱敏必须只有一个实现。
 * @module @bigfish/core/redact
 */

/** 敏感字段名（小写形式）；比较前统一转小写，避免 Cookie 与 cookie 漏网。 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'tfstk',
  '_m_h5_tk',
  '_m_h5_tk_enc',
  'x5sec',
  'x5secdata',
  'password',
  'secret',
  'apikey',
  'api_key',
  // JWT 的 subject 与登录态绑定，按「token 永不打印」一并脱敏。
  'sub',
])

/** 派生字段名（refreshToken、clientSecret 之类）靠子串兜底：宁可多掩，不可漏掩。 */
const SENSITIVE_FRAGMENTS: readonly string[] = [
  'token',
  'secret',
  'password',
  'cookie',
  'authorization',
  'credential',
  'apikey',
  'x5sec',
  'tfstk',
  '_m_h5_tk',
]

/** 掩码占位。 */
export const REDACTED = '[redacted]'

/** 超深嵌套 / 循环引用的占位。 */
export const TRUNCATED = '[truncated]'

/** Cookie / Authorization 等头值：从头名或等号后一直掩到行尾。 */
const HEADER_VALUE_RE = /(\b(?:cookie|set-cookie|authorization|proxy-authorization)\b\s*[:=]\s*)[^\r\n]*/gi

/** sk- 开头的密钥串。 */
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}/g

/** 长随机串（hex / base64 / base64url）；24 字符起才掩，避免误伤普通英文。 */
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/g

/**
 * 结构 id（UUID v4 形态）必须先保护起来：36 字符的 UUID 会被 LONG_TOKEN_RE 命中，
 * 早期版本因此把 taskId/itemId 一起掩成 [redacted]，客户端拿不到可回查的 id。
 * 做法是占位符替换 → 脱敏 → 还原，占位符用私用区字符，正常文本不会出现。
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const UUID_PLACEHOLDER_RE = /\uE000(\d+)\uE001/g

function protectUuids(input: string): { text: string; uuids: string[] } {
  const uuids: string[] = []
  const text = input.replace(UUID_RE, (matched) => {
    uuids.push(matched)
    return '\uE000' + String(uuids.length - 1) + '\uE001'
  })
  return { text, uuids }
}

function restoreUuids(input: string, uuids: readonly string[]): string {
  if (uuids.length === 0) return input
  return input.replace(UUID_PLACEHOLDER_RE, (_matched, index: string) => uuids[Number(index)] ?? REDACTED)
}

/**
 * 判断字段名是否敏感（大小写不敏感）。
 * @param key 字段名
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase()
  if (SENSITIVE_KEYS.has(normalized)) return true
  return SENSITIVE_FRAGMENTS.some(fragment => normalized.includes(fragment))
}

/**
 * 掩掉单条字符串里的敏感片段。
 * @param input 原始字符串
 */
export function redactString(input: string): string {
  const protectedInput = protectUuids(input)
  const masked = protectedInput.text
    .replace(HEADER_VALUE_RE, '$1' + REDACTED)
    .replace(SK_KEY_RE, REDACTED)
    .replace(LONG_TOKEN_RE, REDACTED)
  return restoreUuids(masked, protectedInput.uuids)
}

/**
 * 深拷贝并脱敏任意 JSON 化数据；不修改入参。
 * @param input 原始值
 * @param depth 最大递归深度，超出返回 [truncated]
 */
export function redact(input: unknown, depth = 6): unknown {
  return walk(input, Math.trunc(depth), new WeakSet<object>())
}

function walk(value: unknown, depthLeft: number, ancestors: WeakSet<object>): unknown {
  if (depthLeft < 0) return TRUNCATED
  if (value === null || value === undefined) return value
  switch (typeof value) {
    case 'string':
      return redactString(value)
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'symbol':
    case 'function':
      return TRUNCATED
    case 'object':
      return walkObject(value as object, depthLeft, ancestors)
    default:
      return TRUNCATED
  }
}

function walkObject(value: object, depthLeft: number, ancestors: WeakSet<object>): unknown {
  // 只用祖先集合判环：兄弟节点共享引用是合法结构，不该被截断。
  if (ancestors.has(value)) return TRUNCATED
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack === undefined ? {} : { stack: redactString(value.stack) }),
    }
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = value as unknown[]
      return items.map(item => walk(item, depthLeft - 1, ancestors))
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : walk(item, depthLeft - 1, ancestors)
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}