/**
 * DaemonClient 测试：正常调用、token 轮换、token 缺失、网络/超时映射、fetchImpl 注入。
 */
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { XianyuError } from '@bigfish/core'

import { DaemonClient } from '../src/client.ts'
import { createHarness } from './harness.ts'

/** 断言抛出 XianyuError 并返回它，便于继续检查 code/message。 */
async function rejection(promise: Promise<unknown>): Promise<XianyuError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof XianyuError) return error
    throw error
  }
  throw new Error('期望请求失败，实际成功')
}

describe('DaemonClient', () => {
  it('正常路径：health/status/listTasks/enqueue/getTask 全部走真服务', async (t) => {
    const h = await createHarness(t)
    const health = await h.client.health()
    assert.equal(health.version, '9.9.9')
    const status = await h.client.status()
    assert.deepEqual(status.queue, { queued: 0, leased: 0, done: 0, failed: 0, needs_review: 0 })
    assert.deepEqual(await h.client.listTasks(), [])
    const record = await h.client.enqueue({ kind: 'publish', dedupeKey: 'c-1', payload: { accountId: 'acc-1', title: 't', desc: 'd', priceCents: 990, images: ['C:\\tmp\\a.jpg'], itemId: 'i1' } })
    assert.equal(record.dedupeKey, 'c-1')
    assert.equal((await h.client.getTask(record.id)).id, record.id)
    assert.equal((await h.client.listTasks({ state: 'queued' })).length, 1)
    assert.deepEqual(await h.client.listItems(), [])
  })

  it('每次请求重读 token：文件被轮换后请求失败为 UNAUTHORIZED', async (t) => {
    const h = await createHarness(t)
    await writeFile(h.tokenPath, 'rotated-token\n', 'utf8')
    const error = await rejection(h.client.status())
    assert.equal(error.code, 'UNAUTHORIZED')

    await rm(h.tokenPath)
    const missing = await rejection(h.client.status())
    assert.equal(missing.code, 'UNAUTHORIZED')
    assert.match(missing.message, /token/)
  })

  it('网络不可达 → NETWORK，message 含 URL 但不含 token', async (t) => {
    const h = await createHarness(t)
    const token = await h.token()
    const offline = new DaemonClient({ baseUrl: 'http://127.0.0.1:1', tokenPath: h.tokenPath, timeoutMs: 2_000 })
    const error = await rejection(offline.status())
    assert.equal(error.code, 'NETWORK')
    assert.match(error.message, /127\.0\.0\.1:1/)
    assert.equal(error.message.includes(token), false)
  })

  it('超时 → NETWORK，message 标注超时', async (t) => {
    const h = await createHarness(t)
    const neverFetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal === undefined || signal === null) {
          reject(new Error('缺少 AbortSignal'))
          return
        }
        signal.addEventListener('abort', (): void => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as unknown as typeof fetch
    const client = new DaemonClient({ baseUrl: h.baseUrl, tokenPath: h.tokenPath, timeoutMs: 20, fetchImpl: neverFetch })
    const error = await rejection(client.status())
    assert.equal(error.code, 'NETWORK')
    assert.match(error.message, /超时/)
  })

  it('fetchImpl 注入：携带 Bearer token 与 JSON 头，未知错误码降级 INTERNAL', async (t) => {
    const h = await createHarness(t)
    const token = await h.token()
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push({ url: String(input), init })
      if (seen.length === 1) {
        return new Response(JSON.stringify({ ok: true, data: { version: '1.2.3', uptimeMs: 5, pid: 7 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: false, error: { code: 'BOGUS', message: '坏码', retryable: false } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const client = new DaemonClient({ baseUrl: h.baseUrl + '/', tokenPath: h.tokenPath, fetchImpl: fakeFetch })

    assert.deepEqual(await client.health(), { version: '1.2.3', uptimeMs: 5, pid: 7 })
    const first = seen[0]
    assert.ok(first !== undefined)
    assert.equal(first.url, h.baseUrl + '/health')
    const publicHeaders = first.init?.headers as Record<string, string>
    assert.equal(publicHeaders.Accept, 'application/json')
    // health 是公开路由，不带 Authorization；鉴权头只在需要鉴权的请求上出现。
    assert.equal(publicHeaders.Authorization, undefined)

    const error = await rejection(client.enqueue({ kind: 'probe', dedupeKey: 'k', payload: {} }))
    assert.equal(error.code, 'INTERNAL')
    assert.equal(error.details['httpStatus'], 500)
    const second = seen[1]
    assert.ok(second !== undefined)
    const authHeaders = second.init?.headers as Record<string, string>
    assert.equal(authHeaders.Authorization, 'Bearer ' + token)
    assert.equal(authHeaders['Content-Type'], 'application/json')
  })

  it('token 文件缺失时不发请求，直接 UNAUTHORIZED（health 公开，仍可调）', async (t) => {
    const h = await createHarness(t)
    await rm(h.tokenPath)
    const error = await rejection(h.client.status())
    assert.equal(error.code, 'UNAUTHORIZED')
    assert.equal((await h.client.health()).version, '9.9.9')
  })
})
