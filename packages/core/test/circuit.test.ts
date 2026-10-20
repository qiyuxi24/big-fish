import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CircuitBreaker } from '../src/circuit.ts'
import { REDACTED } from '../src/redact.ts'

const T0 = 1_700_000_000_000
const scratchRoot = fileURLToPath(new URL('../../../.scratch/', import.meta.url))
let workDir = ''

before(async () => {
  await mkdir(scratchRoot, { recursive: true })
  workDir = await mkdtemp(join(scratchRoot, 'core-circuit-'))
})

after(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function fakeClock(start = T0): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms: number) => { current += ms } }
}

function pathIn(name: string): string {
  return join(workDir, name)
}

async function readFileJson(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8')
  const value: unknown = JSON.parse(text)
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  return value as Record<string, unknown>
}

test('trip 后熔断，状态跨实例持久化', async () => {
  const path = pathIn('persist.json')
  const clock = fakeClock()
  const first = new CircuitBreaker({ path, now: clock.now })
  assert.equal(first.isOpen('acc-1'), false)
  const state = first.trip('acc-1', 'RGV587 风控')
  assert.equal(state.until, T0 + 600_000)
  assert.equal(first.isOpen('acc-1'), true)
  const second = new CircuitBreaker({ path, now: clock.now })
  assert.equal(second.isOpen('acc-1'), true)
  const listed = second.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.accountId, 'acc-1')
})

test('落盘格式为 v1 JSON 且不留 .tmp 临时文件', async () => {
  const path = pathIn('atomic.json')
  const clock = fakeClock()
  const breaker = new CircuitBreaker({ path, now: clock.now })
  breaker.trip('acc-1', 'risk control')
  const payload = await readFileJson(path)
  assert.equal(payload['v'], 1)
  const circuits = payload['circuits']
  assert.ok(Array.isArray(circuits))
  assert.equal(circuits.length, 1)
  const names = await readdir(workDir)
  assert.ok(!names.some(name => name.endsWith('.tmp')), '不应残留临时文件')
})

test('冷却到期自动放行', async () => {
  const path = pathIn('expire.json')
  const clock = fakeClock()
  const breaker = new CircuitBreaker({ path, cooldownMs: 60_000, now: clock.now })
  breaker.trip('acc-1', 'risk')
  clock.advance(59_999)
  assert.equal(breaker.isOpen('acc-1'), true)
  clock.advance(1)
  assert.equal(breaker.isOpen('acc-1'), false)
  assert.deepEqual(breaker.list(), [])
  const reloaded = new CircuitBreaker({ path, cooldownMs: 60_000, now: clock.now })
  assert.equal(reloaded.isOpen('acc-1'), false)
})

test('reset 解除熔断并同步到磁盘', async () => {
  const path = pathIn('reset.json')
  const clock = fakeClock()
  const breaker = new CircuitBreaker({ path, now: clock.now })
  breaker.trip('acc-1', 'risk')
  breaker.reset('acc-1')
  assert.equal(breaker.isOpen('acc-1'), false)
  const reloaded = new CircuitBreaker({ path, now: clock.now })
  assert.equal(reloaded.isOpen('acc-1'), false)
  assert.deepEqual(reloaded.list(), [])
})

test('状态文件损坏时当空状态继续，不抛错', async () => {
  const path = pathIn('broken.json')
  const clock = fakeClock()
  await writeFile(path, '{"v":1,"circuits":[', 'utf8')
  const breaker = new CircuitBreaker({ path, now: clock.now })
  assert.equal(breaker.isOpen('acc-1'), false)
  assert.deepEqual(breaker.list(), [])
  breaker.trip('acc-1', 'risk')
  const reloaded = new CircuitBreaker({ path, now: clock.now })
  assert.equal(reloaded.isOpen('acc-1'), true)
})

test('非法记录被忽略，合法记录保留', async () => {
  const path = pathIn('mixed.json')
  const clock = fakeClock()
  const body = {
    v: 1,
    circuits: [
      { accountId: 'ok', reason: 'r', trippedAt: T0, until: T0 + 60_000 },
      { accountId: 42, reason: 'bad', trippedAt: T0, until: T0 + 60_000 },
      { accountId: 'bad-until', reason: 'r', trippedAt: T0, until: 'nope' },
      'junk',
    ],
  }
  await writeFile(path, JSON.stringify(body), 'utf8')
  const breaker = new CircuitBreaker({ path, now: clock.now })
  assert.equal(breaker.isOpen('ok'), true)
  assert.equal(breaker.isOpen('bad-until'), false)
  assert.deepEqual(breaker.list().map(state => state.accountId), ['ok'])
})

test('超过 maxEntries 时丢弃最早到期的记录', async () => {
  const path = pathIn('capacity.json')
  const clock = fakeClock()
  const breaker = new CircuitBreaker({ path, cooldownMs: 1_000, maxEntries: 2, now: clock.now })
  breaker.trip('acc-1', 'r')
  clock.advance(100)
  breaker.trip('acc-2', 'r')
  clock.advance(100)
  breaker.trip('acc-3', 'r')
  assert.deepEqual(breaker.list().map(state => state.accountId), ['acc-2', 'acc-3'])
  const reloaded = new CircuitBreaker({ path, cooldownMs: 1_000, maxEntries: 2, now: clock.now })
  assert.equal(reloaded.isOpen('acc-1'), false)
  assert.equal(reloaded.isOpen('acc-2'), true)
})

test('trip 的 reason 会脱敏后才落盘', async () => {
  const path = pathIn('reason.json')
  const clock = fakeClock()
  const breaker = new CircuitBreaker({ path, now: clock.now })
  const state = breaker.trip('acc-1', 'Cookie: _m_h5_tk=verysecretvalue')
  assert.ok(state.reason.includes(REDACTED))
  const text = await readFile(path, 'utf8')
  assert.ok(!text.includes('verysecretvalue'))
})
