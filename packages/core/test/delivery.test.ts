import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_UTC_OFFSET_MINUTES,
  DELIVERY_BLACKLIST_WORDS,
  isDeliveryActionKind,
  matchDeliveryRule,
  normalizeMatchText,
  validateDeliveryRules,
} from '../src/delivery.ts'
import type { DeliveryMatch, DeliveryRule } from '../src/delivery.ts'
import { XianyuError } from '../src/errors.ts'

/** 基准规则：命中即发固定话术。各用例只覆盖自己关心的字段。 */
const BASE_RULE: DeliveryRule = {
  id: 'rule-base',
  priority: 10,
  enabled: true,
  match: { keywords: ['会员'] },
  action: { kind: 'send_text', text: '稍等，马上把卡密发你' },
}

/** 2026-10-21T00:19:12+08:00；默认东八区下当天第 19 分钟。 */
const NOW = Date.UTC(2026, 9, 20, 16, 19, 12)
/** 东八区 12:00 整（默认时区下 minuteOfDay=720）。 */
const NOON = Date.UTC(2026, 9, 21, 4, 0, 0)
/** UTC 09:00 整，配合 utcOffsetMinutes=0 的时段断言边界。 */
const AT_NINE = Date.UTC(2026, 9, 21, 9, 0, 0)

function rule(overrides: Partial<DeliveryRule> = {}): DeliveryRule {
  return { ...BASE_RULE, ...overrides }
}

/** 校验入参用裸对象：validateDeliveryRules 收 unknown，不需要先满足类型。 */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    priority: 1,
    match: { keywords: ['会员'] },
    action: { kind: 'send_text', text: '马上发' },
    ...overrides,
  }
}

/** 断言抛 XianyuError VALIDATION，并（可选）断言中文提示含关键字。 */
function expectValidation(run: () => void, hint?: string): void {
  let captured: unknown
  assert.throws(run, (error: unknown) => {
    captured = error
    return error instanceof XianyuError && error.code === 'VALIDATION'
  })
  const message = captured instanceof Error ? captured.message : ''
  assert.ok(message.length > 0, '错误必须有中文提示')
  if (hint !== undefined) assert.ok(message.includes(hint), '错误提示应含「' + hint + '」，实际：' + message)
}

function mustMatch(match: DeliveryMatch | undefined, hint: string): DeliveryMatch {
  assert.ok(match !== undefined, hint + '：本应命中')
  return match
}

test('normalizeMatchText：全角转半角、大小写折叠、去 emoji 与空白、保留数字', () => {
  assert.equal(normalizeMatchText('  腾 讯 视 频 ＶＩＰ  '), '腾讯视频vip')
  assert.equal(normalizeMatchText('【腾讯视频】会员✅'), '腾讯视频会员')
  assert.equal(normalizeMatchText('会员★☆〔年卡〕🔥'), '会员年卡')
  assert.equal(normalizeMatchText('A123 型号-256G'), 'a123型号-256g')
  assert.equal(normalizeMatchText('　全角空格　'), '全角空格')
})

test('isDeliveryActionKind：只认四种动作', () => {
  for (const kind of ['send_card', 'send_text', 'handoff', 'reject']) {
    assert.equal(isDeliveryActionKind(kind), true)
  }
  for (const kind of ['refund', '', 'Send_Text', null, 1, undefined]) {
    assert.equal(isDeliveryActionKind(kind), false)
  }
})

test('validateDeliveryRules：补默认值、归一化关键词、不修改入参', () => {
  const input = [raw({ id: ' k1 ', priority: undefined, match: { keywords: ['ＶＩＰ 会员'] } })]
  const snapshot = structuredClone(input)
  const rules = validateDeliveryRules(input)
  assert.equal(rules.length, 1)
  const first = rules[0]
  assert.ok(first !== undefined)
  assert.equal(first.id, 'k1')
  assert.equal(first.priority, 0, '缺省 priority 为 0')
  assert.equal(first.enabled, true, '缺省 enabled 为 true')
  assert.deepEqual(first.match.keywords, ['vip会员'])
  assert.deepEqual(input, snapshot, '入参不得被改写')
})

