import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_ACCEPTANCE_TIMEOUT_MS,
  DEFAULT_ACCEPTANCE_PORT,
  DEFAULT_POLL_INTERVAL_MS,
  SUPPORTED_CATEGORY,
  UNSUPPORTED_CATEGORY,
  UsageError,
  buildAcceptanceDrafts,
  evaluateOutcome,
  formatReport,
  isAbsolutePath,
  isTerminal,
  makeSolidPng,
  parseAcceptanceArgs,
  requireBatchId,
  resolveDataRoot,
} from './publish-acceptance.mjs'

test('parseAcceptanceArgs：默认值', () => {
  const options = parseAcceptanceArgs([])
  assert.equal(options.help, false)
  assert.equal(options.port, DEFAULT_ACCEPTANCE_PORT)
  assert.equal(options.chromePort, 9222)
  assert.equal(options.timeoutMs, DEFAULT_ACCEPTANCE_TIMEOUT_MS)
  assert.equal(options.intervalMs, DEFAULT_POLL_INTERVAL_MS)
  assert.equal(options.url, undefined)
  assert.equal(options.images, undefined)
})

test('parseAcceptanceArgs：空格写法与 --flag=value 写法等价', () => {
  const spaced = parseAcceptanceArgs(['--port', '48001', '--chrome-port', '9333', '--batch-id', 'b-accept-1'])
  const inline = parseAcceptanceArgs(['--port=48001', '--chrome-port=9333', '--batch-id=b-accept-1'])
  assert.deepEqual(spaced, inline)
  assert.equal(spaced.port, 48001)
  assert.equal(spaced.chromePort, 9333)
  assert.equal(spaced.batchId, 'b-accept-1')
})

test('parseAcceptanceArgs：--help 生效', () => {
  assert.equal(parseAcceptanceArgs(['--help']).help, true)
  assert.equal(parseAcceptanceArgs(['-h']).help, true)
})

test('parseAcceptanceArgs：未知参数、缺值、越界都抛 UsageError', () => {
  assert.throws(() => parseAcceptanceArgs(['--nope']), UsageError)
  assert.throws(() => parseAcceptanceArgs(['--port']), UsageError)
  assert.throws(() => parseAcceptanceArgs(['--port', '0']), UsageError)
  assert.throws(() => parseAcceptanceArgs(['--port', '70000']), UsageError)
  assert.throws(() => parseAcceptanceArgs(['--port', 'abc']), UsageError)
  assert.throws(() => parseAcceptanceArgs(['--timeout-ms', '1000']), UsageError)
  assert.throws(() => parseAcceptanceArgs(['--interval-ms', '10']), UsageError)
})

test('parseAcceptanceArgs：--url 只接受本机回环地址并去掉尾斜杠', () => {
  assert.equal(parseAcceptanceArgs(['--url', 'http://127.0.0.1:47001']).url, 'http://127.0.0.1:47001')
  assert.equal(parseAcceptanceArgs(['--url', 'http://localhost:47001/']).url, 'http://localhost:47001')
  assert.throws(() => parseAcceptanceArgs(['--url', 'http://10.0.0.5:47001']), UsageError)
  assert.throws(() => parseAcceptanceArgs(['--url', 'https://127.0.0.1:47001']), UsageError)
})

test('requireBatchId：与 core 的批次 id 规则同口径', () => {
  assert.equal(requireBatchId('b-accept-123'), 'b-accept-123')
  assert.throws(() => requireBatchId('-bad'), UsageError)
  assert.throws(() => requireBatchId('has space'), UsageError)
  assert.throws(() => requireBatchId(''), UsageError)
})

test('parseAcceptanceArgs：--images 必须是绝对路径列表', () => {
  const options = parseAcceptanceArgs(['--images', 'C:/a.png,D:/b.png'])
  assert.deepEqual(options.images, ['C:/a.png', 'D:/b.png'])
  assert.throws(() => parseAcceptanceArgs(['--images', 'relative.png']), UsageError)
  assert.throws(() => parseAcceptanceArgs(['--images', '']), UsageError)
  assert.equal(isAbsolutePath('/tmp/a.png'), true)
  assert.equal(isAbsolutePath('C:\\a.png'), true)
  assert.equal(isAbsolutePath('a/b.png'), false)
})

