/**
 * 宿主设置页「BigFish 是否启用」卡片的行为回归（client bundle 片段 11b + 12-tail 的守卫注册）。
 * 与 apply.test.mjs 的 host 侧开关是端到端的两端，本文件只管浏览器这一端。
 * @module @bigfish/plugin-ops/test/settings-card
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
const NS = 'bigfish-ops'

/** 最小假 React：只实现卡片用到的 useState/useEffect + createElement。 */
function createFakeReact() {
  const store = { slots: [], index: 0, effects: [] }
  return {
    __enter() { store.index = 0; store.effectIndex = 0 },
    __flush() {
      for (const effect of store.effects) {
        if (!effect.dirty) continue
        effect.dirty = false
        if (effect.active && typeof effect.cleanup === 'function') effect.cleanup()
        const cleanup = effect.fn()
        effect.cleanup = typeof cleanup === 'function' ? cleanup : null
        effect.active = true
      }
    },
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      const index = store.index
      store.index += 1
      if (!(index in store.slots)) store.slots[index] = initial
      return [store.slots[index], (value) => { store.slots[index] = typeof value === 'function' ? value(store.slots[index]) : value }]
    },
    useEffect(fn, deps) {
      const index = store.effectIndex ?? 0
      store.effectIndex = index + 1
      store.effects[index] = { fn, deps, dirty: true, cleanup: null, active: false }
    },
  }
}

/** 收集指定 data-role 的元素（函数组件展开后继续找）。 */
function findRole(node, role, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findRole(child, role, out); return out }
  if (node.props !== undefined && node.props['data-role'] === role) out.push(node)
  if (typeof node.type === 'function') findRole(node.type(node.props), role, out)
  else findRole(node.children ?? [], role, out)
  return out
}

/** 拍平元素树成文本。 */
function text(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node.type === 'function') return text(node.type(node.props))
  return text(node.children ?? [])
}

/** 执行 bundle，返回 exports 与假 React。 */
function loadBundle() {
  const registrations = []
  let react
  const require = (id) => {
    if (id !== 'react') throw new Error('client bundle 只允许 require react，实际请求了 ' + id)
    if (react === undefined) react = createFakeReact()
    return react
  }
  const window = { __ModuleLoader__: { load: (r) => registrations.push(r) } }
  // 把宿主 Error 传进 vm，卡片里的 `error instanceof Error` 才能对宿主抛的错误成立（跨 realm 默认不成立）。
  vm.runInNewContext(source, { window, console, Error, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} }, { filename: 'client.js' })
  return { exports: registrations[0].factory(require), react }
}

/** 造一个假 scope：getSnapshot/subscribe/mutate 都可注入，记录 mutate 调用。 */
function makeScope(initial) {
  const state = { snapshot: initial, listeners: [], mutations: [] }
  return {
    state,
    getSnapshot: () => state.snapshot,
    subscribe: (fn) => { state.listeners.push(fn); return () => {} },
    mutate: (ops, revision) => { state.mutations.push({ ops, revision }); return Promise.resolve() },
  }
}

/** 带 settingsScope 的假 ctx：slots.inject 立即回调、register 记录卡片；inject 立即回调并带服务。 */
function settingsCtx(scopeService, { brokenSlots = false } = {}) {
  const registered = []
  const injected = []
  const slots = {
    inject(name, cb) { injected.push(name); cb() },
    register(definition, component) { registered.push({ definition, component }); return () => {} },
  }
  const ctx = {
    slots,
    inject(deps, cb) {
      if (deps.length === 1 && deps[0] === 'settingsScope') {
        cb({ settingsScope: scopeService, slots: brokenSlots ? undefined : slots })
      }
    },
  }
  return { ctx, registered, injected }
}

test('有 settingsScope 时按 bigfish-ops 的 key 注册设置卡片（不占侧边栏 tab）', () => {
  const loaded = loadBundle()
  const scope = makeScope({ status: 'ready', writable: true, value: { enabled: true }, revision: 7 })
  const service = { bind: ({ namespace }) => { assert.equal(namespace, NS); return scope } }
  const { ctx, registered, injected } = settingsCtx(service)
  loaded.exports.apply(ctx)

  // 侧边栏两栏位照旧，设置卡片额外注册在 settings.plugin.item。
  assert.ok(injected.includes('sidebar.panellist'))
  assert.ok(injected.includes('main'))
  assert.ok(injected.includes('settings.plugin.item'))
  const card = registered.find((entry) => entry.definition.name === 'settings.plugin.item')
  assert.ok(card, '必须注册 settings.plugin.item 卡片')
  assert.equal(card.definition.key, NS)
})

