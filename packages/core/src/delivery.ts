/**
 * 自动发货规则引擎（纯函数、零 IO）。
 *
 * 规则匹配是发货决策里最需要回归的部分：同一段买家消息 + 同一张规则表，任何机器上都必须得到
 * 同一个动作。这里不读时钟（now 注入）、不读环境、不碰网络/DB；daemon 的 deliver 执行器拿到
 * 订单后调它，测试用假时钟钉死边界。依据 docs/delivery-rules.md：规则外置、金额整数分、
 * 命中「宁可漏（转人工）也不能错发」、需要上下文而上下文缺失时不算命中。
 * @module @bigfish/core/delivery
 */
import { fail } from './errors.ts'

/** 命中后的动作：发卡密 / 发固定话术 / 转人工 / 拒绝。 */
export type DeliveryActionKind = 'send_card' | 'send_text' | 'handoff' | 'reject'

/** 动作定义；text 是 send_text 的整段话术，也给 send_card 当附言。 */
export interface DeliveryAction {
  kind: DeliveryActionKind
  /** send_text 必填；send_card 可选附言；handoff/reject 可选给卖家看的说明。 */
  text?: string
  /** send_card 必填：卡密池键（如 itemId:specId），卡密明文不进规则表。 */
  cardKey?: string
}

/** 订单金额区间（闭区间，整数分）；至少给一个边界，缺省侧不限。 */
export interface DeliveryAmountRange {
  minCents?: number
  maxCents?: number
}

/** 每日时段（本地时间，当天第几分钟，闭开区间）；start > end 表示跨零点。 */
export interface DeliveryTimeWindow {
  /** 含，0..1439。 */
  startMinute: number
  /** 不含，1..1440（1440 表示到当天结束）。 */
  endMinute: number
  /** 时区偏移（分钟，东八区=480）；缺省用 DEFAULT_UTC_OFFSET_MINUTES。 */
  utcOffsetMinutes?: number
}

/** 匹配条件；同一维度内（keywords/pattern）取 OR，不同维度之间取 AND。 */
export interface DeliveryMatchCondition {
  /** 关键词任一命中（两侧都过 normalizeMatchText，忽略全半角/大小写/空白/emoji）。 */
  keywords?: readonly string[]
  /** 正则源码；校验期编译一次，非法立即报 VALIDATION。 */
  pattern?: string
  /** 买家等级下限（平台会员等级，1..100）。 */
  minBuyerLevel?: number
  /** 订单金额区间（整数分）。 */
  amountCents?: DeliveryAmountRange
  /** 每日时段（默认东八区）。 */
  timeWindow?: DeliveryTimeWindow
}

/** 一条发货规则；priority 越小越先匹配，同优先级按数组顺序。 */
export interface DeliveryRule {
  id: string
  priority: number
  enabled: boolean
  match: DeliveryMatchCondition
  action: DeliveryAction
}

/** 匹配时可选的订单上下文；缺失则相关维度视为未知，规则不命中（宁可漏发转人工）。 */
export interface DeliveryMatchContext {
  /** 平台会员等级；未知不传。 */
  buyerLevel?: number
  /** 订单实付金额（整数分）；未知不传。 */
  amountCents?: number
}

/** 命中结果；rule 是胜出的规则，reasons 是中文审计摘要。 */
export interface DeliveryMatch {
  rule: DeliveryRule
  /** 命中的关键词（已归一化）或正则源码；纯等级/金额/时段规则没有。 */
  hit?: string
  reasons: readonly string[]
}

/** 全部动作类型白名单（校验与 daemon 分支共用）。 */
export const DELIVERY_ACTION_KINDS: readonly DeliveryActionKind[] = ['send_card', 'send_text', 'handoff', 'reject']
/** 命中即拦截的红线货源词（docs/delivery-rules.md §5.2）：这类规则的「发货内容」本身就是侵权证据。 */
export const DELIVERY_BLACKLIST_WORDS: readonly string[] = ['破解', '盗版', '共享账号', '代充']
export const MAX_DELIVERY_RULES = 500
export const MAX_DELIVERY_KEYWORDS = 50
export const MAX_KEYWORD_CHARS = 100
export const MAX_PATTERN_CHARS = 200
export const MAX_RULE_ID_CHARS = 64
export const MAX_CARD_KEY_CHARS = 128
export const MAX_ACTION_TEXT_CHARS = 2000
export const MAX_BUYER_LEVEL = 100
/** 默认时区偏移：东八区（闲鱼主体用户在国内）；规则可逐条覆盖。 */
export const DEFAULT_UTC_OFFSET_MINUTES = 480

