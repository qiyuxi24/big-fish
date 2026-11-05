/**
 * 宿主设置页「是否启用」：零依赖 schema + 守卫式 host 注册的行为回归。
 * @module @bigfish/plugin-ops/test/settings
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_NAMESPACE, makeEnabledSchema } from '../src/settings-schema.js'
import { registerSettingsHost } from '../src/settings-host.js'

// 与宿主 @deepseek-ai/schemastery 3.18.5 的 z.object({enabled:z.boolean().default(X)}).toJSON() 字节相等（实测）。
const EXPECTED_ENVELOPE = (defaultValue) => ({
  uid: 2,
  refs: {
    1: { type: 'boolean', meta: { default: defaultValue } },
    2: { type: 'object', meta: { default: {} }, dict: { enabled: 1 } },
  },
})

test('SETTINGS_NAMESPACE 与 client 卡片 key 一致', () => {
  assert.equal(SETTINGS_NAMESPACE, 'bigfish-ops')
})

test('schema 的 toJSON() 与真 schemastery envelope 字节相等', () => {
  assert.deepEqual(makeEnabledSchema(true).toJSON(), EXPECTED_ENVELOPE(true))
  assert.deepEqual(makeEnabledSchema(false).toJSON(), EXPECTED_ENVELOPE(false))
  assert.equal(JSON.stringify(makeEnabledSchema(true).toJSON()), JSON.stringify(EXPECTED_ENVELOPE(true)))
})

test('schema 带 type/dict/meta 结构视图（宿主 redactSecrets walk 需要）', () => {
  const schema = makeEnabledSchema(true)
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.meta, { default: {} })
  assert.equal(schema.dict.enabled.type, 'boolean')
  assert.equal(schema.dict.enabled.meta.default, true)
})

test('live schema：缺省回默认值、布尔原值、坏值 fail loud', () => {
  assert.deepEqual(makeEnabledSchema(true)({}), { enabled: true })
  assert.deepEqual(makeEnabledSchema(false)({}), { enabled: false })
  assert.deepEqual(makeEnabledSchema(true)({ enabled: false }), { enabled: false })
  assert.deepEqual(makeEnabledSchema(false)(null), { enabled: false })
  assert.deepEqual(makeEnabledSchema(true)(['bad']), { enabled: true })
  assert.throws(() => makeEnabledSchema(true)({ enabled: 'no' }), /enabled 必须是布尔值/)
})

/** 假 settings 服务：register 返回可 get/watch 的 scope，记录调用。 */
function fakeSettingsService(initial = { enabled: true }) {
  const state = { value: { ...initial }, watchers: [], registered: [] }
  const service = {
    register(namespace, schema, options) {
      state.registered.push({ namespace, schema, options })
      return {
        get: () => state.value,
        watch: (fn) => state.watchers.push(fn),
      }
    },
  }
  return { service, state }
}

/** 假 ctx：inject(['settings'], cb) 立刻用带 settings 服务的 scoped ctx 调用 cb。 */
function ctxWithSettings(service) {
  return {
    inject(deps, cb) {
      assert.deepEqual(deps, ['settings'])
      cb({ settings: service })
    },
  }
}

test('registerSettingsHost：注册命名空间、首次立即投影、watch 后的变更也投影', () => {
  const { service, state } = fakeSettingsService({ enabled: false })
  const changes = []
  const result = registerSettingsHost(ctxWithSettings(service), {
    defaultValue: true,
    onEnabledChange: (enabled) => changes.push(enabled),
    log: () => {},
  })
  assert.equal(result.registered, true)
  assert.equal(result.status, 'deferred')
  assert.equal(state.registered.length, 1)
  assert.equal(state.registered[0].namespace, 'bigfish-ops')
  assert.deepEqual(state.registered[0].options.base, { enabled: true })
  assert.ok(typeof state.registered[0].schema.toJSON === 'function')
  // 首次投影：settings.yaml 存过 false，本次加载就该是关的。
  assert.deepEqual(changes, [false])
  // watch：用户切回启用，实时反注册/重注册控制器被再次调用。
  state.value = { enabled: true }
  state.watchers.forEach((fn) => fn())
  assert.deepEqual(changes, [false, true])
})

test('registerSettingsHost：没有 inject（CLI / 测试替身）零副作用', () => {
  const changes = []
  const result = registerSettingsHost({}, {
    defaultValue: true,
    onEnabledChange: (enabled) => changes.push(enabled),
    log: () => {},
  })
  assert.equal(result.registered, false)
  assert.equal(result.status, 'skipped')
  assert.deepEqual(changes, [])
})

test('registerSettingsHost：0.1.7 宿主没有 register 时静默跳过，不投影不抛错', () => {
  const changes = []
  const result = registerSettingsHost(ctxWithSettings({ describe: () => {}, update: () => {} }), {
    defaultValue: true,
    onEnabledChange: (enabled) => changes.push(enabled),
    log: () => {},
  })
  assert.equal(result.registered, true) // deferred：inject 已登记，缺 register 由宿主侧降级
  assert.deepEqual(changes, [])
})

test('registerSettingsHost：register 抛错只告警一条、不拖垮加载', () => {
  const logs = []
  const ctx = {
    inject(_deps, cb) {
      cb({ settings: { register: () => { throw new Error('ns 重名') } } })
    },
  }
  const result = registerSettingsHost(ctx, {
    defaultValue: true,
    onEnabledChange: () => {},
    log: (line) => logs.push(line),
  })
  assert.equal(result.registered, true)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /"level":"warn"/)
  assert.match(logs[0], /ns 重名/)
})

test('registerSettingsHost：scope.get() 抛错时保留当前状态，等下一次 watch', () => {
  let broken = true
  const watchers = []
  const ctx = {
    inject(_deps, cb) {
      cb({
        settings: {
          register: () => ({
            get: () => { if (broken) throw new Error('重装配中'); return { enabled: true } },
            watch: (fn) => watchers.push(fn),
          }),
        },
      })
    },
  }
  const changes = []
  registerSettingsHost(ctx, {
    defaultValue: true,
    onEnabledChange: (enabled) => changes.push(enabled),
    log: () => {},
  })
  assert.deepEqual(changes, []) // 首次 get 抛错：不投影
  broken = false
  watchers.forEach((fn) => fn())
  assert.deepEqual(changes, [true])
})
