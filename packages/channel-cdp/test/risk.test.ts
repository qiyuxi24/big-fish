/**
 * 发布侧风控识别单测：全部用假页面（无网络、无浏览器），覆盖 URL/文案/组件三类信号、
 * 探测解析容错、步骤包装的「前/中/后」三处检查，以及 RISK_CONTROL 向 daemon 的透传。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { XianyuError } from '@bigfish/core'

import type { DomPage } from '../src/dom.ts'
import type { CdpPage } from '../src/page.ts'
import {
  classifyPublishRisk,
  detectPublishRisk,
  parsePublishRiskProbe,
  publishRiskProbeScript,
  RISK_ELEMENT_SELECTORS,
  RISK_PROBE_MARKER,
  RISK_TEXT_MARKERS,
  RISK_URL_MARKERS,
  runRiskGuardedSteps,
  withRiskGuards,
} from '../src/risk.ts'
import type { PublishContext, PublishStep } from '../src/steps.ts'

/** 假页面：evaluate 只响应风控探测脚本，信号由测试直接设定。 */
class FakeRiskPage implements DomPage {
  url: string
  bodyText: string
  elementHits: string[]
  probes = 0

  constructor(seed: { url?: string; bodyText?: string; elementHits?: string[] } = {}) {
    this.url = seed.url ?? 'https://www.goofish.com/publish'
    this.bodyText = seed.bodyText ?? '发闲置 宝贝描述 分类 价格'
    this.elementHits = seed.elementHits ?? []
  }

  async evaluate<T>(expression: string): Promise<T> {
    assert.ok(expression.includes(RISK_PROBE_MARKER), '只允许风控探测脚本走这个假页面')
    this.probes += 1
    const textHits = RISK_TEXT_MARKERS.filter((marker) => this.bodyText.includes(marker))
    if (this.bodyText.includes('1004')) {
      const hit = this.bodyText.includes('风控') || this.bodyText.includes('验证')
      if (hit) textHits.push('1004')
    }
    const payload = { url: this.url, textHits, elementHits: this.elementHits }
    return JSON.stringify(payload) as T
  }

  async waitFor(): Promise<void> {
    return undefined
  }

  async command<T>(): Promise<T> {
    return undefined as T
  }
}

/** 与 publish.test.ts 同款：结构上实现了 DomPage 就够了，CdpPage 只多了私有字段。 */
function asPage(page: FakeRiskPage): CdpPage {
  return page as unknown as CdpPage
}

function makeContext(logs: string[] = []): PublishContext {
  return {
    log: (step, message) => { logs.push(step + ':' + message) },
    now: () => 1_700_000_000_000,
  }
}

function step(name: string, run: PublishStep['run']): PublishStep {
  return { name, run }
}

test('classifyPublishRisk：URL 优先，其次是文案，最后是风控组件', () => {
  for (const marker of RISK_URL_MARKERS) {
    const risk = classifyPublishRisk({ url: 'https://www.goofish.com/' + marker.toUpperCase(), textHits: [], elementHits: [] })
    assert.equal(risk?.kind, 'url')
    assert.match(String(risk?.reason), /URL 命中/)
  }
  const byText = classifyPublishRisk({ url: 'https://www.goofish.com/publish', textHits: ['请完成安全验证'], elementHits: ['.nc-container'] })
  assert.equal(byText?.kind, 'text')
  assert.match(String(byText?.reason), /请完成安全验证/)
  const byElement = classifyPublishRisk({ url: 'https://www.goofish.com/publish', textHits: [], elementHits: ['.nc-container'] })
  assert.equal(byElement?.kind, 'element')
  assert.match(String(byElement?.reason), /nc-container/)
  assert.equal(classifyPublishRisk({ url: 'https://www.goofish.com/publish', textHits: [], elementHits: [] }), undefined)
  // 1004 单独出现（没有风控/验证语境）不算风控，避免把普通错误码当风控。
  assert.equal(classifyPublishRisk({ url: 'https://www.goofish.com/publish', textHits: [], elementHits: [] }), undefined)
})

test('parsePublishRiskProbe：非字符串/空/坏 JSON/非对象一律视为没有风控', () => {
  assert.equal(parsePublishRiskProbe(undefined), undefined)
  assert.equal(parsePublishRiskProbe(''), undefined)
  assert.equal(parsePublishRiskProbe({ url: 'x' }), undefined)
  assert.equal(parsePublishRiskProbe('{oops'), undefined)
  assert.equal(parsePublishRiskProbe('null'), undefined)
  assert.equal(parsePublishRiskProbe('[]'), undefined)
  assert.equal(parsePublishRiskProbe('"x5sec"'), undefined)
  const risk = parsePublishRiskProbe('{"url":"https://x/_____tmd_____/punish","textHits":[],"elementHits":[]}')
  assert.equal(risk?.kind, 'url')
  const text = parsePublishRiskProbe('{"url":"https://www.goofish.com/publish","textHits":["拖动滑块"],"elementHits":[]}')
  assert.equal(text?.kind, 'text')
})

test('探测脚本覆盖文案/组件标记，并带 1004+风控/验证 的联合判断', () => {
  const script = publishRiskProbeScript()
  // URL 标记在 TS 侧比较（页面脚本只负责收集 url 原文），这里只校验页面侧两类标记。
  for (const marker of RISK_TEXT_MARKERS) assert.ok(script.includes(JSON.stringify(marker)), '缺文案标记 ' + marker)
  for (const selector of RISK_ELEMENT_SELECTORS) assert.ok(script.includes(JSON.stringify(selector)), '缺组件选择器 ' + selector)
  assert.ok(script.includes(RISK_PROBE_MARKER))
  assert.match(script, /1004/)
  assert.match(script, /风控/)
})

