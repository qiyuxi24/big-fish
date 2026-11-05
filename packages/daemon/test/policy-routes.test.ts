/**
 * POST /policy/check：纯函数包装，真 HTTP 但无 IO。
 *
 * 为什么值得单独测：这条路由存在的唯一理由是「插件层不能 import core」，
 * 它一旦和 checkListing 漂移，插件就会在 dry-run 阶段给出错误的合规结论——
 * 比不检查更糟（用户会以为已经检查过了）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { asRecord, createHarness, dataOf, errorOf } from './harness.ts'

async function check(harness: Awaited<ReturnType<typeof createHarness>>, body: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await harness.rawRequest({ method: 'POST', path: '/policy/check', body })
  return { status: response.status, data: asRecord(dataOf(response)) }
}

describe('POST /policy/check', () => {
  it('合规草稿：ok:true、issues 为空', async (t) => {
    const harness = await createHarness(t)
    const { status, data } = await check(harness, JSON.stringify({
      title: '罗技 MX Master 3S 鼠标',
      desc: '自用 7 个月，功能完好，无磕碰。配件齐全，含充电线与接收器，可同城自提也可快递。',
      priceCents: 42900,
      imageCount: 3,
    }))
    assert.equal(status, 200)
    assert.equal(data.ok, true)
    assert.deepEqual(data.issues, [])
  })

  it('描述过短 + 违禁词 + 图片 0 张 → ok:false 且逐条列 error', async (t) => {
    const harness = await createHarness(t)
    const { data } = await check(harness, JSON.stringify({
      title: '高仿复刻鼠标',
      desc: '高仿，包好用',
      priceCents: 9900,
      imageCount: 0,
    }))
    assert.equal(data.ok, false)
    const issues = data.issues as Array<Record<string, unknown>>
    const codes = issues.map((issue) => issue.code)
    assert.ok(codes.includes('DESC_TOO_SHORT'), '描述过短应是 error')
    assert.ok(codes.includes('DESC_FORBIDDEN_WORD'), '违禁词应是 error')
    assert.ok(codes.includes('IMAGE_COUNT'), '图片 0 张应是 error')
    assert.ok(issues.every((issue) => typeof issue.message === 'string' && issue.message !== ''))
  })

  it('标题过长只是 warn，不阻塞（ok 仍为 true）', async (t) => {
    const harness = await createHarness(t)
    const { data } = await check(harness, JSON.stringify({
      title: '这是一个非常非常长的标题'.repeat(4),
      desc: '自用一段时间，功能正常，配件齐全，外观无明显划痕，可以同城自提或快递寄出，价格可小刀。',
      priceCents: 10000,
      imageCount: 2,
    }))
    const issues = data.issues as Array<Record<string, unknown>>
    const tooLong = issues.find((issue) => issue.code === 'TITLE_TOO_LONG')
    assert.ok(tooLong, '应报 TITLE_TOO_LONG')
    assert.equal(tooLong.severity, 'warn')
    assert.equal(data.ok, true)
  })

  it('禁售类目命中 → CATEGORY_FORBIDDEN（error）', async (t) => {
    const harness = await createHarness(t)
    const { data } = await check(harness, JSON.stringify({
      title: '闲置转让',
      desc: '自用一段时间，功能正常，配件齐全，外观无明显划痕，可以同城自提或快递寄出，价格可小刀。',
      priceCents: 3000,
      imageCount: 1,
      categoryPath: ['数码', '电子烟'],
    }))
    assert.equal(data.ok, false)
    const issues = data.issues as Array<Record<string, unknown>>
    assert.ok(issues.some((issue) => issue.code === 'CATEGORY_FORBIDDEN'))
  })

  it('非对象请求体 / 字段类型不对 → 400 VALIDATION', async (t) => {
    const harness = await createHarness(t)
    const bad = await harness.rawRequest({ method: 'POST', path: '/policy/check', body: '[]' })
    assert.equal(bad.status, 400)
    assert.equal(errorOf(bad).code, 'VALIDATION')

    const badType = await harness.rawRequest({ method: 'POST', path: '/policy/check', body: '{"priceCents":"99"}' })
    assert.equal(badType.status, 400)
    assert.equal(errorOf(badType).code, 'VALIDATION')
    assert.match(errorOf(badType).message, /priceCents/)
  })
})
