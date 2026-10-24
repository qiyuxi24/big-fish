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
    '.agents/skills/xianyu-listing-copy',
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

test('出售原因 / 使用时长：给了进 facts，没给就不出现（不替用户编故事）', () => {
  const { facts } = buildCopyRequest(baseInput({ reason: '换 16 后闲置', usedMonths: 18 }))
  assert.equal(facts.reason, '换 16 后闲置')
  assert.equal(facts.usedMonths, 18)

  const bare = buildCopyRequest(baseInput())
  assert.equal('reason' in bare.facts, false)
  assert.equal('usedMonths' in bare.facts, false)

  expectValidation(() => buildCopyRequest(baseInput({ usedMonths: 601 })), /usedMonths/)
  expectValidation(() => buildCopyRequest(baseInput({ usedMonths: 1.5 })), /usedMonths/)
  expectValidation(() => buildCopyRequest(baseInput({ reason: '   ' })), /出售原因/)
})

/** 市场简报样本（xy_market_brief 的输出形态，数字随便取但形态要全）。 */
function marketSample(overrides = {}) {
  return {
    sampleSize: 24,
    priceCents: { p25: 2000, p50: 2800, p75: 3500 },
    priceSuggestion: { lowCents: 2500, suggestedCents: 2800, highCents: 3200, basis: '同类中位 × 1.0（几乎全新）' },
    titleSegmentsAvg: 3.5,
    descSentencesAvg: 4.2,
    bracketTagRatio: 0.4,
    ctaRatio: 0.6,
    imageCountAvg: 3.2,
    imageAspect: '方图',
    keywords: ['高数笔记', '考研', '手写'],
    ...overrides,
  }
}

test('市场简报进提示词：价格带/结构/图片规格/高频词，且明确「不得照抄」', () => {
  const { text, request } = planCopy(baseInput({ market: marketSample() }))
  assert.equal(request.market.sampleSize, 24)
  assert.match(text, /【市场参考（已采集他人商品的统计：只学结构与价格带，不得照抄原句\/原图）】/)
  assert.match(text, /价格带 ¥20\.00 ~ ¥35\.00，中位 ¥28\.00；样本 24 件/)
  assert.match(text, /建议价 ¥28\.00（区间 ¥25\.00 ~ ¥32\.00）：同类中位/)
  assert.match(text, /标题均 3\.5 段、描述均 4\.2 句；带标签 40%、含行动号召 60%/)
  assert.match(text, /图片：均 3\.2 张，主图以方图为主/)
  assert.match(text, /高频词（选词参考，别整段照搬）：高数笔记、考研、手写/)
  assert.match(text, /偏离超过 30% 时，在 `warnings` 里写一条理由/)
  // 市场段后面要留空行，否则「定价」那条会跟【输入契约】粘成一行。
  assert.match(text, /\n\n【输入契约】/)
})

test('样本价格跨度大时提示「只当量级参考」，跨度小时不插话', () => {
  const wide = planCopy(baseInput({ market: marketSample({ priceCents: { p25: 480, p50: 900, p75: 15000, min: 388, max: 15000 } }) }))
  assert.match(wide.text, /- 注意：样本价格跨度 38\.7 倍（¥3\.88 ~ ¥150\.00）/)
  assert.match(wide.text, /按同款再核一遍/)

  const narrow = planCopy(baseInput({ market: marketSample({ priceCents: { p25: 2000, p50: 2800, p75: 3000, min: 2000, max: 3000 } }) }))
  assert.equal(narrow.text.includes('样本价格跨度'), false)
})

test('没有简报 / 样本为 0 时不渲染市场参考段（不塞一堆 0 误导模型）', () => {
  const plain = planCopy(baseInput())
  assert.equal(plain.request.market, undefined)
  assert.equal(plain.text.includes('【市场参考'), false)

  const empty = planCopy(baseInput({ market: marketSample({ sampleSize: 0 }) }))
  assert.equal(empty.text.includes('【市场参考'), false)
  // 没有市场段时不要凭空多出空行。
  assert.match(plain.text, /\n\n【输入契约】/)
  assert.equal(plain.text.includes('\n\n\n【输入契约】'), false)
})

test('简报字段做窄化：缺字段补 0，坏 JSON（数组/字符串）显式 VALIDATION', () => {
  const { market } = buildCopyRequest(baseInput({ market: { sampleSize: 3 } }))
  assert.deepEqual(market.priceCents, { p25: 0, p50: 0, p75: 0, min: 0, max: 0 })
  assert.equal(market.imageAspect, '未测')
  assert.deepEqual(market.keywords, [])

  // 建议价缺失时不渲染；但结构行仍在（有样本就得给出结构参考）。
  const text = planCopy(baseInput({ market: { sampleSize: 3, titleSegmentsAvg: 2 } })).text
  assert.match(text, /【市场参考/)
  assert.equal(text.includes('- 建议价 '), false)

  expectValidation(() => buildCopyRequest(baseInput({ market: ['x'] })), /market 必须是 JSON 对象/)
  expectValidation(() => buildCopyRequest(baseInput({ market: 'x' })), /market 必须是 JSON 对象/)
})

test('成色枚举与 skill 的 input-schema 保持同集合', () => {
  assert.deepEqual(CONDITIONS, ['new', 'like-new', 'light-wear', 'visible-wear', 'flawed'])
})
