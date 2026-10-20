import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLogger } from '../src/logger.ts'
import { REDACTED } from '../src/redact.ts'

function collector(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = []
  return { lines, sink: (line: string) => { lines.push(line) } }
}

function parse(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line)
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  return value as Record<string, unknown>
}

test('输出单行 JSON，含稳定字段与结构化 fields', () => {
  const captured = collector()
  const logger = createLogger({ level: 'debug', name: 'daemon', now: () => 123, sink: captured.sink })
  logger.info('started', { port: 47001, ready: true })
  assert.equal(captured.lines.length, 1)
  const line = captured.lines[0]
  assert.ok(line !== undefined && !line.includes('\n'))
  const payload = parse(line)
  assert.equal(payload['t'], 123)
  assert.equal(payload['level'], 'info')
  assert.equal(payload['name'], 'daemon')
  assert.equal(payload['msg'], 'started')
  assert.equal(payload['port'], 47001)
  assert.equal(payload['ready'], true)
})

test('低于等级的日志被丢弃', () => {
  const captured = collector()
  const logger = createLogger({ level: 'warn', now: () => 1, sink: captured.sink })
  logger.debug('d')
  logger.info('i')
  logger.warn('w')
  logger.error('e')
  assert.equal(captured.lines.length, 2)
  assert.deepEqual(captured.lines.map(line => parse(line)['level']), ['warn', 'error'])
})

test('默认等级 info 会丢掉 debug', () => {
  const captured = collector()
  const logger = createLogger({ now: () => 1, sink: captured.sink })
  logger.debug('d')
  logger.info('i')
  assert.equal(captured.lines.length, 1)
  assert.equal(parse(captured.lines[0] ?? '')['level'], 'info')
})

test('msg 与 fields 都会脱敏', () => {
  const captured = collector()
  const logger = createLogger({ now: () => 1, sink: captured.sink })
  logger.info('login Cookie: _m_h5_tk=secretvalue', {
    token: 'raw-token',
    nested: { password: 'raw-password', note: 'session abcdefghijklmnopqrstuvwxyz012345' },
    verdict: 'ok',
  })
  const payload = parse(captured.lines[0] ?? '')
  assert.ok(!String(payload['msg']).includes('secretvalue'))
  assert.ok(String(payload['msg']).includes(REDACTED))
  assert.equal(payload['token'], REDACTED)
  const nested = payload['nested'] as Record<string, unknown>
  assert.equal(nested['password'], REDACTED)
  assert.ok(!String(nested['note']).includes('abcdefghijklmnopqrstuvwxyz012345'))
  assert.ok(String(nested['note']).includes(REDACTED))
  assert.equal(payload['verdict'], 'ok')
})

test('child 绑定字段会合并且绑定值也脱敏', () => {
  const captured = collector()
  const logger = createLogger({ now: () => 1, sink: captured.sink })
  const child = logger.child({ accountId: 'acc-1', token: 'raw-token' })
  child.warn('slow response', { elapsedMs: 1200 })
  const payload = parse(captured.lines[0] ?? '')
  assert.equal(payload['accountId'], 'acc-1')
  assert.equal(payload['token'], REDACTED)
  assert.equal(payload['level'], 'warn')
  assert.equal(payload['elapsedMs'], 1200)
})

test('sink 抛错不影响业务，也不向上冒泡', () => {
  const logger = createLogger({
    now: () => 1,
    sink: () => {
      throw new Error('disk full')
    },
  })
  assert.doesNotThrow(() => logger.info('first'))
  assert.doesNotThrow(() => logger.error('second'))
})

test('非对象 fields 不会破坏日志行', () => {
  const captured = collector()
  const logger = createLogger({ now: () => 1, sink: captured.sink })
  logger.info('x', 'not-an-object' as unknown as Record<string, unknown>)
  assert.equal(captured.lines.length, 1)
  assert.equal(parse(captured.lines[0] ?? '')['msg'], 'x')
})