test('validateDeliveryRules：金额与时段边界合法', () => {
  const rules = validateDeliveryRules([
    raw({ id: 'a', match: { amountCents: { minCents: 0, maxCents: 0 } } }),
    raw({ id: 'b', match: { amountCents: { minCents: 1000 } } }),
    raw({ id: 'c', match: { timeWindow: { startMinute: 1380, endMinute: 60, utcOffsetMinutes: 480 } } }),
    raw({ id: 'd', match: { timeWindow: { startMinute: 0, endMinute: 1440 } } }),
    raw({ id: 'e', match: { minBuyerLevel: 100 } }),
  ])
  assert.equal(rules.length, 5)
  assert.equal(rules[0]?.action.kind, 'send_text')
})

test('validateDeliveryRules：非数组与条目形态非法立即报错', () => {
  expectValidation(() => validateDeliveryRules(null), '必须是数组')
  expectValidation(() => validateDeliveryRules({ rules: [] }), '必须是数组')
  expectValidation(() => validateDeliveryRules([null]), '必须是对象')
  expectValidation(() => validateDeliveryRules(['rule']), '必须是对象')
  expectValidation(() => validateDeliveryRules([raw({ id: '' })]), '缺少非空 id')
  expectValidation(() => validateDeliveryRules([raw({ id: '   ' })]), '缺少非空 id')
  expectValidation(() => validateDeliveryRules([raw({ id: 'x'.repeat(65) })]), 'id 不能超过')
  expectValidation(() => validateDeliveryRules([raw({ id: 'dup' }), raw({ id: 'dup' })]), 'id 重复')
  expectValidation(() => validateDeliveryRules([raw({ priority: -1 })]), 'priority')
  expectValidation(() => validateDeliveryRules([raw({ priority: 1.5 })]), 'priority')
  expectValidation(() => validateDeliveryRules([raw({ enabled: 'yes' })]), 'enabled')
  expectValidation(() => validateDeliveryRules([raw({ match: undefined })]), '缺少 match 对象')
  expectValidation(() => validateDeliveryRules([raw({ match: {} })]), '至少需要一个匹配条件')
})

test('validateDeliveryRules：维度取值非法立即报错', () => {
  expectValidation(() => validateDeliveryRules([raw({ match: { keywords: [] } })]), 'keywords 必须是非空数组')
  expectValidation(() => validateDeliveryRules([raw({ match: { keywords: '会员' } })]), 'keywords 必须是非空数组')
  expectValidation(() => validateDeliveryRules([raw({ match: { keywords: [1] } })]), '只能是字符串')
  expectValidation(() => validateDeliveryRules([raw({ match: { keywords: ['   '] } })]), '空白或纯装饰符')
  expectValidation(() => validateDeliveryRules([raw({ match: { keywords: ['k'.repeat(101)] } })]), '归一化后不能超过')
  expectValidation(
    () => validateDeliveryRules([raw({ match: { keywords: Array.from({ length: 51 }, (_v, i) => 'k' + String(i)) } })]),
    'keywords 不能超过',
  )
  expectValidation(() => validateDeliveryRules([raw({ match: { pattern: '发(货' } })]), '正则非法')
  expectValidation(() => validateDeliveryRules([raw({ match: { pattern: 'x'.repeat(201) } })]), 'pattern 不能超过')
  expectValidation(() => validateDeliveryRules([raw({ match: { pattern: '' } })]), 'pattern 必须是非空字符串')
  expectValidation(() => validateDeliveryRules([raw({ match: { minBuyerLevel: 0 } })]), 'minBuyerLevel')
  expectValidation(() => validateDeliveryRules([raw({ match: { minBuyerLevel: 101 } })]), 'minBuyerLevel')
  expectValidation(() => validateDeliveryRules([raw({ match: { amountCents: { minCents: -1 } } })]), 'minCents')
  expectValidation(() => validateDeliveryRules([raw({ match: { amountCents: {} } })]), '至少要给')
  expectValidation(() => validateDeliveryRules([raw({ match: { amountCents: { minCents: 2000, maxCents: 1000 } } })]), '下限大于上限')
})

