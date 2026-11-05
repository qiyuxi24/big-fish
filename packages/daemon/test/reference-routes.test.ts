/**
 * POST /reference 路由测试：鉴权、能力未注入、入参校验、参数透传与错误映射。
 * 不触网：采集能力用假实现注入，只验 HTTP 层与「谁被调用、带了什么」。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'

import type { ReferenceReport } from '../src/reference.ts'
import type { ReferenceCollectHandler } from '../src/routes.ts'
import { createHarness, dataOf, errorOf } from './harness.ts'

const REPORT: ReferenceReport = {
  accountId: 'acc1',
  items: [],
  summary: {
    count: 0,
    priceCents: { min: 0, median: 0, max: 0, avg: 0 },
    titleLength: { min: 0, max: 0, avg: 0 },
    imageCountAvg: 0,
    descRatio: 0,
    categories: [],
    keywords: [],
    imageAspect: { square: 0, portrait: 0, landscape: 0, mixed: 0, unknown: 0 },
    copyStructure: { titleSegmentsAvg: 0, descSentencesAvg: 0, bracketTagRatio: 0, ctaRatio: 0 },
  },
  sellers: [],
  skipped: [],
}

interface Call {
  accountId: string
  itemIds?: string[]
  sellerId?: string
  hasSignal: boolean
}

function stubCollector(calls: Call[]): ReferenceCollectHandler {
  return async (input): Promise<ReferenceReport> => {
    calls.push({
      accountId: input.accountId,
      ...(input.itemIds === undefined ? {} : { itemIds: input.itemIds }),
      ...(input.sellerId === undefined ? {} : { sellerId: input.sellerId }),
      hasSignal: input.signal instanceof AbortSignal,
    })
    return REPORT
  }
}

describe('POST /reference', () => {
  it('缺少 Bearer token → 401 UNAUTHORIZED', async (t) => {
    const harness = await createHarness(t, { referenceCollect: stubCollector([]) })
    const response = await harness.rawRequest({ method: 'POST', path: '/reference', token: null, body: '{}' })
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })

  it('未注入采集能力 → 500 UNSUPPORTED（不假装成功）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'POST', path: '/reference', body: '{"accountId":"acc1","itemIds":["1"]}' })
    assert.equal(response.status, 500)
    const error = errorOf(response)
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /未注入参考采集能力/)
  })

  it('入参非法 → 400 VALIDATION，且不调用采集器', async (t) => {
    const calls: Call[] = []
    const harness = await createHarness(t, { referenceCollect: stubCollector(calls) })
    for (const body of ['{}', '{"accountId":"acc1"}', '{"accountId":"acc1","itemIds":["abc"]}', '{"accountId":"..","sellerId":"1"}']) {
      const response = await harness.rawRequest({ method: 'POST', path: '/reference', body })
      assert.equal(response.status, 400, body)
      assert.equal(errorOf(response).code, 'VALIDATION', body)
    }
    assert.deepEqual(calls, [])
  })

  it('合法请求：透传 accountId/itemIds 与 signal，原样返回报告', async (t) => {
    const calls: Call[] = []
    const harness = await createHarness(t, { referenceCollect: stubCollector(calls) })
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/reference',
      body: JSON.stringify({ accountId: 'acc1', itemIds: ['812345678901', '812345678901', '812345678902'] }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(dataOf(response), REPORT)
    assert.deepEqual(calls, [{ accountId: 'acc1', itemIds: ['812345678901', '812345678902'], hasSignal: true }])
  })

  it('采集器抛 STORAGE → 500 STORAGE（错误码不被压成 400）', async (t) => {
    const harness = await createHarness(t, {
      referenceCollect: async (): Promise<ReferenceReport> => {
        throw new XianyuError({ code: 'STORAGE', message: '凭据库不可读' })
      },
    })
    const response = await harness.rawRequest({
      method: 'POST',
      path: '/reference',
      body: '{"accountId":"acc1","sellerId":"2200000000001"}',
    })
    assert.equal(response.status, 500)
    assert.equal(errorOf(response).code, 'STORAGE')
  })

  it('GET /reference → 405（路径存在但方法不对）', async (t) => {
    const harness = await createHarness(t)
    const response = await harness.rawRequest({ method: 'GET', path: '/reference' })
    assert.equal(response.status, 405)
    assert.equal(errorOf(response).code, 'METHOD_NOT_ALLOWED')
  })
})
