/**
 * BF_IM 开关解析：IM 默认关，只有显式真值才开。
 * 为什么值得单测：这个开关决定 daemon 会不会主动连 wss 长连接、暴露登录态与风控面；
 * 误把 '0'/'false'/'yes' 当成开，或者漏了 'TRUE'，都是没有测试就发现不了的静默行为变更。
 * @module @bigfish/daemon/test/im-options
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { imOptionsFromEnv } from '../src/cli.ts'

describe('imOptionsFromEnv：IM 通道开关', () => {
  it('默认关闭：没有 BF_IM 时返回 undefined', () => {
    assert.equal(imOptionsFromEnv({}), undefined)
  })

  it("'1' 与 'true'（大小写不敏感）都开启", () => {
    assert.deepEqual(imOptionsFromEnv({ BF_IM: '1' }), { enabled: true })
    assert.deepEqual(imOptionsFromEnv({ BF_IM: 'true' }), { enabled: true })
    assert.deepEqual(imOptionsFromEnv({ BF_IM: 'TRUE' }), { enabled: true })
  })

  it('假值与未知取值都不开启', () => {
    for (const value of ['', '0', 'false', 'no', 'yes', 'on']) {
      assert.equal(imOptionsFromEnv({ BF_IM: value }), undefined, 'BF_IM=' + JSON.stringify(value) + ' 不应开启 IM')
    }
  })
})
