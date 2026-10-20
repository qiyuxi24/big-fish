import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FORBIDDEN_CATEGORIES,
  FORBIDDEN_WORDS,
  POLICY_LIMITS,
  checkListing,
} from '../src/policy.ts'
import type { ListingDraft, PolicyIssue, PolicyIssueCode } from '../src/policy.ts'

const BASE: ListingDraft = {
  title: 'iPhone 15 128G 国行',
  description: '国行 iPhone 15，128G 存储，成色 99 新，功能全部正常，配件齐全，支持当面验机，非诚勿扰。',
  priceCents: 300_000,
  imageCount: 3,
  firstImageSquare: true,
  marketPriceCents: 320_000,
  categoryPath: ['数码', '手机'],
}

function draft(overrides: Partial<ListingDraft> = {}): ListingDraft {
  return { ...BASE, ...overrides }
}

/** 去掉可选字段（exactOptionalPropertyTypes 下不能显式传 undefined）。 */
function draftWithout(field: 'marketPriceCents' | 'firstImageSquare'): ListingDraft {
  const copy: ListingDraft = { ...BASE }
  delete copy[field]
  return copy
}

function codes(result: { issues: readonly PolicyIssue[] }): string[] {
  return result.issues.map((item) => item.code)
}

function findIssue(result: { issues: readonly PolicyIssue[] }, code: PolicyIssueCode): PolicyIssue | undefined {
  return result.issues.find((item) => item.code === code)
}

function expectIssue(
  result: { ok: boolean; issues: readonly PolicyIssue[] },
  code: PolicyIssueCode,
  severity: 'error' | 'warn',
  field?: PolicyIssue['field'],
): PolicyIssue {
  const found = findIssue(result, code)
  if (found === undefined) assert.fail('缺少 ' + code + '，实际 issues=' + codes(result).join(','))
  assert.equal(found.severity, severity)
  if (field !== undefined) assert.equal(found.field, field)
  return found
}

function expectNoIssue(result: { issues: readonly PolicyIssue[] }, code: PolicyIssueCode): void {
  assert.equal(findIssue(result, code), undefined, '不应出现 ' + code)
}

test('合法草稿：ok 为 true 且无任何 issue', () => {
  const result = checkListing(BASE)
  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
})

test('TITLE_EMPTY：空白标题是 error', () => {
  for (const title of ['', '   ', '\t\n']) {
    const result = checkListing(draft({ title }))
    expectIssue(result, 'TITLE_EMPTY', 'error', 'title')
    assert.equal(result.ok, false)
  }
})

test('TITLE_TOO_LONG：超过默认 30 字只 warn，不阻塞发布', () => {
  const thirty = checkListing(draft({ title: 'a'.repeat(30) }))
  expectNoIssue(thirty, 'TITLE_TOO_LONG')
  const thirtyOne = checkListing(draft({ title: 'a'.repeat(31) }))
  expectIssue(thirtyOne, 'TITLE_TOO_LONG', 'warn', 'title')
  assert.equal(thirtyOne.ok, true)
})

test('TITLE_EMOJI：标题含 emoji 只 warn', () => {
  const result = checkListing(draft({ title: '全新📱iPhone 15' }))
  expectIssue(result, 'TITLE_EMOJI', 'warn', 'title')
  assert.equal(result.ok, true)
  expectNoIssue(checkListing(BASE), 'TITLE_EMOJI')
})

test('DESC_TOO_SHORT：描述不足 30 字只 warn', () => {
  const result = checkListing(draft({ description: '全新未拆封，包邮' }))
  expectIssue(result, 'DESC_TOO_SHORT', 'warn', 'description')
  assert.equal(result.ok, true)
})

test('DESC_FORBIDDEN_WORD：描述命中违禁词是 error', () => {
  const result = checkListing(draft({ description: '支持高仿对比，价格好聊，欢迎咨询。' }))
  const found = expectIssue(result, 'DESC_FORBIDDEN_WORD', 'error', 'description')
  assert.ok(found.message.includes('高仿'))
  assert.equal(result.ok, false)
})

test('PRICE_INVALID：非正整数分或低于 1 元是 error', () => {
  for (const priceCents of [0, 99, 1.5, Number.NaN, -100]) {
    const result = checkListing(draft({ priceCents }))
    expectIssue(result, 'PRICE_INVALID', 'error', 'price')
    assert.equal(result.ok, false)
  }
  expectNoIssue(checkListing(draft({ priceCents: 100 })), 'PRICE_INVALID')
})

test('PRICE_DEVIATION：偏离市场价超过 70% 只 warn，恰好 70% 不告警', () => {
  const far = checkListing(draft({ priceCents: 10_000, marketPriceCents: 100_000 }))
  const found = expectIssue(far, 'PRICE_DEVIATION', 'warn', 'price')
  assert.ok(found.message.includes('90%'))
  assert.equal(far.ok, true)
  expectNoIssue(checkListing(draft({ priceCents: 30_000, marketPriceCents: 100_000 })), 'PRICE_DEVIATION')
  expectNoIssue(checkListing(draftWithout('marketPriceCents')), 'PRICE_DEVIATION')
})