test('validateDeliveryRules：时段与动作非法立即报错', () => {
  expectValidation(() => validateDeliveryRules([raw({ match: { timeWindow: { startMinute: 1440, endMinute: 1 } } })]), 'startMinute')
  expectValidation(() => validateDeliveryRules([raw({ match: { timeWindow: { startMinute: 0, endMinute: 0 } } })]), 'endMinute')
  expectValidation(() => validateDeliveryRules([raw({ match: { timeWindow: { startMinute: 60, endMinute: 60 } } })]), '起止相同')
  expectValidation(
    () => validateDeliveryRules([raw({ match: { timeWindow: { startMinute: 0, endMinute: 60, utcOffsetMinutes: 900 } } })]),
    'utcOffsetMinutes',
  )
  expectValidation(() => validateDeliveryRules([raw({ action: { kind: 'refund' } })]), 'action.kind 非法')
  expectValidation(() => validateDeliveryRules([raw({ action: { kind: 'send_text' } })]), '必须提供非空 text')
  expectValidation(() => validateDeliveryRules([raw({ action: { kind: 'send_text', text: '   ' } })]), '必须提供非空 text')
  expectValidation(() => validateDeliveryRules([raw({ action: { kind: 'send_card', text: '请查收' } })]), 'cardKey')
  expectValidation(() => validateDeliveryRules([raw({ action: { kind: 'handoff', cardKey: 'k1' } })]), '只有 send_card')
  expectValidation(() => validateDeliveryRules([raw({ action: { kind: 'send_text', text: 'x'.repeat(2001) } })]), 'action.text 不能超过')
})

test('validateDeliveryRules：发卡密动作保留 cardKey，红线词硬拦', () => {
  const [card] = validateDeliveryRules([raw({ action: { kind: 'send_card', cardKey: ' item-1:spec-2 ', text: '请查收' } })])
  assert.ok(card !== undefined)
  assert.equal(card.action.kind, 'send_card')
  assert.equal(card.action.cardKey, 'item-1:spec-2')
  assert.equal(card.action.text, '请查收')
  for (const word of DELIVERY_BLACKLIST_WORDS) {
    expectValidation(
      () => validateDeliveryRules([raw({ id: 'bad', action: { kind: 'send_text', text: '这里提供' + word + '资源' } })]),
      '红线关键词',
    )
  }
})

test('validateDeliveryRules：规则条数上限', () => {
  const many = Array.from({ length: 501 }, (_v, index) => raw({ id: 'r' + String(index) }))
  expectValidation(() => validateDeliveryRules(many), '不能超过')
})

test('matchDeliveryRule：空规则表与空文本', () => {
  assert.equal(matchDeliveryRule('会员到账了吗', [], NOW), undefined)
  const rules = validateDeliveryRules([raw()])
  assert.equal(matchDeliveryRule('', rules, NOW), undefined)
})

test('matchDeliveryRule：关键词命中，带归一化、hit 与中文原因', () => {
  const rules = validateDeliveryRules([raw({ id: 'kw', match: { keywords: ['腾讯视频VIP'] } })])
  const match = mustMatch(matchDeliveryRule('【腾讯视频】ｖｉｐ 年卡 怎么发货？', rules, NOW), '关键词')
  assert.equal(match.rule.id, 'kw')
  assert.equal(match.hit, '腾讯视频vip')
  assert.deepEqual(match.reasons, ['关键词「腾讯视频vip」'])
})

test('matchDeliveryRule：正则命中，关键词与正则互为 OR', () => {
  const patternRules = validateDeliveryRules([raw({ id: 'p1', match: { pattern: '发货|多久' } })])
  const byPattern = mustMatch(matchDeliveryRule('什么时候发货', patternRules, NOW), '正则')
  assert.equal(byPattern.rule.id, 'p1')
  assert.equal(byPattern.hit, '发货|多久')

  const either = validateDeliveryRules([raw({ id: 'or', match: { keywords: ['到账'], pattern: '发货|多久' } })])
  assert.equal(mustMatch(matchDeliveryRule('还没到账', either, NOW), '关键词分支').rule.id, 'or')
  assert.equal(mustMatch(matchDeliveryRule('多久发货', either, NOW), '正则分支').rule.id, 'or')
  assert.equal(matchDeliveryRule('今天天气不错', either, NOW), undefined)
})

test('matchDeliveryRule：priority 越小越先，同优先级取数组靠前，禁用规则跳过', () => {
  const rules: DeliveryRule[] = [
    rule({ id: 'late', priority: 30 }),
    rule({ id: 'first', priority: 5 }),
    rule({ id: 'also-five', priority: 5 }),
    rule({ id: 'disabled', priority: 0, enabled: false }),
  ]
  const match = mustMatch(matchDeliveryRule('会员', rules, NOW), 'priority')
  assert.equal(match.rule.id, 'first')
  // 同优先级稳定：'also-five' 与 'first' 都是 5，数组里 first 在前。
  const tie = mustMatch(matchDeliveryRule('会员', [rule({ id: 'a', priority: 1 }), rule({ id: 'b', priority: 1 })], NOW), '同优先级')
  assert.equal(tie.rule.id, 'a')
  // 高优先级被禁用时不参与。
  assert.equal(mustMatch(matchDeliveryRule('会员', [rule({ id: 'only' })], NOW), '禁用场景基准').rule.id, 'only')
})

