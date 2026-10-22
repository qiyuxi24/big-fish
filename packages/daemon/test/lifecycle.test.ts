/**
 * 生命周期测试：POST /shutdown 的响应契约、未注入时的降级、以及 cli 的退出等待器。
 * 关真正的关闭动作由 cli 主循环做（route 只负责唤醒它），这里断言「被唤醒一次」。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createShutdownWaiter } from '../src/cli.ts'
import { asRecord, createHarness, dataOf, errorOf } from './harness.ts'

const JSON_TYPE = 'application/json; charset=utf-8'

/** 等一轮事件循环：路由用 setImmediate 在响应之后才触发关停回调。 */
async function nextImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

describe('daemon 生命周期路由', () => {
  it('POST /shutdown 先回 202，再异步唤醒注入的关停回调（只唤醒一次）', async (t) => {
    const reasons: string[] = []
    const h = await createHarness(t, {
      requestShutdown: (reason?: string): void => {
        reasons.push(reason ?? 'no-reason')
      },
    })
    const response = await h.rawRequest({ method: 'POST', path: '/shutdown' })
    assert.equal(response.status, 202)
    assert.equal(response.contentType, JSON_TYPE)
    const data = asRecord(dataOf(response))
    assert.equal(data.stopping, true)
    assert.equal(data.pid, process.pid)

    // 响应返回时回调可能还没跑（setImmediate），跑完后再断言。
    await nextImmediate()
    assert.deepEqual(reasons, ['HTTP'])
  })

  it('未注入关停能力 → 500 UNSUPPORTED（不假装已停）', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({ method: 'POST', path: '/shutdown' })
    assert.equal(response.status, 500)
    assert.equal(errorOf(response).code, 'UNSUPPORTED')
  })

  it('GET /shutdown → 405 VALIDATION（路径存在但方法不对）', async (t) => {
    const h = await createHarness(t)
    const response = await h.rawRequest({ method: 'GET', path: '/shutdown' })
    assert.equal(response.status, 405)
    assert.equal(errorOf(response).code, 'VALIDATION')
  })

  it('POST /shutdown 无 token → 401：关停也走鉴权，不能本机任意进程停 daemon', async (t) => {
    const h = await createHarness(t, { requestShutdown: (): void => {} })
    const response = await h.rawRequest({ method: 'POST', path: '/shutdown', token: null })
    assert.equal(response.status, 401)
    assert.equal(errorOf(response).code, 'UNAUTHORIZED')
  })
})

describe('cli 退出等待器', () => {
  it('request() 让 wait 以原因落定，并摘掉信号监听；重复调用只生效一次', async () => {
    const sigintBefore = process.listenerCount('SIGINT')
    const sigtermBefore = process.listenerCount('SIGTERM')
    const waiter = createShutdownWaiter()
    assert.equal(process.listenerCount('SIGINT'), sigintBefore + 1)
    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1)

    waiter.request('HTTP')
    waiter.request('SIGTERM')
    assert.equal(await waiter.wait, 'HTTP')
    assert.equal(process.listenerCount('SIGINT'), sigintBefore)
    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore)
  })

  it('终端信号也走同一条退出路径（直接调用注册的监听器，不向进程发真信号）', async () => {
    const before = process.listenerCount('SIGTERM')
    const waiter = createShutdownWaiter()
    assert.equal(process.listenerCount('SIGTERM'), before + 1)
    // 最后注册的那个就是等待器的；直接调用等价于收到 SIGTERM，但不会杀测试进程。
    const listener = process.listeners('SIGTERM').at(-1)
    assert.notEqual(listener, undefined)
    listener?.('SIGTERM')
    assert.equal(await waiter.wait, 'SIGTERM')
    assert.equal(process.listenerCount('SIGTERM'), before)
  })
})
