import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { normalizeConfig, resolveDataDir } from '../src/config.js'

test('默认配置：本机 47001、token 在数据根下、15s 超时、门禁开启', () => {
  const config = normalizeConfig({})
  assert.equal(config.daemonUrl, 'http://127.0.0.1:47001')
  assert.equal(config.timeoutMs, 15_000)
  assert.equal(config.writeGate, true)
  assert.ok(config.tokenPath.endsWith('daemon.token'))
})

test('daemonUrl 末尾斜杠被规范化掉，tokenPath/dataDir 可覆盖', () => {
  const config = normalizeConfig({ daemonUrl: 'http://127.0.0.1:9999/', tokenPath: '/tmp/x.token' })
  assert.equal(config.daemonUrl, 'http://127.0.0.1:9999')
  assert.equal(config.tokenPath, '/tmp/x.token')
})

test('launchEnvironment 快照优先于 process.env', () => {
  const ctx = {
    get(name) {
      if (name !== 'launchEnvironment') return undefined
      return { get: (key) => (key === 'BF_DATA_DIR' ? { value: '/snapshot/data' } : undefined) }
    },
  }
  const config = normalizeConfig({}, ctx)
  assert.equal(config.tokenPath, join('/snapshot/data', 'daemon.token'))
})

test('非法配置 fail loud', () => {
  assert.throws(() => normalizeConfig({ daemonUrl: 'ftp://example.com' }), /daemonUrl/)
  assert.throws(() => normalizeConfig({ daemonUrl: 'not a url' }), /daemonUrl/)
  assert.throws(() => normalizeConfig({ timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => normalizeConfig({ timeoutMs: '5000' }), /timeoutMs/)
  assert.throws(() => normalizeConfig({ writeGate: 'yes' }), /writeGate/)
  assert.throws(() => normalizeConfig(null), /config/)
})

test('resolveDataDir 平台差异', () => {
  // win32.join 会把分隔符归一成反斜杠；函数按传入 platform 决定，与宿主平台无关，因此可确定断言。
  assert.equal(resolveDataDir(undefined, { LOCALAPPDATA: 'C:/Users/x/AppData/Local' }, 'win32'), 'C:\\Users\\x\\AppData\\Local\\bigfish')
  assert.equal(resolveDataDir('/explicit', {}, 'linux'), '/explicit')
  assert.equal(resolveDataDir(undefined, { BF_DATA_DIR: '/from-env' }, 'linux'), '/from-env')
  assert.ok(resolveDataDir(undefined, {}, 'linux').endsWith('/.local/share/bigfish'))
  assert.ok(resolveDataDir(undefined, {}, 'win32').includes('bigfish'))
})