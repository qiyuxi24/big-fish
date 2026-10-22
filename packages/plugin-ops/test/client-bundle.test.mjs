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
 * useState **按组件身份分槽**（真实 React 里每个组件各有 hook 链表）：面板里嵌了
 * 发布/账号等多个子组件，全局扁平槽位会让它们的 state 互相覆盖。
 * 遍历函数组件时用 __enter/__exit 切换「当前组件」，游标在每次进入时归零。
 */
function createFakeReact() {
  const stores = new Map()
  const state = { current: null }
  const storeOf = (type) => {
    if (!stores.has(type)) stores.set(type, { slots: [], index: 0, effects: [], effectIndex: 0 })
    return stores.get(type)
  }
  const sameDeps = (left, right) => left !== undefined && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]))
  return {
    __enter(type) {
      const previous = state.current
      state.current = type
      const store = storeOf(type)
      store.index = 0
      store.effectIndex = 0
      return previous
    },
    __exit(previous) {
      state.current = previous
    },
    /** 跑一轮挂起的 effect：React 在提交后执行，这里由测试显式触发（只跑 deps 变过的）。 */
    __flush() {
      for (const store of stores.values()) {
        for (const effect of store.effects) {
          if (!effect.dirty) continue
          effect.dirty = false
          if (effect.active && typeof effect.cleanup === 'function') effect.cleanup()
          const cleanup = effect.fn()
          effect.cleanup = typeof cleanup === 'function' ? cleanup : null
          effect.active = true
        }
      }
    },
    /** 卸载全部组件：执行 cleanup（对应 React 卸载时清定时器）。 */
    __unmount() {
      for (const store of stores.values()) {
        for (const effect of store.effects) {
          if (effect.active && typeof effect.cleanup === 'function') effect.cleanup()
          effect.active = false
          effect.dirty = true
        }
      }
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      if (state.current === null) throw new Error('useState 必须在组件内调用')
      const store = storeOf(state.current)
      const index = store.index
      store.index += 1
      if (!(index in store.slots)) store.slots[index] = initial
      const set = (value) => {
        store.slots[index] = typeof value === 'function' ? value(store.slots[index]) : value
      }
      return [store.slots[index], set]
    },
    useEffect(fn, deps) {
      if (state.current === null) throw new Error('useEffect 必须在组件内调用')
      const store = storeOf(state.current)
      const index = store.effectIndex
      store.effectIndex += 1
      const previous = store.effects[index]
      if (previous === undefined) {
        store.effects[index] = { fn, deps, cleanup: null, active: false, dirty: true }
        return
      }
      previous.fn = fn
      if (!sameDeps(previous.deps, deps)) {
        previous.deps = deps
        previous.dirty = true
      }
    },
  }
}

/** 当前 bundle 的假 React（遍历函数组件时用它切 hook 归属）。 */
let activeReact = null

/** 在 vm 沙箱里执行 client bundle，返回捕获到的 loader 注册与可复用 require。 */
function loadBundle() {
  const registrations = []
  const requested = []
  const timers = new Map()
  let seq = 0
  // 假时钟：client 侧只用 setInterval/clearInterval（3 秒轮询），由测试手动推进。
  const clock = {
    setInterval(fn, ms) {
      seq += 1
      timers.set(seq, { fn, ms })
      return seq
    },
    clearInterval(id) {
      timers.delete(id)
    },
    get size() {
      return timers.size
    },
    get period() {
      const first = [...timers.values()][0]
      return first === undefined ? null : first.ms
    },
    advance() {
      for (const timer of [...timers.values()]) timer.fn()
    },
  }
  let react
  const require = (id) => {
    requested.push(id)
    if (id !== 'react') throw new Error('client bundle 只允许 require react，实际请求了 ' + id)
    if (react === undefined) {
      react = createFakeReact()
      activeReact = react
    }
    return react
  }
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  vm.runInNewContext(source, {
    window,
    console,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  }, { filename: bundlePath })
  return { registrations, require, requested, clock, get react() { return react } }
}