test('matchDeliveryRule：买家等级维度，缺上下文时不命中（fail-closed）', () => {
  const rules: DeliveryRule[] = [rule({ id: 'vip', match: { minBuyerLevel: 3 } })]
  assert.equal(matchDeliveryRule('会员', rules, NOW), undefined)
  assert.equal(matchDeliveryRule('会员', rules, NOW, { buyerLevel: 2 }), undefined)
  const match = mustMatch(matchDeliveryRule('会员', rules, NOW, { buyerLevel: 3 }), '等级刚好达标')
  assert.ok(match.reasons.includes('买家等级≥3'))
})

test('matchDeliveryRule：金额区间边界闭区间，缺上下文不命中', () => {
  const rules: DeliveryRule[] = [rule({ id: 'amount', match: { amountCents: { minCents: 1000, maxCents: 2000 } } })]
  assert.equal(matchDeliveryRule('会员', rules, NOW), undefined)
  assert.equal(matchDeliveryRule('会员', rules, NOW, { amountCents: 999 }), undefined)
  assert.equal(matchDeliveryRule('会员', rules, NOW, { amountCents: 2001 }), undefined)
  assert.ok(mustMatch(matchDeliveryRule('会员', rules, NOW, { amountCents: 1000 }), '下限包含').reasons.includes('金额区间命中'))
  assert.ok(mustMatch(matchDeliveryRule('会员', rules, NOW, { amountCents: 2000 }), '上限包含').reasons.includes('金额区间命中'))
})

test('matchDeliveryRule：时段边界（含起点不含终点）与跨零点', () => {
  const dayWindow: DeliveryRule[] = [rule({ id: 'day', match: { timeWindow: { startMinute: 540, endMinute: 600, utcOffsetMinutes: 0 } } })]
  assert.ok(mustMatch(matchDeliveryRule('会员', dayWindow, AT_NINE), '起点含'), 'startMinute 端点应命中')
  assert.ok(mustMatch(matchDeliveryRule('会员', dayWindow, AT_NINE + 59 * 60_000), '9:59 命中'))
  assert.equal(matchDeliveryRule('会员', dayWindow, AT_NINE + 60 * 60_000), undefined, 'endMinute 端点不含')

  const midnight: DeliveryRule[] = [rule({ id: 'night', match: { timeWindow: { startMinute: 1380, endMinute: 60, utcOffsetMinutes: 0 } } })]
  assert.ok(mustMatch(matchDeliveryRule('会员', midnight, Date.UTC(2026, 9, 21, 23, 30)), '23:30 命中'))
  assert.ok(mustMatch(matchDeliveryRule('会员', midnight, Date.UTC(2026, 9, 21, 0, 30)), '00:30 命中'))
  assert.equal(matchDeliveryRule('会员', midnight, Date.UTC(2026, 9, 21, 12, 0)), undefined, '12:00 不命中')
})

test('matchDeliveryRule：时段默认东八区', () => {
  const rules: DeliveryRule[] = [rule({ id: 'noon', match: { timeWindow: { startMinute: 720, endMinute: 780 } } })]
  assert.ok(mustMatch(matchDeliveryRule('会员', rules, NOON), '东八区 12:00 命中'))
  assert.equal(matchDeliveryRule('会员', rules, NOON - 60 * 60_000), undefined, '东八区 11:00 不命中')
  assert.equal(DEFAULT_UTC_OFFSET_MINUTES, 480)
})

test('matchDeliveryRule：入参非法立即报 VALIDATION', () => {
  expectValidation(() => matchDeliveryRule(42 as unknown as string, [], NOW), 'text')
  expectValidation(() => matchDeliveryRule('会员', 'oops' as unknown as DeliveryRule[], NOW), 'rules')
  expectValidation(() => matchDeliveryRule('会员', [], -1), 'now')
  expectValidation(() => matchDeliveryRule('会员', [], 1.5), 'now')
  expectValidation(() => matchDeliveryRule('会员', [], Number.MAX_SAFE_INTEGER + 2), 'now')
})

test('matchDeliveryRule：绕过校验的非法正则在匹配期也必须报错', () => {
  const broken: DeliveryRule[] = [rule({ id: 'broken', match: { pattern: '发(货' } })]
  expectValidation(() => matchDeliveryRule('发货了吗', broken, NOW), '正则非法')
})