test('IMAGE_COUNT：0 张或超过 9 张是 error，1 与 9 张通过', () => {
  for (const imageCount of [0, 10, -1, 2.5]) {
    const result = checkListing(draft({ imageCount }))
    expectIssue(result, 'IMAGE_COUNT', 'error', 'images')
    assert.equal(result.ok, false)
  }
  for (const imageCount of [1, 9]) {
    expectNoIssue(checkListing(draft({ imageCount })), 'IMAGE_COUNT')
  }
})

test('IMAGE_FIRST_NOT_SQUARE：首图非 1:1 只 warn，未提供则不告警', () => {
  const result = checkListing(draft({ firstImageSquare: false }))
  expectIssue(result, 'IMAGE_FIRST_NOT_SQUARE', 'warn', 'images')
  assert.equal(result.ok, true)
  expectNoIssue(checkListing(draftWithout('firstImageSquare')), 'IMAGE_FIRST_NOT_SQUARE')
})

test('CATEGORY_FORBIDDEN：禁售类目是 error', () => {
  const result = checkListing(draft({ categoryPath: ['医疗器械', '康复理疗'] }))
  const found = expectIssue(result, 'CATEGORY_FORBIDDEN', 'error', 'category')
  assert.ok(found.message.includes('医疗器械'))
  assert.equal(result.ok, false)
  expectNoIssue(checkListing(BASE), 'CATEGORY_FORBIDDEN')
})

test('只有 warn 时 ok 仍为 true：长标题 + 短描述 + 首图非正方形', () => {
  const result = checkListing(draft({ title: 'a'.repeat(40), description: '短', firstImageSquare: false }))
  assert.ok(result.issues.length >= 3)
  assert.ok(result.issues.every((item) => item.severity === 'warn'))
  assert.equal(result.ok, true)
})

test('多条 error 聚合：空标题 + 非法价格 + 无图 + 禁售类目', () => {
  const result = checkListing(draft({ title: '', priceCents: 0, imageCount: 0, categoryPath: ['药品'] }))
  assert.equal(result.ok, false)
  assert.equal(result.issues.filter((item) => item.severity === 'error').length, 4)
  assert.deepEqual(codes(result).sort(), ['CATEGORY_FORBIDDEN', 'IMAGE_COUNT', 'PRICE_INVALID', 'TITLE_EMPTY'])
})

test('POLICY_LIMITS：默认阈值固定为实测结论', () => {
  assert.equal(POLICY_LIMITS.maxTitleChars, 30)
  assert.equal(POLICY_LIMITS.minDescChars, 30)
  assert.equal(POLICY_LIMITS.maxImages, 9)
  assert.equal(POLICY_LIMITS.priceDeviationRatio, 0.7)
})

test('FORBIDDEN_WORDS：20-40 条、非空且不重复', () => {
  assert.ok(FORBIDDEN_WORDS.length >= 20 && FORBIDDEN_WORDS.length <= 40, '词表长度应为 20-40')
  for (const word of FORBIDDEN_WORDS) {
    assert.equal(typeof word, 'string')
    assert.ok(word.trim().length > 0)
  }
  assert.equal(new Set(FORBIDDEN_WORDS).size, FORBIDDEN_WORDS.length, '词表不应重复')
})

test('FORBIDDEN_CATEGORIES：非空只读字符串表', () => {
  assert.ok(FORBIDDEN_CATEGORIES.length > 0)
  assert.ok(FORBIDDEN_CATEGORIES.every((word) => typeof word === 'string' && word.length > 0))
})

test('options 覆盖：标题/描述/图片阈值可调', () => {
  const longTitle = checkListing(draft({ title: 'a'.repeat(10) }), { maxTitleChars: 5 })
  expectIssue(longTitle, 'TITLE_TOO_LONG', 'warn')

  const shortOk = checkListing(draft({ description: '短' }), { minDescChars: 1 })
  expectNoIssue(shortOk, 'DESC_TOO_SHORT')

  const images = checkListing(draft({ imageCount: 3 }), { maxImages: 2 })
  expectIssue(images, 'IMAGE_COUNT', 'error')
})

test('options 覆盖：价格偏离比例可调', () => {
  const result = checkListing(draft({ priceCents: 80_000, marketPriceCents: 100_000 }), { priceDeviationRatio: 0.1 })
  expectIssue(result, 'PRICE_DEVIATION', 'warn')
  const loose = checkListing(draft({ priceCents: 80_000, marketPriceCents: 100_000 }), { priceDeviationRatio: 0.5 })
  expectNoIssue(loose, 'PRICE_DEVIATION')
})

test('纯函数：冻结草稿也能校验，且不修改入参', () => {
  const frozen = Object.freeze({ ...BASE, categoryPath: Object.freeze(['数码', '手机']) })
  const snapshot = JSON.stringify(frozen)
  const result = checkListing(frozen)
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(frozen), snapshot)
})

test('options 传非法值回退默认阈值，不会把校验关掉', () => {
  const result = checkListing(draft({ title: 'a'.repeat(31), priceCents: 10_000, marketPriceCents: 100_000 }), {
    maxTitleChars: 0,
    minDescChars: Number.NaN,
    maxImages: -1,
    priceDeviationRatio: 0,
  })
  expectIssue(result, 'TITLE_TOO_LONG', 'warn')
  expectIssue(result, 'PRICE_DEVIATION', 'warn')
})