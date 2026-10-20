import test from 'node:test'
import assert from 'node:assert/strict'
import { runPublishSteps } from '../src/steps.ts'
import type { PublishContext, PublishStep } from '../src/steps.ts'
import type { CdpPage } from '../src/page.ts'

/** 状态机只把 page 透传给步骤；测试用空对象即可（不测 CDP 实现）。 */
const fakePage = {} as unknown as CdpPage

function makeCtx(signal?: AbortSignal): { ctx: PublishContext; logs: string[] } {
  const logs: string[] = []
  const ctx: PublishContext = signal === undefined
    ? { log: (step, message) => logs.push(step + ':' + message), now: () => 1_700_000_000_000 }
    : { log: (step, message) => logs.push(step + ':' + message), now: () => 1_700_000_000_000, signal }
  return { ctx, logs }
}

test('全部步骤成功 → ok:true，且按顺序执行、逐步记日志', async () => {
  const order: string[] = []
  const steps: PublishStep[] = [
    { name: '打开发布页', run: async () => { order.push('1') } },
    { name: '填标题', run: async () => { order.push('2') } },
    { name: '提交', run: async () => { order.push('3') } },
  ]
  const { ctx, logs } = makeCtx()
  const result = await runPublishSteps(fakePage, steps, ctx)
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(order, ['1', '2', '3'])
  assert.equal(logs.length, 6)
  assert.equal(logs[0], '打开发布页:开始')
})

test('第 2 步抛错 → ok:false 带步骤名，第 3 步不执行', async () => {
  let thirdRan = false
  const steps: PublishStep[] = [
    { name: '打开发布页', run: async () => {} },
    { name: '填标题', run: async () => { throw new Error('标题输入框没找到') } },
    { name: '提交', run: async () => { thirdRan = true } },
  ]
  const { ctx, logs } = makeCtx()
  const result = await runPublishSteps(fakePage, steps, ctx)
  assert.deepEqual(result, { ok: false, step: '填标题', error: '标题输入框没找到' })
  assert.equal(thirdRan, false)
  assert.ok(logs.includes('填标题:失败：标题输入框没找到'))
})

test('AbortSignal 取消后不再执行后续步骤', async () => {
  const controller = new AbortController()
  let secondRan = false
  const steps: PublishStep[] = [
    { name: '第一步', run: async () => { controller.abort() } },
    { name: '第二步', run: async () => { secondRan = true } },
  ]
  const { ctx } = makeCtx(controller.signal)
  const result = await runPublishSteps(fakePage, steps, ctx)
  assert.deepEqual(result, { ok: false, step: '第二步', error: '已取消（AbortSignal）' })
  assert.equal(secondRan, false)
})

test('非 Error 抛出物也转成可读字符串', async () => {
  const steps: PublishStep[] = [{ name: '怪异常', run: async () => { throw '字符串错误' } }]
  const { ctx } = makeCtx()
  const result = await runPublishSteps(fakePage, steps, ctx)
  assert.deepEqual(result, { ok: false, step: '怪异常', error: '字符串错误' })
})