/** 排空微任务：rpc 的 Promise 链在下一轮微任务里落定，不依赖真实定时器。 */
async function settle() {
  for (let index = 0; index < 50; index += 1) await Promise.resolve()
}

/** 调用一个函数组件：把 hook 归属切到该组件，离开时还原。 */
function callComponent(node) {
  const previous = activeReact.__enter(node.type)
  try {
    return node.type(node.props)
  } finally {
    activeReact.__exit(previous)
  }
}

/** 把假 React 元素树拍平成文本，便于断言面板文案。 */
function toText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toText).join('')
  // 函数组件在 React 里由宿主调用；这里手动渲染以取文本。
  if (typeof node.type === 'function') return toText(callComponent(node))
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
  if (typeof node.type === 'function') collectByType(callComponent(node), type, out)
  else collectByType(node.children ?? [], type, out)
  return out
}

/** 假 ctx：inject 立即执行回调，register 记录定义与组件；connection 由用例注入。 */
function createFakeCtx(connection) {
  const registered = []
  const injected = []
  return {
    registered,
    injected,
    ctx: {
      connection,
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
function mountPanel(options = {}) {
  const loaded = loadBundle()
  const exports = loaded.registrations[0].factory(loaded.require)
  const { ctx, registered } = createFakeCtx(options.connection)
  exports.apply(ctx)
  const Panel = registered[1].component
  /** 渲染一次面板（组件游标归零 = React 的一次重渲染，状态槽保留）。 */
  const render = () => {
    const previous = loaded.react.__enter(Panel)
    try {
      return Panel()
    } finally {
      loaded.react.__exit(previous)
    }
  }
  /** 点面板内某个 tab（按可见文字），返回切换后的树。 */
  const openTab = (label) => {
    const tab = roleElements(render(), 'panel-tab').find((node) => toText(node) === label)
    if (tab === undefined) throw new Error('面板里找不到 tab：' + label)
    tab.props.onClick()
    return render()
  }
  const flush = () => loaded.react.__flush()
  const unmount = () => loaded.react.__unmount()
  return { loaded, Panel, render, openTab, flush, unmount }
}

/** 渲染 → 走到子组件 → 跑 effect → 等 rpc 落定 → 再渲染取文本。 */
async function snapshotText(mounted, tree) {
  toText(tree ?? mounted.render())
  mounted.flush()
  await settle()
  return toText(mounted.render())
}

/** 假 connection：记录每次 rpc 调用；按 endpoint 取回放数据（值或函数）。 */
function createFakeConnection(replies) {
  const calls = []
  const connection = {
    rpc: {
      call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        const reply = replies[endpoint]
        if (reply === undefined) return Promise.resolve({ ok: false, error: { code: 'UNSUPPORTED', message: 'no fixture: ' + endpoint } })
        return Promise.resolve(typeof reply === 'function' ? reply(payload) : reply)
      },
    },
  }
  return { connection, calls }
}

/** daemon 在线时 6 个只读端点的回放数据（形状对齐 src/rpc.js）。 */
function daemonReplies() {
  return {
    health: { ok: true, value: { version: '0.3.0', uptimeMs: 125000, pid: 4242 } },
    status: {
      ok: true,
      value: {
        version: '0.3.0', uptimeMs: 125000, pid: 4242,
        queue: { queued: 2, leased: 1, done: 5, failed: 0, needs_review: 1 },
        accounts: ['2206569289277'], circuits: {},
      },
    },
    accounts: { ok: true, value: [{ accountId: '2206569289277', updatedAt: 1, savedFieldCount: 3, ready: true }] },
    'settings.get': {
      ok: true,
      value: { copyStyle: 'warm', defaultCategory: '电子资料', publishMinIntervalMs: 180000 },
    },
    'tasks.list': {
      ok: true,
      value: [
        { id: 't-1', kind: 'publish', dedupeKey: 'k1', payload: {}, state: 'queued', attempts: 0, maxAttempts: 3, availableAt: 0, createdAt: 100, updatedAt: 100, batchId: 'batch-old' },
        { id: 't-2', kind: 'publish', dedupeKey: 'k2', payload: {}, state: 'done', attempts: 1, maxAttempts: 3, availableAt: 0, createdAt: 200, updatedAt: 200, batchId: 'batch-new' },
      ],
    },
    'batches.get': () => ({ ok: true, value: { batchId: 'batch-new', total: 4, counts: { queued: 1, done: 3, failed: 0 } } }),
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
  // 数组来自 vm 沙箱，跨 realm 不能 deepStrictEqual，按槽位断言。
  assert.equal(exports.inject.length, 2)
  assert.equal(exports.inject[0], 'slots')
  assert.equal(exports.inject[1], 'connection')
})

test('apply 只注册侧边栏栏位与主面板，不注册会话顶部 tab', () => {
  const { registrations, require } = loadBundle()
  const exports = registrations[0].factory(require)
  const { ctx, registered, injected } = createFakeCtx()
  exports.apply(ctx)

  // 模块 tab 全部在面板内切换（用户 2026-10-21 纠正：主页面在侧边栏面板里，不要塞会话顶部）。
  assert.deepEqual(injected, ['sidebar.panellist', 'main'])
  assert.equal(registered.length, 2)
  assert.equal(registered.some((entry) => entry.definition.name === 'conversation.view'), false)
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

test('账号模块只读：讲清登录态来源与只读工具，不带任何 cookie 值', () => {
  const { openTab } = mountPanel()
  const text = toText(openTab('账号'))
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

test('面板内 tab：6 个分区，默认「自动发布」，点击切换内容', () => {
  const { render, openTab } = mountPanel()
  let tree = render()
  const tabs = roleElements(tree, 'panel-tab')
  assert.deepEqual(tabs.map((node) => toText(node)), ['自动发布', '账号', '文案', '采集', '概览', '诊断'])
  assert.deepEqual(tabs.map((node) => node.props['aria-selected']), [true, false, false, false, false, false])
  // 默认页是发布模块（流水线 + 草稿集）；文案与诊断内容此时不应出现。
  assert.match(toText(tree), /流水线/)
  assert.match(toText(tree), /草稿集/)
  assert.equal(toText(tree).includes('文案风格（skill 注入）'), false)
  assert.equal(toText(tree).includes('127.0.0.1:47001'), false)

  tree = openTab('账号')
  assert.match(toText(tree), /账号管理/)
  assert.equal(roleElements(tree, 'panel-tab')[1].props['aria-selected'], true)
  assert.equal(roleElements(tree, 'panel-tab')[0].props['aria-selected'], false)

  tree = openTab('文案')
  assert.match(toText(tree), /文案风格（skill 注入）/)

  tree = openTab('概览')
  const overview = toText(tree)
  assert.match(overview, /登录态导入/)
  assert.match(overview, /127.0.0.1:47001/)
  assert.match(overview, /npm run daemon:import-account/)

  tree = openTab('诊断')
  assert.match(toText(tree), /xy_status/)
  assert.match(toText(tree), /xy_tasks_list/)
  assert.match(toText(tree), /npm run daemon\b/)
})

test('面板标题与副标题在任意 tab 都在（tab 栏顶部固定）', () => {
  const { render, openTab } = mountPanel()
  const text = toText(render())
  for (const expected of ['BigFish 闲鱼运营', '发布 / 账号 / 文案 / 采集 · 面板只组参数', '自动发布', '账号', '文案', '采集', '概览', '诊断']) {
    assert.ok(text.includes(expected), '面板文本缺少：' + expected)
  }
  // 切到任意 tab，标题与 tab 栏都在。
  const account = toText(openTab('账号'))
  assert.ok(account.includes('BigFish 闲鱼运营'))
  assert.ok(account.includes('自动发布'))
})

test('操作入口按钮存在但 disabled，并用 title 指向对应工具', () => {
  const { openTab } = mountPanel()
  // 入口按钮在「概览」页，先切过去。
  const tree = openTab('概览')
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
  const { render, openTab } = mountPanel()
  openTab('文案')
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
  const { render, openTab } = mountPanel()
  openTab('文案')
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

test('「自动发布」模块（默认 tab）：流水线四步、草稿集与类目矩阵都在', () => {
  const { render } = mountPanel()
  const tree = render()
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
  const { render } = mountPanel()
  collectByType(render(), 'textarea')[0].props.onChange({
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
  const tree = render()
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
  const { render } = mountPanel()
  let tree = render()
  const submit = () => collectByType(tree, 'button').find((node) => node.props['data-role'] === 'publish-batch-submit')
  const typeDrafts = (value) => {
    collectByType(tree, 'textarea')[0].props.onChange({ target: { value } })
    tree = render()
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
  tree = render()
  const request = JSON.parse(toText(collectByType(tree, 'pre')[0]))
  assert.equal(request.mode, 'dry-run')
  assert.deepEqual(request.draftPaths, ['D:/drafts/C.json'])
  assert.deepEqual(request.drafts.map((draft) => draft.title), ['A', 'B'])
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'accountId'), false)

  // 任何输入变化都撤销已生成的 JSON，避免拿着旧参数去执行。
  collectByType(tree, 'button').find((node) => node.props['data-role'] === 'publish-mode' && toText(node) === 'enqueue（入队，走审批）').props.onClick()
  tree = render()
  assert.equal(collectByType(tree, 'pre').length, 0)
  assert.equal(submit().props.disabled, false)

  collectByType(tree, 'input').find((node) => node.props.placeholder === 'daemon 账号 id，默认唯一账号').props.onChange({ target: { value: 'acc-1' } })
  tree = render()
  submit().props.onClick()
  tree = render()
  const enqueued = JSON.parse(toText(collectByType(tree, 'pre')[0]))
  assert.equal(enqueued.mode, 'enqueue')
  assert.equal(enqueued.accountId, 'acc-1')
})

test('有校验不通过的行时按钮保持禁用，不静默丢草稿', () => {
  const { render } = mountPanel()
  collectByType(render(), 'textarea')[0].props.onChange({
    target: {
      value: [
        '{"title":"A","price":100,"images":["D:/a.jpg"]}',
        '{"title":"B","price":200,"images":["D:/b.jpg"]}',
        '随便一行',
      ].join('\n'),
    },
  })
  const tree = render()
  const submit = collectByType(tree, 'button').find((node) => node.props['data-role'] === 'publish-batch-submit')
  assert.equal(submit.props.disabled, true)
  assert.match(submit.props.title, /有 1 行校验不通过，先修好再生成/)
})

test('「采集」模块只读：讲清统计口径与红线，不出现图片直链与可发布草稿', () => {
  const { openTab } = mountPanel()
  const text = toText(openTab('采集'))
  for (const expected of [
    'xy_reference_collect',
    '价格带 / 标题长度 / 类目 / 卖点词',
    '不下载他人图片',
    '不照抄文案',
    '单件失败不影响整批',
    '自有商品搬家',
  ]) {
    assert.ok(text.includes(expected), '采集视图缺少：' + expected)
  }
  // 只读：不出现 daemon 地址、不出图片直链、不出入队参数
  assert.equal(/https?:\/\//.test(text), false)
  assert.equal(text.includes('enqueue'), false)
  assert.equal(text.includes('xy_publish_batch'), false)
})

test('rpc 在线：health / 账号就绪 / 队列计数 / 最近批次 / 设置摘要渲染到「自动发布」页', async () => {
  const { connection, calls } = createFakeConnection(daemonReplies())
  const mounted = mountPanel({ connection })
  const text = await snapshotText(mounted)

  assert.match(text, /daemon 实时状态（每 3 秒轮询）/)
  assert.match(text, /在线 · v0\.3\.0 · 已运行 2 分钟/)
  assert.match(text, /1 个账号 · 1 个可写/)
  assert.match(text, /排队 2 · 执行中 1 · 完成 5 · 失败 0 · 待审 1/)
  assert.match(text, /batch-new · 共 4 · 排队 1 · 完成 3/)
  assert.match(text, /文案风格 warm（亲切安利） · 默认类目 电子资料 · 发布间隔 180 秒/)
  assert.equal(text.includes('未连接后台（daemon 未启动）'), false)

  assert.deepEqual(calls.map((call) => call.endpoint), ['health', 'status', 'accounts', 'settings.get', 'tasks.list', 'batches.get'])
  assert.deepEqual(calls.map((call) => call.channel), ['/bigfish', '/bigfish', '/bigfish', '/bigfish', '/bigfish', '/bigfish'])
  // 注意：payload 是在 vm 沙箱里造的，跨 realm 对象不能 deepStrictEqual，按字段断言。
  assert.equal(calls[4].payload.limit, 50)
  assert.equal(calls[5].payload.id, 'batch-new')
})

test('rpc 返回 error 信封：整块降级成一行，不发批次查询', async () => {
  const replies = daemonReplies()
  replies.status = { ok: false, error: { code: 'INTERNAL', message: 'boom' } }
  const { connection, calls } = createFakeConnection(replies)
  const mounted = mountPanel({ connection })
  const text = await snapshotText(mounted)

  assert.match(text, /未连接后台（daemon 未启动）/)
  assert.equal(text.includes('daemon 实时状态'), false)
  assert.equal(calls.some((call) => call.endpoint === 'batches.get'), false)
})

test('rpc 抛异常（同步 throw / reject）也不冒泡，只降级成一行', async () => {
  const syncThrow = daemonReplies()
  syncThrow.health = () => { throw new Error('transport down') }
  const first = mountPanel({ connection: createFakeConnection(syncThrow).connection })
  const firstText = await snapshotText(first)
  assert.match(firstText, /未连接后台（daemon 未启动）/)

  const rejected = daemonReplies()
  rejected.accounts = () => Promise.reject(new Error('rpc timeout'))
  const second = mountPanel({ connection: createFakeConnection(rejected).connection })
  const secondText = await snapshotText(second)
  assert.match(secondText, /未连接后台（daemon 未启动）/)
  assert.equal(secondText.includes('在线 ·'), false)
})

test('宿主没有 connection 服务：渲染不抛错，同样显示降级文案', async () => {
  const mounted = mountPanel()
  const text = await snapshotText(mounted)
  assert.match(text, /未连接后台（daemon 未启动）/)
})

test('轮询周期 3 秒；卸载时清定时器，之后不再发起 rpc', async () => {
  const { connection, calls } = createFakeConnection(daemonReplies())
  const mounted = mountPanel({ connection })
  await snapshotText(mounted)

  assert.equal(mounted.loaded.clock.size, 1)
  assert.equal(mounted.loaded.clock.period, 3000)
  const firstRound = calls.length
  mounted.loaded.clock.advance()
  await settle()
  assert.ok(calls.length > firstRound)

  mounted.unmount()
  assert.equal(mounted.loaded.clock.size, 0)
  const afterUnmount = calls.length
  mounted.loaded.clock.advance()
  await settle()
  assert.equal(calls.length, afterUnmount)
})

test('「诊断」页也显示 daemon 实时状态，与发布页共用同一份快照', async () => {
  const { connection, calls } = createFakeConnection(daemonReplies())
  const mounted = mountPanel({ connection })
  const tree = mounted.openTab('诊断')
  const text = await snapshotText(mounted, tree)

  assert.match(text, /daemon 实时状态/)
  assert.match(text, /在线 · v0\.3\.0/)
  assert.match(text, /排队 2/)
  // 切 tab 不重复起轮询：仍然只有一个定时器。
  assert.equal(mounted.loaded.clock.size, 1)
  assert.ok(calls.length >= 5)
})

test('bundle 不写死 daemon 地址以外的环境值，也不访问 document/localStorage/fetch', () => {
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('document.'), false)
  assert.equal(source.includes('fetch('), false)
  // 只读状态必须走 host rpc，且 channel 固定为 /bigfish。
  assert.ok(source.includes("RPC_CHANNEL = '/bigfish'"))
  assert.ok(source.includes('connection.rpc.call'))
})