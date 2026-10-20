import test from 'node:test'
import assert from 'node:assert/strict'
import type { ErrorCode } from '@bigfish/core'
import { PLATFORM_FAILURES } from '../src/errors.ts'
import { PATHS } from '../src/methods.ts'
import { captureRejection, createClient, createFakeTransport, envelopeReply } from './helpers.ts'

interface CodeCase {
  platformCode: number
  code: ErrorCode
  retryable: boolean
}

// 平台码表：research/repos/xian-guanjia/references/api-docs.md:101-121
const CODE_CASES: CodeCase[] = [
  { platformCode: 1, code: 'VALIDATION', retryable: false },
  { platformCode: 401, code: 'VALIDATION', retryable: false },
  { platformCode: 403, code: 'UNAUTHORIZED', retryable: false },
  { platformCode: 408, code: 'VALIDATION', retryable: false },
  { platformCode: 500, code: 'INTERNAL', retryable: true },
  { platformCode: 1000, code: 'UNAUTHORIZED', retryable: false },
  { platformCode: 1001, code: 'UNAUTHORIZED', retryable: false },
  { platformCode: 1002, code: 'VALIDATION', retryable: false },
  { platformCode: 1100, code: 'VALIDATION', retryable: false },
  { platformCode: 1101, code: 'VALIDATION', retryable: false },
  { platformCode: 1102, code: 'VALIDATION', retryable: false },
  { platformCode: 1200, code: 'VALIDATION', retryable: false },
  { platformCode: 1201, code: 'VALIDATION', retryable: false },
  { platformCode: 1202, code: 'VALIDATION', retryable: false },
  { platformCode: 1203, code: 'VALIDATION', retryable: false },
  { platformCode: 1209, code: 'UNKNOWN', retryable: false }
]

test('错误码表覆盖 16 个已知平台码', () => {
  assert.equal(Object.keys(PLATFORM_FAILURES).length, CODE_CASES.length)
  for (const codeCase of CODE_CASES) {
    const spec = PLATFORM_FAILURES[codeCase.platformCode]
    assert.ok(spec !== undefined, `缺少平台码 ${codeCase.platformCode}`)
    assert.equal(spec.code, codeCase.code)
  }
})

for (const codeCase of CODE_CASES) {
  test(`平台码 ${codeCase.platformCode} → ${codeCase.code}（retryable=${codeCase.retryable}）`, async () => {
    const fake = createFakeTransport(() => envelopeReply(codeCase.platformCode, 'platform says no', { hint: 1 }))
    const client = createClient(fake.transport)
    const error = await captureRejection(() => client.publishProduct(7))
    assert.equal(error.code, codeCase.code)
    assert.equal(error.retryable, codeCase.retryable)
    assert.equal(error.details.platformCode, codeCase.platformCode)
    assert.equal(error.details.platformMessage, 'platform says no')
    assert.equal(error.details.path, PATHS.publishProduct)
    assert.deepEqual(error.cause, { hint: 1 })
    assert.ok(error.message.includes(`[${codeCase.platformCode}]`))
    assert.ok(error.message.includes('platform says no'))
    assert.ok(error.message.includes(PATHS.publishProduct))
  })
}

test('未知平台码 → UNKNOWN 且不可重试', async () => {
  const fake = createFakeTransport(() => envelopeReply(9999, 'whatever', null))
  const client = createClient(fake.transport)
  const error = await captureRejection(() => client.balance())
  assert.equal(error.code, 'UNKNOWN')
  assert.equal(error.retryable, false)
  assert.equal(error.details.platformCode, 9999)
  assert.ok(error.message.includes('未知错误码'))
})

test('msg 为空时不追加多余内容', async () => {
  const fake = createFakeTransport(() => envelopeReply(1100, '', null))
  const client = createClient(fake.transport)
  const error = await captureRejection(() => client.productDetail(7))
  assert.ok(!error.message.includes('：'))
  assert.equal(error.code, 'VALIDATION')
})