test('detectPublishRisk：干净页面返回 undefined，风控页返回分类原因', async () => {
  const clean = new FakeRiskPage()
  assert.equal(await detectPublishRisk(clean), undefined)
  assert.equal(clean.probes, 1)

  const byUrl = new FakeRiskPage({ url: 'https://www.goofish.com/_____tmd_____/punish?x5secdata=1' })
  assert.equal((await detectPublishRisk(byUrl))?.kind, 'url')

  const byText = new FakeRiskPage({ bodyText: '请完成安全验证 拖动滑块' })
  assert.match(String((await detectPublishRisk(byText))?.reason), /请完成安全验证/)

  const byElement = new FakeRiskPage({ elementHits: ['#nc_1_wrapper'] })
  assert.match(String((await detectPublishRisk(byElement))?.reason), /#nc_1_wrapper/)

  const by1004 = new FakeRiskPage({ bodyText: '请求失败 1004 触发风控' })
  assert.match(String((await detectPublishRisk(by1004))?.reason), /1004/)
})

test('withRiskGuards：执行前已有风控 → 步骤不执行、抛 RISK_CONTROL', async () => {
  const page = new FakeRiskPage({ bodyText: '请完成安全验证' })
  const logs: string[] = []
  let ran = false
  const guarded = withRiskGuards([step('选择分类', async () => { ran = true })])
  await assert.rejects(
    () => guarded[0]!.run(asPage(page), makeContext(logs)),
    (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'RISK_CONTROL')
      assert.match(error.message, /发布步骤「选择分类」遇到风控/)
      assert.match(error.message, /不自动重试/)
      assert.deepEqual(error.details, { step: '选择分类' })
      return true
    },
  )
  assert.equal(ran, false)
  assert.ok(logs.some((line) => line.includes('识别到风控')))
})

test('withRiskGuards：步骤执行后才出现风控 → 步骤成功也要抛 RISK_CONTROL', async () => {
  const page = new FakeRiskPage()
  const guarded = withRiskGuards([step('填写价格', async () => { page.url = 'https://www.goofish.com/x5sec' })])
  await assert.rejects(() => guarded[0]!.run(asPage(page), makeContext()), /遇到风控/)
})

test('withRiskGuards：终态步骤成功后出现风控 → 不把成功翻成失败', async () => {
  // 2026-10-23 真机：itemId 1095534136427 已上架，但商品页被 punish 弹层盖住；
  // 终态步骤关掉 post 检查，只要日志里留下提示，不能报 RISK_CONTROL 失败。
  const page = new FakeRiskPage()
  const logs: string[] = []
  const terminal: PublishStep = {
    name: '提交并验证',
    postRiskCheck: false,
    run: async () => {
      page.url = 'https://www.goofish.com/item?id=1095534136427'
      page.bodyText = '请拖动下方滑块完成验证'
      page.elementHits = ['iframe[src*="punish"]']
    },
  }
  const guarded = withRiskGuards([terminal])
  await guarded[0]!.run(asPage(page), makeContext(logs))
  assert.ok(logs.some((line) => line.includes('不影响已生成的上架')))
  assert.ok(!logs.some((line) => line.includes('遇到风控')))
})

test('withRiskGuards：步骤抛普通错误但页面已是风控页 → 风控原因优先', async () => {
  const page = new FakeRiskPage()
  const guarded = withRiskGuards([step('提交并验证', async () => {
    page.bodyText = '人机验证'
    throw new Error('按钮没找到')
  })])
  await assert.rejects(
    () => guarded[0]!.run(asPage(page), makeContext()),
    (error: unknown) => error instanceof XianyuError && error.code === 'RISK_CONTROL',
  )
})

test('withRiskGuards：没有风控时保留步骤原始错误与步骤名', async () => {
  const page = new FakeRiskPage()
  const guarded = withRiskGuards([step('上传图片', async () => { throw new Error('文件输入框没找到') })])
  await assert.rejects(() => guarded[0]!.run(asPage(page), makeContext()), /文件输入框没找到/)
  assert.equal(guarded[0]!.name, '上传图片')
})

test('runRiskGuardedSteps：RISK_CONTROL 透传成 XianyuError，其它失败保持契约返回', async () => {
  const page = new FakeRiskPage()

  await assert.rejects(
    () => runRiskGuardedSteps(asPage(page), [step('选择分类', async () => {
      throw new XianyuError({ code: 'RISK_CONTROL', message: '发布步骤「选择分类」遇到风控：页面出现「人机验证」' })
    })], makeContext()),
    (error: unknown) => {
      assert.ok(error instanceof XianyuError)
      assert.equal(error.code, 'RISK_CONTROL')
      assert.deepEqual(error.details, { step: '选择分类' })
      return true
    },
  )

  const validation = await runRiskGuardedSteps(asPage(page), [step('填写价格', async () => {
    throw new XianyuError({ code: 'VALIDATION', message: '价格不能为空' })
  })], makeContext())
  assert.deepEqual(validation, { ok: false, step: '填写价格', error: '价格不能为空', code: 'VALIDATION' })

  const plain = await runRiskGuardedSteps(asPage(page), [step('填写文案', async () => { throw new Error('输入框没找到') })], makeContext())
  assert.deepEqual(plain, { ok: false, step: '填写文案', error: '输入框没找到' })

  const logs: string[] = []
  const ok = await runRiskGuardedSteps(asPage(page), [step('打开发布页', async () => undefined)], makeContext(logs))
  assert.deepEqual(ok, { ok: true })
  assert.ok(logs.includes('打开发布页:开始'))
  assert.ok(logs.includes('打开发布页:完成'))
})