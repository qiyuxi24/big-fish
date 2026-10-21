/**
 * BigFish 运营面板（DSH 浏览器半侧 / client bundle）。
 *
 * 这个文件是**手写的 loader 产物**，不是构建输出：DSH 的 client 模块系统只会
 * 执行形如 `window.__ModuleLoader__.load({ id, factory })` 的 lazy-CJS bundle，
 * 本仓库零构建、零第三方依赖，所以直接按该格式手写（见 docs/client-plugin-sidebar.md）。
 *
 * - 注册 id 必须与 Loader entry 的包名一致（@bigfish/plugin-ops），否则宿主会报
 *   「bundle loaded without registering」。
 * - 浏览器侧只做 UI：不读凭据、不联网、不直接调工具。实时状态由 host 侧
 *   xy_* 工具读取；按钮只是入口示意，见面板里「为什么按钮是灰的」。
 * - 「文案风格」区块只做两件事：选风格、组 `xy_copy_plan` 的参数 JSON。
 *   **不在面板里调模型**（loader 拿不到网络能力，也不该把 LLM 依赖塞进 client），
 *   真正出文案的是 agent；将来换 provider 也只换执行者，这段参数契约不变。
 *
 * @module @bigfish/plugin-ops/client
 */
window.__ModuleLoader__.load({
  id: '@bigfish/plugin-ops',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 侧边栏图标的基础样式。 */
    const ICON_STYLE = { display: 'block', lineHeight: '1' }

    /** 面板状态卡：只读事实，实时数据仍由 host 侧工具读。 */
    const STATUS_CARDS = [
      { title: '登录态导入', value: 'xy_import_account', hint: '从本机 Chrome 读 cookie → daemon 加密落盘；写操作走人工审批' },
      { title: '发布通道', value: '默认 dry-run', hint: '只填表、不点提交；真提交需 daemon 设 BF_PUBLISH_SUBMIT=1' },
      { title: 'daemon', value: '127.0.0.1:47001 · 前台进程', hint: '需手动 npm run daemon 起、关终端即停；面板不联网，在线状态用 xy_ping / xy_status 读' },
    ]

    /** 面板上的按钮都只能看（原因见 BUTTON_NOTE）。 */
    const BUTTONS = [
      { label: '导入登录态', tool: 'xy_import_account' },
      { label: '发布 dry-run', tool: 'xy_publish_draft' },
    ]

    /**
     * 面板内的模块 tab：**全部在侧边栏面板里切换**，不注册会话顶部 tab。
     * 顺序 = 产品主线顺序（发布 → 账号 → 预处理/文案 → 概览 → 诊断）；
     * 加模块就在这一行追加，再把 PanelBody 的 switch 补上。
     */
    const PANEL_TABS = [
      { id: 'publish-batch', label: '自动发布' },
      { id: 'account', label: '账号' },
      { id: 'copy', label: '文案' },
      { id: 'overview', label: '概览' },
      { id: 'diagnose', label: '诊断' },
    ]

    /** 可复制命令：按钮不可点时，这是人能在终端直接执行的入口（按 tab 分组）。 */
    const COMMANDS = {
      account: [
        { label: '导入登录态（CLI）', command: 'npm run daemon:import-account' },
      ],
      publish: [
        { label: '发布 dry-run（CLI）', command: 'npm run daemon:publish -- --draft <草稿.json>' },
        { label: '入队发布（需审批）', command: '让模型调用 xy_publish_draft（mode=enqueue）' },
      ],
      diagnose: [
        { label: '起 daemon', command: 'npm run daemon' },
        { label: '隔离 dev 实例', command: 'npm run dsh:dev -- --fresh' },
      ],
    }

    const BUTTON_NOTE = '按钮为什么是灰的：宿主没有公开「面板直接调用工具」的 API，工具调用要经过 host 侧审批门禁，入口仍在对话里；也可以复制下面的命令。'

    /**
     * 语言风格展示副本。
     * **权威定义在 `src/copy.js` 的 `COPY_STYLES`**，这里必须与它同 id、同 label、同 summary；
     * loader 只允许 require 9 个宿主静态模块，client 拿不到业务模块，所以只能内嵌。
     * 漂移由 `test/client-bundle.test.mjs` 守护，改风格时两处一起改。
     */
    const COPY_STYLE_OPTIONS = [
      { id: 'plain', label: '闲鱼口语', summary: '短句直给，像老买家聊天，不客套' },
      { id: 'warm', label: '亲切安利', summary: '带使用感受与推荐理由，语气温和' },
      { id: 'professional', label: '参数党', summary: '参数与成色逐条列清楚，适合数码、器材' },
      { id: 'urgent', label: '急出清仓', summary: '搬家/换新/清库存，节奏快、直奔交易条件' },
      { id: 'story', label: '场景氛围', summary: '以使用场景开头，适合家居、服饰、手作' },
    ]

    /** 成色选项，与 skill 的 condition 枚举一致。 */
    const CONDITION_OPTIONS = [
      { id: 'new', label: '全新' },
      { id: 'like-new', label: '几乎全新' },
      { id: 'light-wear', label: '轻微使用痕迹' },
      { id: 'visible-wear', label: '明显使用痕迹' },
      { id: 'flawed', label: '有瑕疵' },
    ]

    /** 发布流水线四步：面板只展示契约，真正执行在 daemon。 */
    const PIPELINE_STEPS = [
      { title: '1 草稿集', value: '标题 / 文案 / 图片 / 价格 / 成色' },
      { title: '2 文案与图片', value: 'agent 调 xy_copy_plan 出文案；图片用本地目录' },
      { title: '3 批量入队', value: '幂等 dedupeKey，重复草稿自动跳过' },
      { title: '4 daemon 发布', value: '单账号串行 CDP；每步截图，失败进待审' },
    ]
    const CATEGORY_MATRIX = '✅ 电子资料 / 学习笔记 / 课业本；❌ 教材教辅 / 语言与兴趣培训 / 学习资料定制 / 文学 / 考研咨询（网页端不支持发布）'
    /** 内联草稿示例（price 单位是分）。 */
    const DRAFT_EXAMPLE = '{"title":"课程笔记 PDF","price":990,"condition":"like-new","images":["D:/pics/note-1.jpg"]}'

    /** 逐行解析草稿集（内联 JSON 对象或 .json 路径）：路径条目交给 host 侧读取，这里只认形状。 */
    function parseDraftLines(text) {
      return text.split('\n').map(line => line.trim()).filter(line => line !== '').map((line, index) => {
        if (!line.startsWith('{')) {
          return /\.json$/i.test(line)
            ? { index, kind: 'path', ok: true, path: line, message: '路径条目（host 侧读取，面板不校验内容）' }
            : { index, kind: 'bad', ok: false, message: '既不是内联 JSON 对象，也不是 .json 路径' }
        }
        let draft
        try { draft = JSON.parse(line) } catch { return { index, kind: 'inline', ok: false, message: 'JSON 不合法' } }
        if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
          return { index, kind: 'inline', ok: false, message: 'JSON 不是对象' }
        }
        const missing = ['title', 'price', 'images'].filter(key => draft[key] === undefined || draft[key] === null || draft[key] === '' || (Array.isArray(draft[key]) && draft[key].length === 0))
        return missing.length === 0
          ? { index, kind: 'inline', ok: true, draft, message: '格式通过' }
          : { index, kind: 'inline', ok: false, draft, message: '缺 ' + missing.join(' / ') }
      })
    }

    /** 组装 xy_publish_batch 参数：只组数据，不执行。 */
    function buildPublishBatchArguments(mode, results, accountId) {
      const args = {
        mode,
        draftPaths: results.filter(result => result.kind === 'path').map(result => result.path),
        drafts: results.filter(result => result.kind === 'inline' && result.ok).map(result => result.draft),
      }
      if (accountId.trim() !== '') args.accountId = accountId.trim()
      return args
    }

    /**
     * 组装 `xy_copy_plan` 的参数（纯数据，不含业务规则）。
     * 价格原样传「元」字符串：浮点乘 100 会出精度问题，转分交给 host 侧解析。
     *
     * @returns {object} { tool, arguments } —— 可直接贴给模型执行。
     */
    function buildCopyPlanArguments(styleId, productName, priceYuan, condition) {
      const args = { styleId, productName: productName.trim(), condition }
      const price = priceYuan.trim()
      if (price !== '') args.priceYuan = price
      return { tool: 'xy_copy_plan', arguments: args }
    }

    /**
     * 侧边栏栏位图标。
     * @param {object} props - { size, active }（SidebarPanelIconOwnerProps）。
     * @returns {object} React 元素。
     */
    function BigFishIcon({ size, active }) {
      return h('span', {
        style: { ...ICON_STYLE, fontSize: String(Math.max(12, size)) + 'px', opacity: active ? 1 : 0.72 },
        'aria-hidden': 'true',
      }, '🐟')
    }

    /** 一张信息卡。 */
    function Card({ title, value, hint }) {
      return h('div', { style: S.card },
        h('div', { style: S.cardTitle }, title),
        h('div', { style: S.cardValue }, value),
        hint === undefined ? null : h('div', { style: S.cardHint }, hint))
    }

    /** 状态区：三张只读卡。 */
    function StatusGrid() {
      return h('div', { style: S.grid }, ...STATUS_CARDS.map(card => h(Card, { key: card.title, ...card })))
    }

    /** 按钮区：disabled + title 说明原因。 */
    function ActionButtons() {
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, '操作入口'),
        h('div', { style: S.buttonRow },
          ...BUTTONS.map(button => h('button', {
            key: button.tool,
            type: 'button',
            disabled: true,
            title: '暂不可点：请在对话里让模型调用 ' + button.tool + '，或复制下面的命令。',
            style: S.button,
          }, button.label))),
        h('div', { style: S.sectionHint }, BUTTON_NOTE))
    }

    /** 命令区：一行一个可复制命令。 */
    function CommandList({ items, title }) {
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, title ?? '可复制命令'),
        ...items.map(item => h('div', { key: item.label, style: S.cmdRow },
          h('span', { style: S.cmdLabel }, item.label),
          h('code', { style: S.cmdCode }, item.command))))
    }

    /** 一行「工具名 + 用途」，诊断页用。 */
    function ToolRow({ name, desc }) {
      return h('div', { style: S.cmdRow },
        h('span', { style: S.cmdLabel }, desc),
        h('code', { style: S.cmdCode }, name))
    }

    /** 风格选择：一行芯片，选中态用 aria-pressed 与高亮同时表达。 */
    function StylePicker({ styleId, onStyle }) {
      const active = COPY_STYLE_OPTIONS.find(option => option.id === styleId) ?? COPY_STYLE_OPTIONS[0]
      return h('div', null,
        h('div', { style: S.chipRow }, ...COPY_STYLE_OPTIONS.map(option => h('button', {
          key: option.id,
          type: 'button',
          'data-role': 'copy-style',
          'aria-pressed': option.id === styleId,
          title: option.summary,
          onClick: () => onStyle(option.id),
          style: option.id === styleId ? { ...S.chip, ...S.chipActive } : S.chip,
        }, option.label))),
        h('div', { style: S.sectionHint }, active.label + '：' + active.summary))
    }

    /** 商品事实输入：只收最小集，其余字段在对话里补。 */
    function CopyInputs({ productName, onName, priceYuan, onPrice, condition, onCondition }) {
      return h('div', { style: S.fieldRow },
        h('label', { style: S.field },
          h('span', { style: S.fieldLabel }, '商品名'),
          h('input', {
            type: 'text',
            value: productName,
            placeholder: '如：iPhone 13 128G 星光色',
            onChange: event => onName(event.target.value),
            style: S.input,
          })),
        h('label', { style: S.field },
          h('span', { style: S.fieldLabel }, '价格（元）'),
          h('input', {
            type: 'text',
            value: priceYuan,
            placeholder: '如：129.90',
            onChange: event => onPrice(event.target.value),
            style: S.input,
          })),
        h('label', { style: S.field },
          h('span', { style: S.fieldLabel }, '成色'),
          h('select', {
            value: condition,
            onChange: event => onCondition(event.target.value),
            style: S.input,
          }, ...CONDITION_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.label)))))
    }

    /** 请求预览：把参数 JSON 摊开，便于复制或直接在对话里让模型执行。 */
    function CopyPlanPreview({ request }) {
      return h('div', { style: S.preview },
        h('div', { style: S.sectionTitle }, '生成请求已就绪'),
        h('div', { style: S.sectionHint }, '面板不联网、不调模型：这里只选风格与组参数。把下面这段交给模型，它会调 xy_copy_plan 拿到注入好的提示词，再按 skill 出草稿 JSON → xy_publish_draft 做 dry-run。'),
        h('pre', { style: S.pre }, JSON.stringify(request, null, 2)))
    }

    /** 文案风格区：选风格 → 填事实 → 生成请求。 */
    function CopyStudio(props) {
      const { styleId, onStyle, ready, submitted, request } = props
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, '文案风格（skill 注入）'),
        h(StylePicker, { styleId, onStyle }),
        h(CopyInputs, props),
        h('div', { style: S.buttonRow },
          h('button', {
            type: 'button',
            'data-role': 'copy-submit',
            disabled: !ready,
            title: ready ? '按当前风格组装 xy_copy_plan 请求' : '先填商品名与价格（元）',
            onClick: () => props.onSubmit(),
            style: ready ? S.primary : S.button,
          }, '生成文案请求'),
          h('span', { style: S.sectionHint }, ready ? '' : '商品名与价格都填了才能生成（价格用于校验，不写进标题）。')),
        submitted ? h(CopyPlanPreview, { request }) : null)
    }

    /** 面板内 tab 栏：role=tablist，选中态同时给 aria-selected 与下划线。 */
    function TabBar({ active, onSelect }) {
      return h('div', { role: 'tablist', 'aria-label': 'BigFish 面板分区', style: S.tabBar },
        ...PANEL_TABS.map(tab => h('button', {
          key: tab.id,
          type: 'button',
          role: 'tab',
          'data-role': 'panel-tab',
          'aria-selected': tab.id === active,
          onClick: () => onSelect(tab.id),
          style: tab.id === active ? { ...S.tab, ...S.tabActive } : S.tab,
        }, tab.label)))
    }



    /** 诊断页：只读工具与进程命令。 */
    function DiagnoseTab() {
      return h('div', null,
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '读状态（让模型调）'),
          h(ToolRow, { name: 'xy_status', desc: '队列/账号/熔断/worker' }),
          h(ToolRow, { name: 'xy_tasks_list', desc: '任务列表（可按状态/种类过滤）' }),
          h(ToolRow, { name: 'xy_items_list', desc: '本地商品快照' }),
          h(ToolRow, { name: 'xy_ping', desc: '插件 ↔ daemon ↔ 鉴权自检' })),
        h(CommandList, { items: COMMANDS.diagnose, title: '进程' }),
        h('div', { style: S.note }, '面板不联网、不读凭据：实时数据都从 host 侧工具读，这里只放入口与口径。'))
    }

    /** 当前 tab 的内容区：四个模块 + 两个说明页；copy 页的状态留在 Panel 里（切走再切回不丢输入）。 */
    function PanelBody({ tab, copyProps }) {
      if (tab === 'publish-batch') return h(PublishBatchView)
      if (tab === 'account') return h(AccountView)
      if (tab === 'copy') return h(CopyStudio, copyProps)
      if (tab === 'diagnose') return h(DiagnoseTab)
      return h('div', null,
        h(StatusGrid),
        h(ActionButtons),
        h(CommandList, { items: COMMANDS.account, title: '账号' }))
    }

    /** 面板骨架：顶部 tab（skill 入口在第一个）+ 内容区 + 门禁说明。 */
    function BigFishPanel() {
      const [tab, setTab] = React.useState(PANEL_TABS[0].id)
      const [styleId, setStyleId] = React.useState(COPY_STYLE_OPTIONS[0].id)
      const [productName, setProductName] = React.useState('')
      const [priceYuan, setPriceYuan] = React.useState('')
      const [condition, setCondition] = React.useState('like-new')
      const [submitted, setSubmitted] = React.useState(false)
      const ready = productName.trim() !== '' && priceYuan.trim() !== ''
      const request = buildCopyPlanArguments(styleId, productName, priceYuan, condition)
      // 任一输入变化都撤销"已就绪"，避免拿着旧参数去生成。
      const reset = setter => value => { setter(value); setSubmitted(false) }
      const copyProps = {
        styleId,
        onStyle: reset(setStyleId),
        productName,
        onName: reset(setProductName),
        priceYuan,
        onPrice: reset(setPriceYuan),
        condition,
        onCondition: reset(setCondition),
        ready,
        submitted,
        onSubmit: () => setSubmitted(true),
        request,
      }
      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', { style: S.logo }, '🐟'),
          h('div', null,
            h('div', { style: S.title }, 'BigFish 闲鱼运营'),
            h('div', { style: S.subtitle }, '发布 / 账号 / 文案 · 面板只组参数，执行交给 agent 与 daemon'))),
        h(TabBar, { active: tab, onSelect: setTab }),
        h(PanelBody, { tab, copyProps }),
        h('div', { style: S.note },
          '写操作门禁：导入登录态、入队发布走 ask；dry-run 与 xy_copy_plan 只读放行。实时状态在「诊断」页。真机校准通过前，任何路径都不会声称「发布成功」。'))
    }

    /** 「自动发布」模块：草稿集 → 校验 → 组 xy_publish_batch 参数。纯 UI，不联网、不执行写操作。 */
    function PublishBatchView() {
      const [draftText, setDraftText] = React.useState('')
      const [mode, setMode] = React.useState('dry-run')
      const [accountId, setAccountId] = React.useState('')
      const [generated, setGenerated] = React.useState(null)
      const results = parseDraftLines(draftText)
      const invalid = results.filter(result => !result.ok)
      const valid = results.filter(result => result.ok)
      const ready = valid.length >= 2 && invalid.length === 0
      const blocked = results.length === 0 ? '先粘贴至少 2 条合法草稿'
        : invalid.length > 0 ? '有 ' + String(invalid.length) + ' 行校验不通过，先修好再生成'
          : '至少 2 条合法草稿才能生成（现在 ' + String(valid.length) + ' 条）'
      const request = buildPublishBatchArguments(mode, results, accountId)
      const update = setter => value => { setter(value); setGenerated(null) }
      return h('div', null,
        h('div', { style: S.sectionHint }, '批量入队 → daemon 串行执行；面板只组参数，不执行写操作'),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '流水线'),
          h('div', { style: S.grid }, ...PIPELINE_STEPS.map(step => h(Card, { key: step.title, title: step.title, value: step.value })))),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '草稿集'),
          h('div', { style: S.sectionHint }, '每行一条：内联 JSON 对象，或草稿 .json 文件路径（由 host 侧读取）。price 单位是分。'),
          h('textarea', {
            value: draftText, rows: 6, 'data-role': 'draft-input',
            placeholder: '每行一条草稿：{"title":"...","price":990,"images":["D:/pics/1.jpg"]} 或 D:/drafts/note.json',
            onChange: event => update(setDraftText)(event.target.value),
            style: { ...S.input, ...S.textarea },
          }),
          h('div', { style: S.sectionHint }, '示例：' + DRAFT_EXAMPLE)),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '发布前校验'),
          h('div', { style: S.sectionHint }, '类目矩阵：' + CATEGORY_MATRIX),
          ...results.map(result => h('div', { key: String(result.index), style: S.cmdRow, 'data-role': 'draft-check', 'data-ok': result.ok },
            h('span', { style: S.cmdLabel }, '第 ' + String(result.index + 1) + ' 行'),
            h('span', { style: result.ok ? S.okText : S.badText }, result.message))),
          h('div', { style: S.sectionHint }, '已通过 ' + String(valid.length) + ' 条 / 未通过 ' + String(invalid.length) + ' 条；至少 2 条合法草稿才能生成。')),
        h('div', { style: S.section },
          h('div', { style: S.fieldRow }, h('div', { style: S.field },
            h('span', { style: S.fieldLabel }, '模式'),
            h('div', { style: S.chipRow }, ...['dry-run', 'enqueue'].map(value => h('button', {
              key: value, type: 'button', 'data-role': 'publish-mode', 'aria-pressed': value === mode,
              title: value === 'dry-run' ? '只填表、不点提交' : '入队后由 daemon 执行，需要审批门禁',
              onClick: () => update(setMode)(value),
              style: value === mode ? { ...S.chip, ...S.chipActive } : S.chip,
            }, value === 'dry-run' ? 'dry-run（只填表）' : 'enqueue（入队，走审批）')))),
          h('label', { style: S.field }, h('span', { style: S.fieldLabel }, '账号（可选）'),
            h('input', {
              type: 'text', value: accountId, placeholder: 'daemon 账号 id，默认唯一账号',
              onChange: event => update(setAccountId)(event.target.value), style: S.input,
            }))),
          h('div', { style: S.buttonRow },
            h('button', {
              type: 'button', 'data-role': 'publish-batch-submit', disabled: !ready,
              title: ready ? '组装 xy_publish_batch 参数 JSON' : blocked,
              onClick: () => setGenerated(request), style: ready ? S.primary : S.button,
            }, '生成批量发布请求'),
            h('span', { style: S.sectionHint }, '生成的 JSON 交给 agent 调 xy_publish_batch。'))),
        generated === null ? null : h('div', { style: S.preview },
          h('div', { style: S.sectionTitle }, 'xy_publish_batch 参数已就绪'),
          h('pre', { style: S.pre, 'data-role': 'publish-request' }, JSON.stringify(generated, null, 2))),
        h(CommandList, { items: COMMANDS.publish, title: '发布命令' }),
        h('div', { style: S.note }, '面板不执行发布：命令由 agent 调 xy_publish_batch / CLI 执行 —— 执行与 UI 解耦'))
    }

    /** 行内样式表：跟随 DSH 主题变量，不引入样式文件（bundle 纯净度门禁不允许跨插件取值）。 */
    const S = {
      page: { padding: '32px', maxWidth: '860px', margin: '0 auto', color: 'var(--dsw-alias-label-primary)' },
      header: { display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '24px' },
      logo: { fontSize: '34px', lineHeight: '1' },
      title: { fontSize: '20px', fontWeight: 600, lineHeight: '28px' },
      subtitle: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      tabBar: { display: 'flex', gap: '2px', borderBottom: '1px solid var(--dsw-alias-border-l2)', marginBottom: '4px' },
      tab: { fontSize: '13px', padding: '8px 14px', cursor: 'pointer', border: 'none',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
        borderBottom: '2px solid transparent', marginBottom: '-1px' },
      tabActive: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600,
        borderBottom: '2px solid var(--dsw-alias-label-primary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '16px' },
      cardTitle: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px' },
      cardValue: { fontSize: '15px', fontWeight: 500, lineHeight: '22px' },
      cardHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '6px', lineHeight: '18px' },
      section: { marginTop: '24px' },
      sectionTitle: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' },
      sectionHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '10px', lineHeight: '18px' },
      buttonRow: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px' },
      button: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'not-allowed',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l2)',
        color: 'var(--dsw-alias-label-secondary)' },
      primary: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l3)',
        color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
      chipRow: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      chip: { fontSize: '12px', padding: '5px 12px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)' },
      chipActive: { background: 'var(--dsw-alias-bg-l3)', color: 'var(--dsw-alias-label-primary)',
        borderColor: 'var(--dsw-alias-label-secondary)', fontWeight: 600 },
      fieldRow: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '12px' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '180px', flex: '1 1 180px' },
      fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      input: { fontSize: '13px', padding: '6px 10px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)' },
      preview: { marginTop: '16px' },
      pre: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px',
        background: 'var(--dsw-alias-bg-l2)', borderRadius: '8px', padding: '12px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '10px 0 0' },
      cmdRow: { display: 'flex', gap: '10px', alignItems: 'baseline', padding: '5px 0', flexWrap: 'wrap' },
      cmdLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', minWidth: '150px' },
      cmdCode: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px',
        background: 'var(--dsw-alias-bg-l2)', borderRadius: '4px', padding: '2px 6px', wordBreak: 'break-all' },
      note: { marginTop: '24px', fontSize: '13px', lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' },
      textarea: { width: '100%', boxSizing: 'border-box', resize: 'vertical', marginTop: '8px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      okText: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      badText: { fontSize: '12px', color: 'var(--dsw-alias-label-danger, #c0392b)' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px',
        background: 'var(--dsw-alias-bg-l2)', borderRadius: '4px', padding: '1px 5px' },
    }

    /** 账号模块的三张来源卡：都是 daemon/host 侧动作，面板只解释怎么触发。 */
    const ACCOUNT_SOURCES = [
      {
        title: '导入登录态',
        value: '从本机 Chrome 读 cookie',
        hint: 'Chrome 需带 --remote-debugging-port 启动；会加密写凭据，工具执行前要人工确认。',
      },
      {
        title: '扫码登录',
        value: 'npm run daemon:login',
        hint: '打开闲鱼登录页等扫码；unb 与 _m_h5_tk 齐备才算成功（默认等 180s）。',
      },
      {
        title: '凭据存储',
        value: '加密落盘',
        hint: 'Windows 走 DPAPI；daemon 只在执行时解密，插件与 UI 都拿不到 cookie 明文。',
      },
    ]

    /** 账号模块的已知边界：写清「面板看到的是什么、过期怎么处理」，避免被当成实时登录态。 */
    const ACCOUNT_NOTES = [
      '摘要字段只有 id / 最后更新 / 登录态字段数 / 是否可写（unb + _m_h5_tk 齐备）；任何 cookie 值都不出 daemon 进程。',
      '_m_h5_tk 约 2 小时过期：过期后写操作报 AUTH_EXPIRED；重新导入或扫码即可刷新（mtop 响应带新 token 时 daemon 也会自动续期）。',
      '导入与扫码都是写操作（写加密凭据），走 ask 门禁；本面板只读，不联网、不调 daemon。',
    ]

    /**
     * 「账号」模块：登录态来源 + 只读摘要入口 + 已知边界。
     * 面板不碰凭据、不发请求：cookie 只在 daemon 进程里解密，UI 侧将来要用也得先补 host rpc 通道（见页脚）。
     */
    function AccountView() {
      return h('div', null,
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '账号管理'),
          h('div', { style: S.sectionHint }, '登录态来源、只读摘要与刷新方式；面板不读 cookie、不联网')),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '登录态怎么进来'),
          h('div', { style: S.grid },
            ...ACCOUNT_SOURCES.map(source => h(Card, { key: source.title, title: source.title, value: source.value, hint: source.hint })))),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '看当前账号'),
          h('div', { style: S.sectionHint }, '面板不执行工具：下面这些交给 agent 调，摘要在对话里返回。'),
          h('div', { style: S.cmdRow },
            h('span', { style: S.cmdLabel }, '只读摘要'), h('code', { style: S.cmdCode }, 'xy_accounts_list'),
            h('span', { style: S.sectionHint }, '账号 id / 更新于 / 字段数 / 是否可写')),
          h('div', { style: S.cmdRow },
            h('span', { style: S.cmdLabel }, '导入登录态（需确认）'), h('code', { style: S.cmdCode }, 'xy_import_account')),
          h('div', { style: S.cmdRow },
            h('span', { style: S.cmdLabel }, '队列概览里也能看到'), h('code', { style: S.cmdCode }, 'xy_status'),
            h('span', { style: S.sectionHint }, 'accounts 是启动时快照，导入/扫码后 daemon 会刷新'))),
        h('div', { style: S.section }, h('div', { style: S.sectionTitle }, '已知边界'),
          ...ACCOUNT_NOTES.map(note => h('div', { key: note, style: S.sectionHint }, '· ' + note))),
        h('div', { style: S.note },
          '下一步（未做）：面板里直接点「导入 / 扫码」需要 client→host 的 rpc 通道（host 侧 rpc.handle(\'/bigfish\') + 客户端轮询），采用前先写 ADR；在那之前按钮只出现在工具审批里。'))
    }

    /**
     * 浏览器侧插件入口：注册侧边栏栏位与同名主面板。
     * @param {object} ctx - 浏览器 Cordis 上下文（含 slots 服务）。
     * @returns {void}
     */
    function apply(ctx) {
      // 用 inject 而不是直接 register：slots 由宿主插件声明，早于声明注册会在加载期抛错。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'bigfish',
        order: 30,
        label: 'BigFish 闲鱼运营',
      }, BigFishIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'bigfish' }, BigFishPanel))
      // 只注册这两个：侧边栏条目 + 同名主面板。
      // 不注册 conversation.view —— 模块 tab 全部在面板内切换（用户 2026-10-21 明确要求主页面在侧边栏面板里）。
    }

    return { apply, inject: ['slots'] }
  },
})
