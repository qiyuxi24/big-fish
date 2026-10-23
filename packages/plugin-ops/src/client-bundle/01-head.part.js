    // 生成物：由 scripts/build-client.mjs 从 src/client-bundle/*.part.js 拼接而成，不要直接编辑本文件。
/**
 * BigFish 运营面板（client bundle；手写 loader 产物，id 必须等于包名）。
 * 只做 UI 与只读状态：daemon 状态走 ctx.connection.rpc.call('/bigfish', ...) 每 3 秒轮询，
 * 失败统一降级成一行提示；写操作仍由 agent 走 host 侧审批门禁。
 * @module @bigfish/plugin-ops/client
 */
window.__ModuleLoader__.load({
  id: '@bigfish/plugin-ops',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const ICON_STYLE = { display: 'block', lineHeight: '1' }
    /** 面板内模块 tab：全部在侧边栏面板里切换（不注册 conversation.view）。 */
    const PANEL_TABS = [
      { id: 'publish-batch', label: '自动发布' }, { id: 'account', label: '账号' }, { id: 'copy', label: '文案' },
      { id: 'reference', label: '采集' }, { id: 'overview', label: '概览' }, { id: 'diagnose', label: '诊断' },
    ]
    const PUBLISH_MODES = [['dry-run', 'dry-run（只填表）', '只填表、不点提交'], ['enqueue', 'enqueue（入队，走审批）', '入队后由 daemon 执行，需要审批门禁']]
    /** 语言风格展示副本；权威定义在 src/copy.js 的 COPY_STYLES，漂移由单测守护。 */
    const COPY_STYLE_OPTIONS = [
      { id: 'plain', label: '闲鱼口语', summary: '短句直给，像老买家聊天，不客套' },
      { id: 'warm', label: '亲切安利', summary: '带使用感受与推荐理由，语气温和' },
      { id: 'professional', label: '参数党', summary: '参数与成色逐条列清楚，适合数码、器材' },
      { id: 'urgent', label: '急出清仓', summary: '搬家/换新/清库存，节奏快、直奔交易条件' },
      { id: 'story', label: '场景氛围', summary: '以使用场景开头，适合家居、服饰、手作' },
    ]
    /** 成色选项，与 skill 的 condition 枚举一致。 */
    const CONDITION_OPTIONS = [
      { id: 'new', label: '全新' }, { id: 'like-new', label: '几乎全新' }, { id: 'light-wear', label: '轻微使用痕迹' },
      { id: 'visible-wear', label: '明显使用痕迹' }, { id: 'flawed', label: '有瑕疵' },
    ]
    const CATEGORY_MATRIX = '✅ 电子资料 / 学习笔记 / 课业本；❌ 教材教辅 / 语言与兴趣培训 / 学习资料定制 / 文学 / 考研咨询（网页端不支持发布）'