test('卡片显示启用态，点击后 mutate 写 enabled:false（带 revision）', async () => {
  const loaded = loadBundle()
  const scope = makeScope({ status: 'ready', writable: true, value: { enabled: true }, revision: 7 })
  const { ctx, registered } = settingsCtx({ bind: () => scope })
  loaded.exports.apply(ctx)
  const card = registered.find((entry) => entry.definition.name === 'settings.plugin.item')

  loaded.react.__enter()
  const tree = card.component()
  loaded.react.__flush()
  assert.match(text(tree), /已启用 · 点击停用/)
  assert.match(text(tree), /不再注册任何 xy_\* 工具/)

  findRole(tree, 'bigfish-enabled-toggle')[0].props.onClick()
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.equal(scope.state.mutations.length, 1)
  // ops 是在 vm 沙箱里造的，跨 realm 不能 deepStrictEqual，按字段逐个断言。
  const [op] = scope.state.mutations[0].ops
  assert.equal(op.op, 'set')
  assert.equal(op.path[0], 'enabled')
  assert.equal(op.value, false)
  assert.equal(scope.state.mutations[0].revision, 7)
})

test('停用态渲染「已停用 · 点击启用」，写回 enabled:true', async () => {
  const loaded = loadBundle()
  const scope = makeScope({ status: 'ready', writable: true, value: { enabled: false }, revision: 3 })
  const { ctx, registered } = settingsCtx({ bind: () => scope })
  loaded.exports.apply(ctx)
  const card = registered.find((entry) => entry.definition.name === 'settings.plugin.item')
  loaded.react.__enter()
  const tree = card.component()
  loaded.react.__flush()
  assert.match(text(tree), /已停用 · 点击启用/)
  findRole(tree, 'bigfish-enabled-toggle')[0].props.onClick()
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  const [op] = scope.state.mutations[0].ops
  assert.equal(op.op, 'set')
  assert.equal(op.path[0], 'enabled')
  assert.equal(op.value, true)
})

test('未 ready / 不可写时按钮禁用，并给出原因（不静默）', () => {
  const loaded = loadBundle()
  for (const snapshot of [{ status: 'loading', writable: true, value: {} }, { status: 'ready', writable: false, value: { enabled: true } }]) {
    const scope = makeScope(snapshot)
    const { ctx, registered } = settingsCtx({ bind: () => scope })
    loaded.exports.apply(ctx)
    const card = registered.find((entry) => entry.definition.name === 'settings.plugin.item')
    loaded.react.__enter()
    const tree = card.component()
    loaded.react.__flush()
    const button = findRole(tree, 'bigfish-enabled-toggle')[0]
    assert.equal(button.props.disabled, true)
    assert.match(text(tree), /设置服务未就绪或不可写/)
  }
})

test('settingsScope 缺失 / slots 缺失 / 没有 ctx.inject 都不注册卡片，也不抛错', () => {
  for (const setup of [
    () => settingsCtx(null),
    () => settingsCtx({ bind: () => makeScope({}) }, { brokenSlots: true }),
    () => {
      const { ctx, registered, injected } = settingsCtx({ bind: () => makeScope({}) })
      delete ctx.inject
      return { ctx, registered, injected }
    },
  ]) {
    const loaded = loadBundle()
    const { ctx, registered, injected } = setup()
    assert.doesNotThrow(() => loaded.exports.apply(ctx))
    assert.ok(injected.includes('sidebar.panellist') && injected.includes('main'))
    assert.equal(registered.some((entry) => entry.definition.name === 'settings.plugin.item'), false)
  }
})

test('mutate 失败时显示错误文案，不假装成功', async () => {
  const loaded = loadBundle()
  const scope = makeScope({ status: 'ready', writable: true, value: { enabled: true }, revision: 1 })
  scope.mutate = () => Promise.reject(new Error('写入被拒绝'))
  const { ctx, registered } = settingsCtx({ bind: () => scope })
  loaded.exports.apply(ctx)
  const card = registered.find((entry) => entry.definition.name === 'settings.plugin.item')
  loaded.react.__enter()
  const tree = card.component()
  loaded.react.__flush()
  findRole(tree, 'bigfish-enabled-toggle')[0].props.onClick()
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  // 重新渲染取最新 state（假 React 的 setState 会更新槽位）；游标要归零否则读到旧槽。
  loaded.react.__enter()
  const refreshed = card.component()
  assert.match(text(refreshed), /保存失败：写入被拒绝/)
})

test('卡片不访问 document/localStorage/fetch，只 require react', () => {
  assert.equal(source.includes('document.'), false)
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('fetch('), false)
})
