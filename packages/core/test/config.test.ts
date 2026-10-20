import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_HOST, DEFAULT_PORT, defaultDataRoot, loadDaemonConfig } from '../src/config.ts'
import { XianyuError } from '../src/errors.ts'

function validationError(keyLabel: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof XianyuError, '应抛 XianyuError')
    assert.equal(error.code, 'VALIDATION')
    assert.ok(error.message.includes(keyLabel), 'message 应点名 ' + keyLabel + '，实际: ' + error.message)
    return true
  }
}

test('默认值与数据根路径派生正确', () => {
  const config = loadDaemonConfig({})
  const root = defaultDataRoot({})
  assert.equal(config.host, DEFAULT_HOST)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, DEFAULT_PORT)
  assert.equal(config.port, 47001)
  assert.equal(config.logLevel, 'info')
  assert.equal(config.leaseTtlMs, 60_000)
  assert.equal(config.pollIntervalMs, 1_000)
  assert.equal(config.dbPath, join(root, 'bigfish.db'))
  assert.equal(config.tokenPath, join(root, 'daemon.token'))
  assert.equal(config.credentialsDir, join(root, 'credentials'))
  assert.equal(config.circuitPath, join(root, 'circuits.json'))
})

test('环境变量覆盖每个可调项', () => {
  const config = loadDaemonConfig({
    BF_HOST: '0.0.0.0',
    BF_PORT: '48000',
    BF_DATA_DIR: join('tmp', 'bf-data'),
    BF_LOG_LEVEL: 'debug',
    BF_LEASE_TTL_MS: '90000',
    BF_POLL_INTERVAL_MS: '250',
  })
  const root = join('tmp', 'bf-data')
  assert.equal(config.host, '0.0.0.0')
  assert.equal(config.port, 48000)
  assert.equal(config.logLevel, 'debug')
  assert.equal(config.leaseTtlMs, 90_000)
  assert.equal(config.pollIntervalMs, 250)
  assert.equal(config.dbPath, join(root, 'bigfish.db'))
  assert.equal(config.tokenPath, join(root, 'daemon.token'))
  assert.equal(config.credentialsDir, join(root, 'credentials'))
  assert.equal(config.circuitPath, join(root, 'circuits.json'))
})

test('overrides 优先于环境变量', () => {
  const config = loadDaemonConfig(
    { BF_PORT: '48000', BF_LOG_LEVEL: 'debug' },
    { port: 49000, logLevel: 'error' },
  )
  assert.equal(config.port, 49000)
  assert.equal(config.logLevel, 'error')
})

test('port 0 合法：环境变量与 overrides 都允许系统分配端口', () => {
  assert.equal(loadDaemonConfig({ BF_PORT: '0' }).port, 0)
  assert.equal(loadDaemonConfig({}, { port: 0 }).port, 0)
})

test('非法环境变量抛 VALIDATION 并点名键名', () => {
  assert.throws(() => loadDaemonConfig({ BF_PORT: 'abc' }), validationError('BF_PORT'))
  assert.throws(() => loadDaemonConfig({ BF_PORT: '-1' }), validationError('BF_PORT'))
  assert.throws(() => loadDaemonConfig({ BF_PORT: '70000' }), validationError('BF_PORT'))
  assert.throws(() => loadDaemonConfig({ BF_PORT: '47001.5' }), validationError('BF_PORT'))
  assert.throws(() => loadDaemonConfig({ BF_LOG_LEVEL: 'verbose' }), validationError('BF_LOG_LEVEL'))
  assert.throws(() => loadDaemonConfig({ BF_LEASE_TTL_MS: '-1' }), validationError('BF_LEASE_TTL_MS'))
  assert.throws(() => loadDaemonConfig({ BF_POLL_INTERVAL_MS: 'soon' }), validationError('BF_POLL_INTERVAL_MS'))
  assert.throws(() => loadDaemonConfig({ BF_DATA_DIR: '   ' }), validationError('BF_DATA_DIR'))
  assert.throws(() => loadDaemonConfig({ BF_HOST: '' }), validationError('BF_HOST'))
})

test('非法 overrides 同样抛 VALIDATION', () => {
  assert.throws(() => loadDaemonConfig({}, { port: -1 }), validationError('port'))
  assert.throws(() => loadDaemonConfig({}, { host: ' ' }), validationError('host'))
  // 类型层已限定 LogLevel，这里故意用越界值验证运行期校验仍然生效。
  assert.throws(() => loadDaemonConfig({}, { logLevel: 'trace' as never }), validationError('logLevel'))
  assert.throws(() => loadDaemonConfig({}, { leaseTtlMs: -5 }), validationError('leaseTtlMs'))
  assert.throws(() => loadDaemonConfig({}, { pollIntervalMs: 0 }), validationError('pollIntervalMs'))
})
