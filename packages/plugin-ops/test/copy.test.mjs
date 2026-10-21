import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONDITIONS,
  COPY_STYLES,
  COPY_STYLE_IDS,
  DEFAULT_STYLE_ID,
  buildCopyRequest,
  parseYuanToCents,
  planCopy,
  renderCopyPrompt,
  resolveCopyStyle,
} from '../src/copy.js'
import { DaemonError } from '../src/client.js'

/** 最小合法输入，用例在此基础上改一个字段。 */
function baseInput(overrides = {}) {
  return {
    productName: 'iPhone 13 128G 星光色',
    condition: 'like-new',
    priceYuan: '129.90',
    ...overrides,
  }
}

function expectValidation(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof DaemonError, true)
    assert.equal(error.code, 'VALIDATION')
    assert.match(error.message, pattern)
    return true
  })
}

test('风格表：id 唯一、每档都有可注入的约束与避坑项', () => {
  assert.equal(COPY_STYLE_IDS.length, 5)
  assert.equal(new Set(COPY_STYLE_IDS).size, COPY_STYLE_IDS.length)
  assert.equal(COPY_STYLE_IDS.includes(DEFAULT_STYLE_ID), true)
  for (const style of COPY_STYLES) {
    assert.match(style.id, /^[a-z]+$/)
    assert.ok(style.label.length > 0)
    assert.ok(style.summary.length > 0)
    assert.ok(style.titleHints.length > 0)
    assert.ok(style.descHints.length > 0)
    assert.ok(style.tagHints.length > 0)
    assert.ok(style.avoid.length > 0)
  }
})

test('resolveCopyStyle：缺省取 plain，未知风格 fail-closed', () => {
  assert.equal(resolveCopyStyle(undefined).id, 'plain')
  assert.equal(resolveCopyStyle('urgent').label, '急出清仓')
  expectValidation(() => resolveCopyStyle('sarcastic'), /未知的文案风格.*sarcastic/)
})

test('parseYuanToCents 按字符串拆，不出现浮点误差', () => {
  assert.equal(parseYuanToCents('129.90'), 12990)
  assert.equal(parseYuanToCents('129.9'), 12990)
  assert.equal(parseYuanToCents('129'), 12900)
  assert.equal(parseYuanToCents('1.0'), 100)
  assert.equal(parseYuanToCents('¥12.34'), 1234)
  assert.equal(parseYuanToCents(120), 12000)
  expectValidation(() => parseYuanToCents('0.99'), /至少 1 元/)
  expectValidation(() => parseYuanToCents('12.345'), /最多两位小数/)
  expectValidation(() => parseYuanToCents('12.3.4'), /最多两位小数/)
  expectValidation(() => parseYuanToCents('abc'), /最多两位小数/)
})

test('buildCopyRequest：非法输入报 VALIDATION，不猜成色/价格', () => {
  expectValidation(() => buildCopyRequest(null), /JSON 对象/)
  expectValidation(() => buildCopyRequest(baseInput({ productName: '  ' })), /商品名/)
  expectValidation(() => buildCopyRequest(baseInput({ productName: 'x'.repeat(121) })), /超过 120 字/)
  expectValidation(() => buildCopyRequest(baseInput({ condition: undefined })), /成色 必填/)
  expectValidation(() => buildCopyRequest(baseInput({ condition: 'mint' })), /成色 只能是/)
  expectValidation(() => buildCopyRequest(baseInput({ priceYuan: undefined })), /最多两位小数/)
  expectValidation(() => buildCopyRequest(baseInput({ priceCents: 99 })), /≥100/)
  expectValidation(() => buildCopyRequest(baseInput({ priceCents: 12.5 })), /≥100/)
  expectValidation(() => buildCopyRequest(baseInput({ shipping: 'paid' })), /运费 只能是/)
  expectValidation(() => buildCopyRequest(baseInput({ variantCount: 4 })), /variantCount/)
  expectValidation(() => buildCopyRequest(baseInput({ flaws: ['划痕', ''] })), /flaws\[1\]/)
  expectValidation(() => buildCopyRequest(baseInput({ specs: { 尺寸: 30 } })), /尺寸 必须是字符串/)
})

test('buildCopyRequest：归一化成 skill 输入契约的字段，缺图记入 missing', () => {
  const { style, facts, missing } = buildCopyRequest(baseInput({
    categoryHint: '数码/手机',
    specs: { 容量: '128G', 颜色: '星光色' },
    flaws: ['边框两处磕碰'],
    accessories: ['原装充电线'],
    variantCount: 2,
    usedAiImages: true,
  }))
  assert.equal(style.id, 'plain')
  assert.deepEqual(facts, {
    productName: 'iPhone 13 128G 星光色',
    condition: 'like-new',
    priceCents: 12990,
    shipping: 'free',
    tone: 'plain',
    variantCount: 2,
    usedAiImages: true,
    categoryHint: '数码/手机',
    specs: { 容量: '128G', 颜色: '星光色' },
    flaws: ['边框两处磕碰'],
    accessories: ['原装充电线'],
  })
  // 面板入口没有图片路径：不阻断出提示词，但必须显式标为待补。
  assert.deepEqual(missing, ['imagePaths'])
  const withImages = buildCopyRequest(baseInput({ imagePaths: ['D:/pics/a.png'] }))
  assert.deepEqual(withImages.missing, [])
  assert.deepEqual(withImages.facts.imagePaths, ['D:/pics/a.png'])
})

test('buildCopyRequest：priceCents 优先于 priceYuan（避免两处解析不一致）', () => {
  const { facts } = buildCopyRequest(baseInput({ priceCents: 8800, priceYuan: '999' }))
  assert.equal(facts.priceCents, 8800)
})

test('renderCopyPrompt：注入风格约束、事实、契约与下一步', () => {
  const request = buildCopyRequest(baseInput({ styleId: 'professional' }))
  const text = renderCopyPrompt(request)
  for (const expected of [
    'skills/xianyu-listing-copy',
    'professional',
    '参数党',
    '【风格约束】',
    '标题：型号 + 关键参数 + 成色，一项不漏',
    '【事实（唯一允许的信息来源，不得编造/推断）】',
    '"productName": "iPhone 13 128G 星光色"',
    '"priceCents": 12990',
    'references/output-schema.json',
    'xianyu-listing-audit',
    '【待补】imagePaths',
    'xy_publish_draft',
  ]) {
    assert.ok(text.includes(expected), '提示词缺少：' + expected)
  }
  // 风格约束必须来自所选风格，不能串档。
  assert.equal(text.includes('不写「最后一天」'), false)
})

test('renderCopyPrompt：同样的输入渲染结果确定（去重、可缓存）', () => {
  const input = baseInput({ styleId: 'urgent', imagePaths: ['D:/pics/a.png'] })
  const first = renderCopyPrompt(buildCopyRequest(input))
  const second = renderCopyPrompt(buildCopyRequest(input))
  assert.equal(first, second)
  assert.equal(first.includes('【待补】'), false)
})

test('planCopy 一次返回文本与归一化请求', () => {
  const { text, request } = planCopy(baseInput({ styleId: 'story' }))
  assert.equal(request.style.id, 'story')
  assert.equal(text.includes('场景氛围'), true)
})

test('成色枚举与 skill 的 input-schema 保持同集合', () => {
  assert.deepEqual(CONDITIONS, ['new', 'like-new', 'light-wear', 'visible-wear', 'flawed'])
})