test('resolveDataRoot：Windows 用 LOCALAPPDATA，其他平台用 ~/.local/share', () => {
  assert.equal(
    resolveDataRoot({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, () => 'C:\\Users\\x', 'win32'),
    'C:\\Users\\x\\AppData\\Local\\bigfish',
  )
  assert.equal(
    resolveDataRoot({ USERPROFILE: 'C:\\Users\\x' }, () => 'C:\\Users\\x', 'win32'),
    'C:\\Users\\x\\AppData\\Local\\bigfish',
  )
  assert.equal(resolveDataRoot({}, () => '/home/x', 'linux'), '/home/x/.local/share/bigfish')
})

test('buildAcceptanceDrafts：两条草稿同批、类目一支持一不支持、dedupeKey 唯一', () => {
  const drafts = buildAcceptanceDrafts({ accountId: '2206569289277', images: ['/a.png', '/b.png'], stamp: '123' })
  assert.equal(drafts.supported.kind, 'publish')
  assert.equal(drafts.supported.payload.category, SUPPORTED_CATEGORY)
  assert.equal(drafts.unsupported.payload.category, UNSUPPORTED_CATEGORY)
  assert.equal(drafts.supported.payload.accountId, '2206569289277')
  assert.deepEqual(drafts.supported.payload.images, ['/a.png', '/b.png'])
  assert.equal(drafts.supported.payload.priceCents, 100)
  assert.equal(drafts.supported.payload.shipping, 'free')
  assert.ok(drafts.supported.payload.title.length <= 30, '标题必须 ≤30 字')
  assert.ok(drafts.unsupported.payload.title.length <= 30, '标题必须 ≤30 字')
  assert.notEqual(drafts.supported.dedupeKey, drafts.unsupported.dedupeKey)
  assert.match(drafts.supported.dedupeKey, /^publish:accept-123-ok$/)
  assert.match(drafts.unsupported.dedupeKey, /^publish:accept-123-bad$/)
})

test('isTerminal：queued 与 leased 都为 0 才是终态', () => {
  assert.equal(isTerminal({ done: 1, failed: 1, queued: 0, leased: 0 }), true)
  assert.equal(isTerminal({ done: 0, failed: 0, queued: 2, leased: 0 }), false)
  assert.equal(isTerminal({ done: 0, failed: 0, queued: 0, leased: 1 }), false)
  assert.equal(isTerminal({}), true)
})

test('evaluateOutcome：一条 done 一条 failed（类目原因）→ 通过', () => {
  const verdict = evaluateOutcome({
    total: 2,
    counts: { queued: 0, leased: 0, done: 1, failed: 1, needs_review: 0 },
    tasks: [
      { state: 'done', dedupeKey: 'publish:accept-1-ok' },
      { state: 'failed', dedupeKey: 'publish:accept-1-bad', lastError: 'VALIDATION: 类目不支持，网页端发布矩阵里没有该分类' },
    ],
  })
  assert.equal(verdict.pass, true)
  assert.deepEqual(verdict.reasons, [])
})

test('evaluateOutcome：daemon 的 BatchStats 用 items 承载明细（与 tasks 等价）', () => {
  const verdict = evaluateOutcome({
    total: 2,
    counts: { queued: 0, leased: 0, done: 1, failed: 1, needs_review: 0 },
    items: [
      { state: 'done', dedupeKey: 'publish:accept-2-ok' },
      { state: 'failed', dedupeKey: 'publish:accept-2-bad', lastError: '网页版暂不支持发布此分类' },
    ],
  })
  assert.equal(verdict.pass, true)
})

test('evaluateOutcome：条数不对、没有 done、没有 failed、失败原因不像类目 → 各自报原因', () => {
  const badTotal = evaluateOutcome({ total: 1, counts: { done: 1 }, tasks: [{ state: 'done' }] })
  assert.equal(badTotal.pass, false)
  assert.ok(badTotal.reasons.some((reason) => reason.includes('任务数')))

  const noFailed = evaluateOutcome({ total: 2, counts: { done: 2, failed: 0 }, tasks: [{ state: 'done' }, { state: 'done' }] })
  assert.equal(noFailed.pass, false)
  assert.ok(noFailed.reasons.some((reason) => reason.includes('failed')))

  const noDone = evaluateOutcome({ total: 2, counts: { done: 0, failed: 2 }, tasks: [{ state: 'failed', lastError: '类目不支持' }, { state: 'failed', lastError: '类目不支持' }] })
  assert.equal(noDone.pass, false)
  assert.ok(noDone.reasons.some((reason) => reason.includes('done')))

  const wrongReason = evaluateOutcome({
    total: 2,
    counts: { done: 1, failed: 1 },
    tasks: [{ state: 'done' }, { state: 'failed', lastError: 'NETWORK: fetch failed' }],
  })
  assert.equal(wrongReason.pass, false)
  assert.ok(wrongReason.reasons.some((reason) => reason.includes('类目')))
})

test('formatReport：包含批次、状态分布、逐条状态与结论', () => {
  const text = formatReport({
    batchId: 'b-accept-1',
    daemonUrl: 'http://127.0.0.1:47991',
    screenshotsDir: '/shots',
    verdict: { pass: true, reasons: [] },
    batch: {
      total: 2,
      counts: { done: 1, failed: 1 },
      tasks: [
        { state: 'done', dedupeKey: 'publish:accept-1-ok' },
        { state: 'failed', dedupeKey: 'publish:accept-1-bad', lastError: '类目不支持' },
      ],
    },
  })
  assert.ok(text.includes('b-accept-1'))
  assert.ok(text.includes('验收通过'))
  assert.ok(text.includes('publish:accept-1-bad'))
  assert.ok(text.includes('/shots'))
})

test('makeSolidPng：签名、IHDR 尺寸与 PNG 结构合法', () => {
  const png = makeSolidPng(8, 4, [255, 0, 0])
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(8), 13, 'IHDR 长度必须是 13')
  assert.equal(png.toString('ascii', 12, 16), 'IHDR')
  assert.equal(png.readUInt32BE(16), 8)
  assert.equal(png.readUInt32BE(20), 4)
  assert.equal(png[24], 8, '位深 8')
  assert.equal(png[25], 2, '真彩色 RGB')
  const tail = png.toString('ascii', png.length - 8, png.length - 4)
  assert.equal(tail, 'IEND')
  assert.ok(png.length > 8 + 4 + 13 + 4 + 4)
})
