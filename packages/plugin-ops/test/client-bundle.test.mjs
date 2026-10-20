import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/** 假 React：createElement 只保留 type / props / children，够做结构断言。 */
function createFakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
  }
}

/** 在 vm 沙箱里执行 client bundle，返回捕获到的 loader 注册与可复用 require。 */
function loadBundle() {
  const registrations = []
  const requested = []
  const require = (id) => {
    requested.push(id)
    if (id !== 'react') throw new Error('client bundle 只允许 require react，实际请求了 ' + id)
    return createFakeReact()
  }
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  vm.runInNewContext(source, { window, console }, { filename: bundlePath })
  return { registrations, require, requested }
}

/** 把假 React 元素树拍平成文本，便于断言面板文案。 */
function toText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toText).join('')
  // 函数组件在 React 里由宿主调用；这里手动渲染以取文本。
  if (typeof node.type === 'function') return toText(node.type(node.props))
  return toText(node.children ?? [])
}

/** 假 ctx：inject 立即执行回调，register 记录定义与组件。 */
function createFakeCtx() {
  const registered = []
  const injected = []
  return {
    registered,
    injected,
    ctx: {
      slots: {
        inject(slotName, callback) {
          injected.push(slotName)
          callback()
        },
        register(definition, component) {
          registered.push({ definition, component })
          return () => {}
        },
      },
    },
  }
}

test('client bundle 只有一个 loader 注册，且 id 与包名一致', () => {
  const { registrations } = loadBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, '@bigfish/plugin-ops')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('factory 懒执行：模块体只登记 factory，不提前 require react', () => {
  const { registrations, require, requested } = loadBundle()
  assert.equal(requested.length, 0)
  const exports = registrations[0].factory(require)
  assert.equal(requested.length, 1)
  assert.equal(requested[0], 'react')
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.inject.length, 1)
  assert.equal(exports.inject[0], 'slots')
})

test('apply 通过 inject 注册侧边栏栏位与同名主面板', () => {
  const { registrations, require } = loadBundle()
  const exports = registrations[0].factory(require)
  const { ctx, registered, injected } = createFakeCtx()
  exports.apply(ctx)

  assert.equal(injected.length, 2)
  assert.equal(injected[0], 'sidebar.panellist')
  assert.equal(injected[1], 'main')
  assert.equal(registered.length, 2)
  const [panelRow, mainPanel] = registered
  // 注意：对象是在 vm 沙箱里造的，原型不同，不能用 deepStrictEqual 直接比整个对象。
  assert.equal(panelRow.definition.name, 'sidebar.panellist')
  assert.equal(panelRow.definition.id, 'bigfish')
  assert.equal(panelRow.definition.order, 30)
  assert.equal(panelRow.definition.label, 'BigFish 闲鱼运营')
  assert.equal(mainPanel.definition.name, 'main')
  assert.equal(mainPanel.definition.key, 'bigfish')
  assert.equal(typeof panelRow.component, 'function')
  assert.equal(typeof mainPanel.component, 'function')
})

test('侧边栏图标渲染 🐟，选中态与未选中态透明度不同', () => {
  const { registrations, require } = loadBundle()
  const exports = registrations[0].factory(require)
  const { ctx, registered } = createFakeCtx()
  exports.apply(ctx)
  const Icon = registered[0].component

  const active = Icon({ size: 16, active: true })
  const idle = Icon({ size: 16, active: false })
  assert.equal(toText(active), '🐟')
  assert.equal(active.props.style.opacity, 1)
  assert.equal(idle.props.style.opacity, 0.72)
  assert.equal(active.props.style.fontSize, '16px')
  assert.equal(Icon({ size: 4 }).props.style.fontSize, '12px')
  assert.equal(active.props['aria-hidden'], 'true')
})

/** 收集指定类型的元素（按钮等），用于结构断言。 */
function collectByType(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  if (typeof node.type === 'function') collectByType(node.type(node.props), type, out)
  else collectByType(node.children ?? [], type, out)
  return out
}

test('主面板渲染标题、状态区与可复制命令', () => {
  const { registrations, require } = loadBundle()
  const exports = registrations[0].factory(require)
  const { ctx, registered } = createFakeCtx()
  exports.apply(ctx)
  const Panel = registered[1].component
  const text = toText(Panel())

  for (const expected of [
    'BigFish 闲鱼运营',
    'P1.2 · 登录态导入 / 发布 dry-run 入口',
    '登录态导入',
    'xy_import_account',
    '发布通道',
    '默认 dry-run',
    '127.0.0.1:47001 · 本地常驻',
    'xy_publish_draft',
    '可复制命令',
    'npm run daemon:import-account',
    'npm run daemon:publish -- --draft <草稿.json>',
    'BF_PUBLISH_SUBMIT=1',
    'xy_status',
    'xy_tasks_list',
  ]) {
    assert.ok(text.includes(expected), '面板文本缺少：' + expected)
  }
})

test('操作按钮存在但 disabled，并用 title 指向对应工具', () => {
  const { registrations, require } = loadBundle()
  const exports = registrations[0].factory(require)
  const { ctx, registered } = createFakeCtx()
  exports.apply(ctx)
  const Panel = registered[1].component
  const buttons = collectByType(Panel(), 'button')

  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].props.disabled, true)
  assert.equal(buttons[1].props.disabled, true)
  assert.match(buttons[0].props.title, /xy_import_account/)
  assert.match(buttons[1].props.title, /xy_publish_draft/)
  assert.match(toText(Panel()), /按钮为什么是灰的/)
})

test('bundle 不写死 daemon 地址以外的环境值，也不访问 document/localStorage', () => {
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('document.'), false)
  assert.equal(source.includes('fetch('), false)
})