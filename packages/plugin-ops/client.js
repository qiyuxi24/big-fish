/**
 * BigFish 运营面板（DSH 浏览器半侧 / client bundle）。
 *
 * 这个文件是**手写的 loader 产物**，不是构建输出：DSH 的 client 模块系统只会
 * 执行形如 `window.__ModuleLoader__.load({ id, factory })` 的 lazy-CJS bundle，
 * 本仓库零构建、零第三方依赖，所以直接按该格式手写（见 docs/client-plugin-sidebar.md）。
 *
 * - 注册 id 必须与 Loader entry 的包名一致（@bigfish/plugin-ops），否则宿主会报
 *   「bundle loaded without registering」。
 * - 浏览器侧只做 UI：把 daemon 的实时状态留给 host 侧的 xy_* 工具，本插件不读凭据。
 *
 * @module @bigfish/plugin-ops/client
 */
window.__ModuleLoader__.load({
  id: '@bigfish/plugin-ops',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 侧边栏图标的颜色随选中态变化（未选中走次级文字色）。 */
    const ICON_STYLE = { display: 'block', lineHeight: '1' }

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

    /** 面板骨架：P0 阶段只证明「栏位 + 面板」通了，实时数据由 xy_* 工具提供。 */
    function BigFishPanel() {
      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', { style: S.logo }, '🐟'),
          h('div', null,
            h('div', { style: S.title }, 'BigFish 闲鱼运营'),
            h('div', { style: S.subtitle }, 'P0 · 插件已装载，daemon 待接入'))),
        h('div', { style: S.grid },
          h(Card, { title: '发布通道', value: 'CDP 接管真 Chrome', hint: '有资质可切闲管家开放平台' }),
          h(Card, { title: '任务队列', value: 'daemon 持有', hint: '127.0.0.1:47001 · 本地常驻' }),
          h(Card, { title: '写操作门禁', value: '需人工审批', hint: '发布 / 发货 / 擦亮走 ask' })),
        h('div', { style: S.note },
          '本面板是前端占位。实时状态让模型调用 ',
          h('code', { style: S.code }, 'xy_status'),
          ' / ',
          h('code', { style: S.code }, 'xy_tasks_list'),
          ' 读取；P1 再接 daemon 的推送数据。'))
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
