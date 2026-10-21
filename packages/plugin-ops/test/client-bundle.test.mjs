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
  const View = registered[2].component
  return {
    loaded,
    Panel,
    View,
    render() {
      loaded.react.__hooks.index = 0
      return Panel()
    },
    renderView() {
      loaded.react.__hooks.index = 0
      return View({})
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

test('apply 通过 inject 注册侧边栏栏位、主面板与两个会话顶部 tab 视图', () => {
  const { registrations, require } = loadBundle()
  const exports = registrations[0].factory(require)
  const { ctx, registered, injected } = createFakeCtx()
  exports.apply(ctx)

  // 插件入口只在侧边栏；顶上每个模块一个 conversation.view（现在：自动发布、账号）。
  assert.deepEqual(injected, ['sidebar.panellist', 'main', 'conversation.view', 'conversation.view'])
  assert.equal(registered.length, 4)
  const [panelRow, mainPanel, publishTab, accountTab] = registered
  // 注意：对象是在 vm 沙箱里造的，原型不同，不能用 deepStrictEqual 直接比整个对象。
  assert.equal(panelRow.definition.name, 'sidebar.panellist')
  assert.equal(panelRow.definition.id, 'bigfish')
  assert.equal(panelRow.definition.order, 30)
  assert.equal(panelRow.definition.label, 'BigFish 闲鱼运营')
  assert.equal(mainPanel.definition.name, 'main')
  assert.equal(mainPanel.definition.key, 'bigfish')
  // conversation.view 是 list 插槽：name/id 必填，order 决定 tab 顺序，label 收字符串。
  assert.equal(publishTab.definition.name, 'conversation.view')
  assert.equal(publishTab.definition.id, 'bigfish-publish')
  assert.equal(publishTab.definition.order, 20)
  assert.equal(publishTab.definition.label, '🐟 自动发布')
  assert.equal(accountTab.definition.name, 'conversation.view')
  assert.equal(accountTab.definition.id, 'bigfish-account')
  assert.equal(accountTab.definition.order, 30)
  assert.equal(accountTab.definition.label, '👤 账号')
  assert.equal(typeof panelRow.component, 'function')
  assert.equal(typeof mainPanel.component, 'function')
  assert.equal(typeof publishTab.component, 'function')
  assert.equal(typeof accountTab.component, 'function')
})

test('账号 tab 面板只读：讲清登录态来源与只读工具，不带任何 cookie 值', () => {
  const { registrations, require } = loadBundle()
  const exports = registrations[0].factory(require)
  const { ctx, registered } = createFakeCtx()
  exports.apply(ctx)
  const AccountPanel = registered[3].component
  const text = toText(AccountPanel({}))
  // 说明「账号从哪里来」「用哪个工具看」
  assert.match(text, /账号管理/)
  assert.match(text, /导入登录态/)
  assert.match(text, /npm run daemon:login/)
  assert.match(text, /xy_accounts_list/)
  assert.match(text, /xy_import_account/)
  // 面板不读凭据：不出现「登录态/凭据明文」这类值
  assert.match(text, /不读 cookie/)
  assert.equal(/cookie=|unb=\d|_m_h5_tk=/i.test(text), false)
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

test('「自动发布」视图：标题、流水线四步、草稿集与类目矩阵都在', () => {
  const { renderView } = mountPanel()
  const tree = renderView()
  const text = toText(tree)
  for (const expected of [
    '自动发布',
    '批量入队 → daemon 串行执行；面板只组参数，不执行写操作',
    '流水线',
    '1 草稿集',
    '标题 / 文案 / 图片 / 价格 / 成色',
    '2 文案与图片',
    '3 批量入队',
    '幂等 dedupeKey，重复草稿自动跳过',
    '4 daemon 发布',
    '单账号串行 CDP；每步截图，失败进待审',
    '草稿集',
    '发布前校验',
    '✅ 电子资料 / 学习笔记 / 课业本；❌ 教材教辅 / 语言与兴趣培训 / 学习资料定制 / 文学 / 考研咨询（网页端不支持发布）',
    '面板不执行发布：命令由 agent 调 xy_publish_batch / CLI 执行 —— 执行与 UI 解耦',
  ]) {
    assert.ok(text.includes(expected), '自动发布视图缺少：' + expected)
  }
  const textarea = collectByType(tree, 'textarea')[0]
  assert.equal(textarea.props['data-role'], 'draft-input')
  assert.match(toText(tree), /price 单位是分/)
})

test('草稿集逐行解析：非法 JSON、缺字段、非 .json 路径都报出来', () => {
  const { renderView } = mountPanel()
  collectByType(renderView(), 'textarea')[0].props.onChange({
    target: {
      value: [
        '{"title":"笔记","price":990,"images":["D:/pics/1.jpg"]}',
        '{bad json}',
        '{"title":"缺图","price":990}',
        'D:/drafts/note.json',
        '随便一行',
      ].join('\n'),
    },
  })
  const tree = renderView()
  const rows = collectByType(tree, 'div').filter((node) => node.props['data-role'] === 'draft-check')
  assert.equal(rows.length, 5)
  const messages = rows.map((node) => toText(node))
  assert.match(messages[0], /格式通过/)
  assert.match(messages[1], /JSON 不合法/)
  assert.match(messages[2], /缺 images/)
  assert.match(messages[3], /路径条目（host 侧读取，面板不校验内容）/)
  assert.match(messages[4], /既不是内联 JSON 对象，也不是 \.json 路径/)
  assert.deepEqual(rows.map((node) => node.props['data-ok']), [true, false, false, true, false])
})

test('至少 2 条合法草稿才启用「生成批量发布请求」，产出 xy_publish_batch 参数', () => {
  const { renderView } = mountPanel()
  let tree = renderView()
  const submit = () => collectByType(tree, 'button').find((node) => node.props['data-role'] === 'publish-batch-submit')
  const typeDrafts = (value) => {
    collectByType(tree, 'textarea')[0].props.onChange({ target: { value } })
    tree = renderView()
  }

  assert.equal(submit().props.disabled, true)
  assert.match(submit().props.title, /先粘贴至少 2 条合法草稿/)

  typeDrafts('{"title":"A","price":100,"images":["D:/a.jpg"]}')
  assert.equal(submit().props.disabled, true)
  assert.match(submit().props.title, /至少 2 条合法草稿才能生成（现在 1 条）/)

  typeDrafts([
    '{"title":"A","price":100,"images":["D:/a.jpg"]}',
    '{"title":"B","price":200,"images":["D:/b.jpg"]}',
    'D:/drafts/C.json',
  ].join('\n'))
  assert.equal(submit().props.disabled, false)
  submit().props.onClick()
  tree = renderView()
  const request = JSON.parse(toText(collectByType(tree, 'pre')[0]))
  assert.equal(request.mode, 'dry-run')
  assert.deepEqual(request.draftPaths, ['D:/drafts/C.json'])
  assert.deepEqual(request.drafts.map((draft) => draft.title), ['A', 'B'])
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'accountId'), false)

  // 任何输入变化都撤销已生成的 JSON，避免拿着旧参数去执行。
  collectByType(tree, 'button').find((node) => node.props['data-role'] === 'publish-mode' && toText(node) === 'enqueue（入队，走审批）').props.onClick()
  tree = renderView()
  assert.equal(collectByType(tree, 'pre').length, 0)
  assert.equal(submit().props.disabled, false)

  collectByType(tree, 'input').find((node) => node.props.placeholder === 'daemon 账号 id，默认唯一账号').props.onChange({ target: { value: 'acc-1' } })
  tree = renderView()
  submit().props.onClick()
  tree = renderView()
  const enqueued = JSON.parse(toText(collectByType(tree, 'pre')[0]))
  assert.equal(enqueued.mode, 'enqueue')
  assert.equal(enqueued.accountId, 'acc-1')
})

test('有校验不通过的行时按钮保持禁用，不静默丢草稿', () => {
  const { renderView } = mountPanel()
  collectByType(renderView(), 'textarea')[0].props.onChange({
    target: {
      value: [
        '{"title":"A","price":100,"images":["D:/a.jpg"]}',
        '{"title":"B","price":200,"images":["D:/b.jpg"]}',
        '随便一行',
      ].join('\n'),
    },
  })
  const tree = renderView()
  const submit = collectByType(tree, 'button').find((node) => node.props['data-role'] === 'publish-batch-submit')
  assert.equal(submit.props.disabled, true)
  assert.match(submit.props.title, /有 1 行校验不通过，先修好再生成/)
})

test('bundle 不写死 daemon 地址以外的环境值，也不访问 document/localStorage/fetch', () => {
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('document.'), false)
  assert.equal(source.includes('fetch('), false)
})
