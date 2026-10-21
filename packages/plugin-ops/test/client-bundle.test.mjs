import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { COPY_STYLES } from '../src/copy.js'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/**
 * 假 React：createElement 只保留 type / props / children，够做结构断言。
 * useState 按调用顺序分配槽位（与真实 React 的 hook 顺序一致），
 * 这样测试可以「点一下 → 重新渲染 → 断言状态变了」。
 */
function createFakeReact() {
  const hooks = { slots: [], index: 0 }
  return {
    __hooks: hooks,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = hooks.index
      hooks.index += 1
      if (!(index in hooks.slots)) hooks.slots[index] = initial
      const set = (value) => {
        hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value
      }
      return [hooks.slots[index], set]
    },
  }
}

/** 在 vm 沙箱里执行 client bundle，返回捕获到的 loader 注册与可复用 require。 */
function loadBundle() {
  const registrations = []
  const requested = []
  let react
  const require = (id) => {
    requested.push(id)
    if (id !== 'react') throw new Error('client bundle 只允许 require react，实际请求了 ' + id)
    react ??= createFakeReact()
    return react
  }
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  vm.runInNewContext(source, { window, console }, { filename: bundlePath })
  return { registrations, require, requested, get react() { return react } }
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

/** 收集指定类型的元素（按钮、输入框等），用于结构断言。 */
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

/**
 * 装好插件并返回面板渲染器。
 * render() 每次重置 hook 游标，模拟 React 的一次重渲染（状态槽保留）。
 */
function mountPanel() {
  const loaded = loadBundle()
  const exports = loaded.registrations[0].factory(loaded.require)
  const { ctx, registered } = createFakeCtx()
  exports.apply(ctx)
  const Panel = registered[1].component
  return {
    loaded,
    Panel,
    render() {
      loaded.react.__hooks.index = 0
      return Panel()
    },
  }
}

function roleElements(tree, role) {
  return collectByType(tree, 'button').filter((node) => node.props['data-role'] === role)
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

test('顶部 tab：4 个分区，默认「文案生成」，点击切换内容', () => {
  const { render } = mountPanel()
  let tree = render()
  const tabs = roleElements(tree, 'panel-tab')
  assert.deepEqual(tabs.map((node) => toText(node)), ['文案生成', '概览', '发布', '诊断'])
  assert.deepEqual(tabs.map((node) => node.props['aria-selected']), [true, false, false, false])
  // 默认页就是 skill 入口；概览内容此时不应出现。
  assert.match(toText(tree), /文案风格（skill 注入）/)
  assert.equal(toText(tree).includes('127.0.0.1:47001'), false)

  tabs[1].props.onClick()
  tree = render()
  const overview = toText(tree)
  assert.match(overview, /登录态导入/)
  assert.match(overview, /127.0.0.1:47001/)
  assert.match(overview, /npm run daemon:import-account/)
  assert.equal(roleElements(tree, 'panel-tab')[1].props['aria-selected'], true)
  assert.equal(roleElements(tree, 'panel-tab')[0].props['aria-selected'], false)

  roleElements(tree, 'panel-tab')[2].props.onClick()
  tree = render()
  assert.match(toText(tree), /发布通道/)
  assert.match(toText(tree), /BF_PUBLISH_SUBMIT=1/)
  assert.match(toText(tree), /npm run daemon:publish -- --draft <草稿\.json>/)

  roleElements(tree, 'panel-tab')[3].props.onClick()
  tree = render()
  assert.match(toText(tree), /xy_status/)
  assert.match(toText(tree), /xy_tasks_list/)
  assert.match(toText(tree), /npm run daemon\b/)
})

test('面板标题与副标题在任意 tab 都在（tab 栏顶部固定）', () => {
  const { render } = mountPanel()
  const text = toText(render())
  for (const expected of ['BigFish 闲鱼运营', 'P1.3 · 文案生成 / 发布 dry-run / 登录态导入', '文案生成', '概览', '发布', '诊断']) {
    assert.ok(text.includes(expected), '面板文本缺少：' + expected)
  }
})

test('操作入口按钮存在但 disabled，并用 title 指向对应工具', () => {
  const { render } = mountPanel()
  let tree = render()
  // 入口按钮在「概览」页，先切过去。
  roleElements(tree, 'panel-tab')[1].props.onClick()
  tree = render()
  const entryButtons = collectByType(tree, 'button')
    .filter((node) => node.props['data-role'] === undefined)

  assert.equal(entryButtons.length, 2)
  assert.equal(entryButtons[0].props.disabled, true)
  assert.equal(entryButtons[1].props.disabled, true)
  assert.match(entryButtons[0].props.title, /xy_import_account/)
  assert.match(entryButtons[1].props.title, /xy_publish_draft/)
  assert.match(toText(tree), /按钮为什么是灰的/)
})

test('文案风格区：5 个风格可选，默认闲鱼口语，切换后选中态转移', () => {
  const { render } = mountPanel()
  const before = roleElements(render(), 'copy-style')
  assert.equal(before.length, 5)
  assert.deepEqual(before.map((node) => toText(node)), COPY_STYLES.map((style) => style.label))
  assert.deepEqual(before.map((node) => node.props['aria-pressed']), [true, false, false, false, false])
  assert.match(toText(render()), /闲鱼口语：短句直给/)

  before[1].props.onClick()
  const after = roleElements(render(), 'copy-style')
  assert.deepEqual(after.map((node) => node.props['aria-pressed']), [false, true, false, false, false])
  assert.match(toText(render()), /亲切安利：带使用感受/)
})

test('填完商品名与价格后才能生成；生成的是 xy_copy_plan 参数，不调模型', () => {
  const { render } = mountPanel()
  let tree = render()
  const submitButton = () => roleElements(tree, 'copy-submit')[0]

  assert.equal(submitButton().props.disabled, true)
  assert.match(submitButton().props.title, /先填商品名与价格/)

  const inputs = collectByType(tree, 'input')
  assert.equal(inputs.length, 2)
  inputs[0].props.onChange({ target: { value: '索尼 WH-1000XM4' } })
  tree = render()
  collectByType(tree, 'input')[1].props.onChange({ target: { value: '650' } })
  tree = render()

  assert.equal(submitButton().props.disabled, false)
  submitButton().props.onClick()
  tree = render()
  const text = toText(tree)
  assert.match(text, /生成请求已就绪/)
  assert.match(text, /"tool": "xy_copy_plan"/)
  assert.match(text, /"productName": "索尼 WH-1000XM4"/)
  assert.match(text, /"priceYuan": "650"/)
  assert.match(text, /面板不联网、不调模型/)

  // 改任一输入都撤销「已就绪」，避免用旧参数生成。
  collectByType(tree, 'input')[1].props.onChange({ target: { value: '651' } })
  assert.equal(toText(render()).includes('生成请求已就绪'), false)
})

test('面板内嵌的风格表与 src/copy.js 权威定义不漂移', () => {
  const start = source.indexOf('const COPY_STYLE_OPTIONS = [')
  const end = source.indexOf('\n    ]', start)
  assert.ok(start > 0 && end > start, 'client.js 里找不到 COPY_STYLE_OPTIONS 区块')
  const block = source.slice(start, end)
  const options = [...block.matchAll(/\{ id: '([^']+)', label: '([^']+)', summary: '([^']+)' \}/g)]
    .map((match) => ({ id: match[1], label: match[2], summary: match[3] }))

  assert.equal(options.length, COPY_STYLES.length)
  assert.deepEqual(options.map((option) => option.id), COPY_STYLES.map((style) => style.id))
  assert.deepEqual(options.map((option) => option.label), COPY_STYLES.map((style) => style.label))
  assert.deepEqual(options.map((option) => option.summary), COPY_STYLES.map((style) => style.summary))
})

test('bundle 不写死 daemon 地址以外的环境值，也不访问 document/localStorage/fetch', () => {
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('document.'), false)
  assert.equal(source.includes('fetch('), false)
})
