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
      { title: 'daemon', value: '127.0.0.1:47001 · 本地常驻', hint: '面板不联网；在线状态用 xy_ping / xy_status 读' },
    ]

    /** 面板上的按钮都只能看（原因见 BUTTON_NOTE）。 */
    const BUTTONS = [
      { label: '导入登录态', tool: 'xy_import_account' },
      { label: '发布 dry-run', tool: 'xy_publish_draft' },
    ]

    /**
     * 顶部 tab。skill 入口（文案生成）放第一个并默认选中：
     * 这是面板里唯一能产出东西的入口，其余都是只读说明。
     */
    const TABS = [
      { id: 'copy', label: '文案生成' },
      { id: 'overview', label: '概览' },
      { id: 'publish', label: '发布' },
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

    /** 顶部 tab 栏：role=tablist，选中态同时给 aria-selected 与下划线。 */
    function TabBar({ active, onSelect }) {
      return h('div', { role: 'tablist', 'aria-label': 'BigFish 面板分区', style: S.tabBar },
        ...TABS.map(tab => h('button', {
          key: tab.id,
          type: 'button',
          role: 'tab',
          'data-role': 'panel-tab',
          'aria-selected': tab.id === active,
          onClick: () => onSelect(tab.id),
          style: tab.id === active ? { ...S.tab, ...S.tabActive } : S.tab,
        }, tab.label)))
    }

    /** 发布页：通道口径与命令（只读说明，真提交仍走对话审批）。 */
    function PublishTab() {
      return h('div', null,
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, '发布通道'),
          h('div', { style: S.grid },
            h(Card, { title: '默认行为', value: 'dry-run 只填表', hint: '真提交需 daemon 以 BF_PUBLISH_SUBMIT=1 启动' }),
            h(Card, { title: '类目限制', value: '网页端只支持部分类目', hint: '不支持时选中即失败（VALIDATION），不会撞提交；电子资料/学习笔记/课业本可用' }),
            h(Card, { title: '成功判定', value: 'URL 带 item id 或出现成功提示', hint: '超时按失败处理，且不自动重试' }))),
        h(CommandList, { items: COMMANDS.publish, title: '发布命令' }),
        h('div', { style: S.note },
          '先让模型调 xy_publish_draft(mode="dry-run") 校验草稿；确认价格、图片与 AI 图声明后，再 mode="enqueue"（走审批门禁）。'))
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

    /** 当前 tab 的内容区；copy 页的状态仍留在 Panel 里（切走再切回不丢输入）。 */
    function PanelBody({ tab, copyProps }) {
      if (tab === 'overview') {
        return h('div', null,
          h(StatusGrid),
          h(ActionButtons),
          h(CommandList, { items: COMMANDS.account, title: '账号' }))
      }
      if (tab === 'publish') return h(PublishTab)
      if (tab === 'diagnose') return h(DiagnoseTab)
      return h(CopyStudio, copyProps)
    }

    /** 面板骨架：顶部 tab（skill 入口在第一个）+ 内容区 + 门禁说明。 */
    function BigFishPanel() {
      const [tab, setTab] = React.useState(TABS[0].id)
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
            h('div', { style: S.subtitle }, 'P1.3 · 文案生成 / 发布 dry-run / 登录态导入'))),
        h(TabBar, { active: tab, onSelect: setTab }),
        h(PanelBody, { tab, copyProps }),
        h('div', { style: S.note },
          '写操作门禁：导入登录态、入队发布走 ask；dry-run 与 xy_copy_plan 只读放行。实时状态在「诊断」页。真机校准通过前，任何路径都不会声称「发布成功」。'))
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
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px',
        background: 'var(--dsw-alias-bg-l2)', borderRadius: '4px', padding: '1px 5px' },
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
    }

    return { apply, inject: ['slots'] }
  },
})
