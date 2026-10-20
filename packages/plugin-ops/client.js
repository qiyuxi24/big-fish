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

    /** 可复制命令：按钮不可点时，这是人能在终端直接执行的入口。 */
    const COMMANDS = [
      { label: '导入登录态（CLI）', command: 'npm run daemon:import-account' },
      { label: '发布 dry-run（CLI）', command: 'npm run daemon:publish -- --draft <草稿.json>' },
      { label: '入队发布（需审批）', command: '让模型调用 xy_publish_draft（mode=enqueue）' },
    ]

    const BUTTON_NOTE = '按钮为什么是灰的：宿主没有公开「面板直接调用工具」的 API，工具调用要经过 host 侧审批门禁，入口仍在对话里；也可以复制下面的命令。'

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
    function CommandList() {
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, '可复制命令'),
        ...COMMANDS.map(item => h('div', { key: item.label, style: S.cmdRow },
          h('span', { style: S.cmdLabel }, item.label),
          h('code', { style: S.cmdCode }, item.command))))
    }

    /** 面板骨架：状态区 + 操作入口 + 命令区。 */
    function BigFishPanel() {
      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', { style: S.logo }, '🐟'),
          h('div', null,
            h('div', { style: S.title }, 'BigFish 闲鱼运营'),
            h('div', { style: S.subtitle }, 'P1.2 · 登录态导入 / 发布 dry-run 入口'))),
        h(StatusGrid),
        h(ActionButtons),
        h(CommandList),
        h('div', { style: S.note },
          '写操作门禁：导入登录态、入队发布走 ask；dry-run 只读放行。实时状态让模型调 ',
          h('code', { style: S.code }, 'xy_status'),
          ' / ',
          h('code', { style: S.code }, 'xy_tasks_list'),
          '。真机校准通过前，任何路径都不会声称「发布成功」。'))
    }

    /** 行内样式表：跟随 DSH 主题变量，不引入样式文件（bundle 纯净度门禁不允许跨插件取值）。 */
    const S = {
      page: { padding: '32px', maxWidth: '860px', margin: '0 auto', color: 'var(--dsw-alias-label-primary)' },
      header: { display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '24px' },
      logo: { fontSize: '34px', lineHeight: '1' },
      title: { fontSize: '20px', fontWeight: 600, lineHeight: '28px' },
      subtitle: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '16px' },
      cardTitle: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px' },
      cardValue: { fontSize: '15px', fontWeight: 500, lineHeight: '22px' },
      cardHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '6px', lineHeight: '18px' },
      section: { marginTop: '24px' },
      sectionTitle: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' },
      sectionHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '10px', lineHeight: '18px' },
      buttonRow: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
      button: { fontSize: '13px', padding: '6px 14px', borderRadius: '8px', cursor: 'not-allowed',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l2)',
        color: 'var(--dsw-alias-label-secondary)' },
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
