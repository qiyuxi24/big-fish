/**
 * IM 取 token 的单元测试：只验「请求形态正确」「响应分类正确」。
 * 网络/签名细节交给 channel-mtop 自己的测试；这里 fake 掉传输层，不触网。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { IM_APP_KEY } from '@bigfish/channel-im'
import { XianyuError } from '@bigfish/core'

import { fetchImAccessToken, parseImToken, stableImDeviceId } from '../src/im-token.ts'
import type { ImTokenSession } from '../src/im-token.ts'
import { mtopQueue, okResponse } from './im-harness.ts'

const NOW = 1_700_000_000_000

function session(overrides: Partial<ImTokenSession> = {}): ImTokenSession {
  return {
    accountId: 'acc1',
    cookies: { unb: '2200000000001', _m_h5_tk: 'tok_1700000000000' },
    ...overrides,
  }
}

/** 从 mtop 请求 body 里取出原始 data JSON（callMtop 用 data=<urlencoded>）。 */
function requestData(body: string): Record<string, unknown> {
  const encoded = body.startsWith('data=') ? body.slice('data='.length) : body
  const parsed: unknown = JSON.parse(decodeURIComponent(encoded))
  assert.ok(typeof parsed === 'object' && parsed !== null)
  return parsed as Record<string, unknown>
}

describe('stableImDeviceId', () => {
  it('没有存过 deviceId 时按账号稳定派生，且带账号后缀', () => {
    const first = stableImDeviceId('acc1')
    const second = stableImDeviceId('acc1')
    assert.equal(first, second, '同一账号跨进程必须一致（否则每次握手都像新设备）')
    assert.ok(first.endsWith('-acc1'))
    assert.notEqual(stableImDeviceId('acc2'), first.replace('acc1', 'acc2'), '不同账号不能共用设备指纹')
  })

  it('凭据里已有 deviceId 时原样使用（不被派生值覆盖）', () => {
    assert.equal(stableImDeviceId('acc1', 'stored-device'), 'stored-device')
    assert.equal(stableImDeviceId('acc1', ''), stableImDeviceId('acc1'), '空串视为没存')
  })
})

describe('parseImToken', () => {
  it('accessToken 非空才认成功', () => {
    assert.equal(parseImToken({ accessToken: 'tok-1' }), 'tok-1')
  })

  it('带惩罚页 url → RISK_CONTROL，且标记不可自动重试', () => {
    let caught: unknown
    try {
      parseImToken({ url: 'https://h5api.m.goofish.com/punish?x=1' })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof XianyuError)
    assert.equal(caught.code, 'RISK_CONTROL')
    assert.equal(caught.retryable, false, '风控必须等人工，不能当网络错误退避重试')
    assert.equal(caught.details?.['punishUrl'], 'https://h5api.m.goofish.com/punish?x=1')
  })

  it('缺 accessToken → AUTH_EXPIRED（提示重新导入登录态）', () => {
    let caught: unknown
    try {
      parseImToken({})
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof XianyuError)
    assert.equal(caught.code, 'AUTH_EXPIRED')
    assert.match(caught.message, /accessToken/)
  })

  it('响应不是对象 → NETWORK（无法判定登录态，按链路问题重试）', () => {
    let caught: unknown
    try {
      parseImToken('not-json')
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof XianyuError)
    assert.equal(caught.code, 'NETWORK')
  })
})

describe('fetchImAccessToken', () => {
  it('请求打到 login.token 接口，data 带 appKey + 稳定 deviceId，返回 accessToken', async () => {
    const recorder = mtopQueue([okResponse({ accessToken: 'tok-1' })])
    const result = await fetchImAccessToken(session(), { transport: recorder.transport, now: () => NOW })

    assert.equal(result.accessToken, 'tok-1')
    assert.equal(result.deviceId, stableImDeviceId('acc1'))
    assert.equal(recorder.calls.length, 1)

    const call = recorder.calls[0]
    assert.ok(call !== undefined)
    const url = new URL(call.url)
    assert.ok(url.pathname.includes('mtop.taobao.idlemessage.pc.login.token'), '必须打取 token 的 mtop 接口')
    assert.equal(url.searchParams.get('accountSite'), 'xianyu')
    assert.equal(url.searchParams.get('queryToken'), 'sm')
    assert.ok(url.searchParams.get('sign') !== null, 'mtop 请求必须带签名')

    const data = requestData(call.body)
    assert.equal(data['appKey'], IM_APP_KEY)
    assert.equal(data['deviceId'], result.deviceId)
  })

  it('凭据里带 deviceId 时请求里用它，不重新派生', async () => {
    const recorder = mtopQueue([okResponse({ accessToken: 'tok-2' })])
    const result = await fetchImAccessToken(session({ deviceId: 'stored-device' }), {
      transport: recorder.transport,
      now: () => NOW,
    })
    assert.equal(result.deviceId, 'stored-device')
    const call = recorder.calls[0]
    assert.ok(call !== undefined)
    assert.equal(requestData(call.body)['deviceId'], 'stored-device')
  })

  it('惩罚页响应 → RISK_CONTROL 冒泡给调用方', async () => {
    const recorder = mtopQueue([okResponse({ url: 'https://example.invalid/punish' })])
    await assert.rejects(
      fetchImAccessToken(session(), { transport: recorder.transport, now: () => NOW }),
      (error: unknown) => error instanceof XianyuError && error.code === 'RISK_CONTROL',
    )
  })

  it('传输层失败按 NETWORK 冒泡（不该被改写成登录失效）', async () => {
    const recorder = mtopQueue([new Error('ECONNRESET')])
    await assert.rejects(
      fetchImAccessToken(session(), { transport: recorder.transport, now: () => NOW }),
      (error: unknown) => error instanceof XianyuError && error.code === 'NETWORK',
    )
  })
})