const MINUTES_PER_DAY = 1440
const MS_PER_MINUTE = 60_000
/** emoji/装饰符与成对方括号：匹配前抹掉，避免「【腾讯会员】」和「腾讯会员」算两条规则。 */
const NOISE_PATTERN = /[\p{Extended_Pictographic}\uFE0F\u200D\u20E3\u2605\u2606\u3010\u3011\u3014\u3015]/gu
const WHITESPACE_PATTERN = /\s+/g

/** 对象窄化：排除 null 与数组（数组 typeof 也是 object，是最常见的误判来源）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isSafeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function isSafeLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}
/** 动作类型判定（同时服务于校验与 daemon 的分支守卫）。 */
export function isDeliveryActionKind(value: unknown): value is DeliveryActionKind {
  return typeof value === 'string' && (DELIVERY_ACTION_KINDS as readonly string[]).includes(value)
}
/**
 * 文本归一化：NFKC（全角→半角、兼容字符折叠）→ 小写 → 去 emoji/装饰符 → 去空白。
 * 数字保留（型号/容量是关键区分符，不能折叠掉）。
 */
export function normalizeMatchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(NOISE_PATTERN, '').replace(WHITESPACE_PATTERN, '')
}
/** 当天第几分钟；用偏移把 epoch ms 折算到规则所在时区。 */
function minutesOfDay(now: number, utcOffsetMinutes: number): number {
  const dayMs = MINUTES_PER_DAY * MS_PER_MINUTE
  const shifted = now + utcOffsetMinutes * MS_PER_MINUTE
  const withinDay = ((shifted % dayMs) + dayMs) % dayMs
  return Math.floor(withinDay / MS_PER_MINUTE)
}
function inTimeWindow(window: DeliveryTimeWindow, now: number): boolean {
  const minute = minutesOfDay(now, window.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES)
  if (window.startMinute < window.endMinute) return minute >= window.startMinute && minute < window.endMinute
  // 跨零点：[start, 24:00) ∪ [0, end)
  return minute >= window.startMinute || minute < window.endMinute
}
function inAmountRange(range: DeliveryAmountRange, amountCents: number): boolean {
  if (range.minCents !== undefined && amountCents < range.minCents) return false
  if (range.maxCents !== undefined && amountCents > range.maxCents) return false
  return true
}
/** 编译用户正则；绕过校验直接构造的非法正则在匹配期也必须炸，不能静默改变发货决策。 */
function compilePattern(source: string, ruleId: string): RegExp {
  try {
    return new RegExp(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail('VALIDATION', '规则 ' + ruleId + ' 的正则非法：' + source + '（' + message + '）')
  }
}
interface TextMatch {
  ok: boolean
  hit?: string
  reason?: string
}
/** 文本维度：keywords 与 pattern 互为替代（OR），都缺省则不限制文本。 */
function matchTextDimension(condition: DeliveryMatchCondition, text: string, ruleId: string): TextMatch {
  const keywords = condition.keywords
  const patternSource = condition.pattern
  if (keywords === undefined && patternSource === undefined) return { ok: true }
  if (keywords !== undefined) {
    const hit = keywords.find((keyword) => text.includes(keyword))
    if (hit !== undefined) return { ok: true, hit, reason: '关键词「' + hit + '」' }
  }
  if (patternSource !== undefined && compilePattern(patternSource, ruleId).test(text)) {
    return { ok: true, hit: patternSource, reason: '正则 ' + patternSource }
  }
  return { ok: false }
}
function matchRule(rule: DeliveryRule, text: string, now: number, context: DeliveryMatchContext | undefined): DeliveryMatch | undefined {
  const condition = rule.match
  const textMatch = matchTextDimension(condition, text, rule.id)
  if (!textMatch.ok) return undefined
  const reasons: string[] = textMatch.reason === undefined ? [] : [textMatch.reason]
  const minLevel = condition.minBuyerLevel
  const buyerLevel = context?.buyerLevel
  if (minLevel !== undefined && (!isSafeLevel(buyerLevel) || buyerLevel < minLevel)) return undefined
  if (minLevel !== undefined) reasons.push('买家等级≥' + String(minLevel))
  const range = condition.amountCents
  const amountCents = context?.amountCents
  if (range !== undefined && (!isSafeAmount(amountCents) || !inAmountRange(range, amountCents))) return undefined
  if (range !== undefined) reasons.push('金额区间命中')
  const window = condition.timeWindow
  if (window !== undefined && !inTimeWindow(window, now)) return undefined
  if (window !== undefined) reasons.push('时段命中')
  const match: DeliveryMatch = { rule, reasons }
  if (textMatch.hit !== undefined) match.hit = textMatch.hit
  return match
}
/**
 * 按优先级匹配一条发货规则。纯函数：不改入参、不读环境、now 由调用方注入。
 *
 * 规则须先过 validateDeliveryRules（keywords 在那里已归一化）；返回最高优先级（priority 最小、
 * 同值取数组靠前）的命中规则。需要 buyerLevel/amountCents 而 context 未提供时规则不命中：
 * 自动发货允许漏发转人工，不允许凭猜测发错卡密。
 */
export function matchDeliveryRule(
  text: string,
  rules: DeliveryRule[],
  now: number,
  context?: DeliveryMatchContext,
): DeliveryMatch | undefined {
  if (typeof text !== 'string') fail('VALIDATION', 'text 必须是字符串')
  if (!Array.isArray(rules)) fail('VALIDATION', 'rules 必须是规则数组')
  if (!Number.isSafeInteger(now) || now < 0) fail('VALIDATION', 'now 必须是非负整数毫秒（注入时钟）')
  const normalizedText = normalizeMatchText(text)
  // Array.prototype.sort 稳定：同 priority 保持传入顺序，判定因此可复现。
  const ordered = [...rules].sort((left, right) => left.priority - right.priority)
  for (const rule of ordered) {
    if (!rule.enabled) continue
    const match = matchRule(rule, normalizedText, now, context)
    if (match !== undefined) return match
  }
  return undefined
}
function validateRuleId(value: unknown, position: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('VALIDATION', position + '缺少非空 id')
  const id = value.trim()
  if (id.length > MAX_RULE_ID_CHARS) fail('VALIDATION', position + '的 id 不能超过 ' + String(MAX_RULE_ID_CHARS) + ' 个字符')
  return id
}
function validatePriority(value: unknown, ruleId: string): number {
  if (!isSafeAmount(value)) fail('VALIDATION', '规则 ' + ruleId + ' 的 priority 必须是 ≥0 的整数（越小越先匹配）')
  return value
}
function validateKeywords(value: unknown, ruleId: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) fail('VALIDATION', '规则 ' + ruleId + ' 的 keywords 必须是非空数组')
  if (value.length > MAX_DELIVERY_KEYWORDS) {
    fail('VALIDATION', '规则 ' + ruleId + ' 的 keywords 不能超过 ' + String(MAX_DELIVERY_KEYWORDS) + ' 个')
  }
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') fail('VALIDATION', '规则 ' + ruleId + ' 的 keywords 只能是字符串')
    const keyword = normalizeMatchText(item)
    if (keyword.length === 0) fail('VALIDATION', '规则 ' + ruleId + ' 的 keywords 含空白或纯装饰符，无法匹配')
    if (keyword.length > MAX_KEYWORD_CHARS) {
      fail('VALIDATION', '规则 ' + ruleId + ' 的关键词归一化后不能超过 ' + String(MAX_KEYWORD_CHARS) + ' 字')
    }
    normalized.push(keyword)
  }
  return normalized
}
function validatePattern(value: unknown, ruleId: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) fail('VALIDATION', '规则 ' + ruleId + ' 的 pattern 必须是非空字符串')
  if (value.length > MAX_PATTERN_CHARS) fail('VALIDATION', '规则 ' + ruleId + ' 的 pattern 不能超过 ' + String(MAX_PATTERN_CHARS) + ' 字符')
  compilePattern(value, ruleId)
  return value
}
function validateMinBuyerLevel(value: unknown, ruleId: string): number | undefined {
  if (value === undefined) return undefined
  if (!isSafeLevel(value) || value > MAX_BUYER_LEVEL) {
    fail('VALIDATION', '规则 ' + ruleId + ' 的 minBuyerLevel 必须是 1..' + String(MAX_BUYER_LEVEL) + ' 的整数')
  }
  return value
}
function validateAmountRange(value: unknown, ruleId: string): DeliveryAmountRange | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('VALIDATION', '规则 ' + ruleId + ' 的 amountCents 必须是 {minCents?, maxCents?} 对象')
  const range: DeliveryAmountRange = {}
  const minCents = value.minCents
  if (minCents !== undefined) {
    if (!isSafeAmount(minCents)) fail('VALIDATION', '规则 ' + ruleId + ' 的 amountCents.minCents 必须是非负整数分')
    range.minCents = minCents
  }
  const maxCents = value.maxCents
  if (maxCents !== undefined) {
    if (!isSafeAmount(maxCents)) fail('VALIDATION', '规则 ' + ruleId + ' 的 amountCents.maxCents 必须是非负整数分')
    range.maxCents = maxCents
  }
  if (range.minCents === undefined && range.maxCents === undefined) {
    fail('VALIDATION', '规则 ' + ruleId + ' 的 amountCents 至少要给 minCents 或 maxCents 一个边界')
  }
  if (range.minCents !== undefined && range.maxCents !== undefined && range.minCents > range.maxCents) {
    fail('VALIDATION', '规则 ' + ruleId + ' 的 amountCents 下限大于上限，永远不会命中')
  }
  return range
}
function validateTimeWindow(value: unknown, ruleId: string): DeliveryTimeWindow | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('VALIDATION', '规则 ' + ruleId + ' 的 timeWindow 必须是对象')
  const startMinute = value.startMinute
  const endMinute = value.endMinute
  if (!isIntInRange(startMinute, 0, MINUTES_PER_DAY - 1)) {
    fail('VALIDATION', '规则 ' + ruleId + ' 的 timeWindow.startMinute 必须是 0..1439 的整数（当天第几分钟）')
  }
  if (!isIntInRange(endMinute, 1, MINUTES_PER_DAY)) {
    fail('VALIDATION', '规则 ' + ruleId + ' 的 timeWindow.endMinute 必须是 1..1440 的整数（不含端点）')
  }
  if (startMinute === endMinute) {
    fail('VALIDATION', '规则 ' + ruleId + ' 的 timeWindow 起止相同会永不命中；跨零点请让 endMinute 小于 startMinute')
  }
  const window: DeliveryTimeWindow = { startMinute, endMinute }
  const offset = value.utcOffsetMinutes
  if (offset !== undefined) {
    if (!isIntInRange(offset, -720, 840)) fail('VALIDATION', '规则 ' + ruleId + ' 的 timeWindow.utcOffsetMinutes 必须是 -720..840 的整数（分钟）')
    window.utcOffsetMinutes = offset
  }
  return window
}
function assertNoBlacklistWord(text: string, ruleId: string): void {
  for (const word of DELIVERY_BLACKLIST_WORDS) {
    if (text.includes(word)) {
      fail('VALIDATION', '规则 ' + ruleId + ' 的发货内容含红线关键词「' + word + '」：自动发货不得用于盗版/共享账号/代充等货源（docs/delivery-rules.md §5）')
    }
  }
}
function validateActionText(value: unknown, ruleId: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail('VALIDATION', '规则 ' + ruleId + ' 的 action.text 必须是字符串')
  const text = value.trim()
  if (text.length === 0) return undefined
  if (Array.from(text).length > MAX_ACTION_TEXT_CHARS) {
    fail('VALIDATION', '规则 ' + ruleId + ' 的 action.text 不能超过 ' + String(MAX_ACTION_TEXT_CHARS) + ' 字')
  }
  assertNoBlacklistWord(text, ruleId)
  return text
}
function validateCardKey(value: unknown, ruleId: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) fail('VALIDATION', '规则 ' + ruleId + ' 的 action.cardKey 必须是非空字符串')
  const cardKey = value.trim()
  if (cardKey.length > MAX_CARD_KEY_CHARS) fail('VALIDATION', '规则 ' + ruleId + ' 的 action.cardKey 不能超过 ' + String(MAX_CARD_KEY_CHARS) + ' 个字符')
  return cardKey
}
function validateAction(value: unknown, ruleId: string): DeliveryAction {
  if (!isRecord(value)) fail('VALIDATION', '规则 ' + ruleId + ' 缺少 action 对象')
  const kind = value.kind
  if (!isDeliveryActionKind(kind)) {
    fail('VALIDATION', '规则 ' + ruleId + ' 的 action.kind 非法：' + String(kind) + '，可选 ' + DELIVERY_ACTION_KINDS.join('/'))
  }
  const text = validateActionText(value.text, ruleId)
  const cardKey = validateCardKey(value.cardKey, ruleId)
  if (kind === 'send_text' && text === undefined) fail('VALIDATION', '规则 ' + ruleId + ' 的 send_text 动作必须提供非空 text')
  if (kind === 'send_card') {
    if (cardKey === undefined) fail('VALIDATION', '规则 ' + ruleId + ' 的 send_card 动作必须提供 cardKey（卡密池键）')
  } else if (cardKey !== undefined) {
    fail('VALIDATION', '规则 ' + ruleId + ' 只有 send_card 动作可以使用 cardKey')
  }
  const action: DeliveryAction = { kind }
  if (text !== undefined) action.text = text
  if (cardKey !== undefined) action.cardKey = cardKey
  return action
}
function validateMatch(value: unknown, ruleId: string): DeliveryMatchCondition {
  if (!isRecord(value)) fail('VALIDATION', '规则 ' + ruleId + ' 缺少 match 对象')
  const condition: DeliveryMatchCondition = {}
  let dimensions = 0
  const keywords = validateKeywords(value.keywords, ruleId)
  if (keywords !== undefined) { condition.keywords = keywords; dimensions += 1 }
  const pattern = validatePattern(value.pattern, ruleId)
  if (pattern !== undefined) { condition.pattern = pattern; dimensions += 1 }
  const minBuyerLevel = validateMinBuyerLevel(value.minBuyerLevel, ruleId)
  if (minBuyerLevel !== undefined) { condition.minBuyerLevel = minBuyerLevel; dimensions += 1 }
  const amountCents = validateAmountRange(value.amountCents, ruleId)
  if (amountCents !== undefined) { condition.amountCents = amountCents; dimensions += 1 }
  const timeWindow = validateTimeWindow(value.timeWindow, ruleId)
  if (timeWindow !== undefined) { condition.timeWindow = timeWindow; dimensions += 1 }
  // 没有任何条件等于「对所有订单生效」，自动发货里这相当于无差别发卡，必须拦住。
  if (dimensions === 0) {
    fail('VALIDATION', '规则 ' + ruleId + ' 至少需要一个匹配条件（keywords/pattern/minBuyerLevel/amountCents/timeWindow），否则会命中所有订单')
  }
  return condition
}
function validateRule(value: unknown, index: number, seenIds: Set<string>): DeliveryRule {
  const position = '第 ' + String(index + 1) + ' 条规则'
  if (!isRecord(value)) fail('VALIDATION', position + '必须是对象')
  const id = validateRuleId(value.id, position)
  if (seenIds.has(id)) fail('VALIDATION', position + '的 id 重复：' + id)
  seenIds.add(id)
  const priority = value.priority === undefined ? 0 : validatePriority(value.priority, id)
  const enabled = value.enabled === undefined ? true : value.enabled
  if (typeof enabled !== 'boolean') fail('VALIDATION', '规则 ' + id + ' 的 enabled 必须是布尔值')
  return { id, priority, enabled, match: validateMatch(value.match, id), action: validateAction(value.action, id) }
}
/**
 * 校验并归一化规则表（HTTP 入参、xlsx/txt 导入都先过这里）。
 * 非法立即抛 XianyuError VALIDATION（中文提示，带规则位置/id）；不修改入参，返回新对象。
 */
export function validateDeliveryRules(input: unknown): DeliveryRule[] {
  if (!Array.isArray(input)) fail('VALIDATION', '发货规则必须是数组')
  if (input.length > MAX_DELIVERY_RULES) fail('VALIDATION', '发货规则不能超过 ' + String(MAX_DELIVERY_RULES) + ' 条')
  const seenIds = new Set<string>()
  return input.map((value, index) => validateRule(value, index, seenIds))
}
