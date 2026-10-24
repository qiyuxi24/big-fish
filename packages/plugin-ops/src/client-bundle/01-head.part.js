    // 生成物：由 scripts/build-client.mjs 从 src/client-bundle/*.part.js 拼接而成，不要直接编辑本文件。
/**
 * BigFish 运营面板（client bundle；手写 loader 产物，id 必须等于包名）。
 * 只做 UI 与只读状态：daemon 状态走 rpc 每 3 秒轮询，失败降级成一行；写操作走 host 审批。
 * @module @bigfish/plugin-ops/client
 */
window.__ModuleLoader__.load({
  id: '@bigfish/plugin-ops',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const ICON_STYLE = { display: 'block', lineHeight: '1' }
    /**
     * 面板内模块 tab：**唯一定义点**——一条记录 = 一个模块（id / 文案 / 分组 / 组件）。
     * 分组只影响渲染顺序上的小字标签：监控（看状态）/ 准备（备料）/ 作业（动手）。
     * 加模块 = 这里追加一条 + 新片段（每片段 ≤ 400 行）；`PanelBody` 查表渲染，不需要再补 if 分支。
     * 组件都是函数声明（会被提升到 factory 顶部），所以这里可以按名字引用后面片段里的组件。
     * `pickProps` 只给需要面板级状态（文案表单）的模块用，默认注入 `{ connection }`。
     */
    const PANEL_TABS = [
      { id: 'overview', label: '概览', group: '监控', component: OverviewTab },
      { id: 'account', label: '账号', group: '准备', component: AccountView },
      { id: 'research', label: '采集', group: '准备', component: ReferenceView },
      { id: 'copy', label: '文案', group: '准备', component: CopyStudio, pickProps: props => props.copyProps },
      { id: 'publish', label: '发布', group: '作业', component: PublishBatchView },
      { id: 'items', label: '商品', group: '作业', component: ItemsView },
    ]
    /** 默认落地页 = 清单第一项；不要在别处再写死 'overview'。 */
    const DEFAULT_TAB_ID = PANEL_TABS[0].id
    /** 任务种类：与 src/rpc-schema.js 的 TASK_KINDS 一致；deliver / reply 未接线，筛选里置灰只占位。 */
    const TASK_KINDS = [['publish', '发布'], ['polish', '擦亮'], ['probe', '探测'], ['deliver', '发货'], ['reply', '客服']]
    /** 未接线的任务种类：daemon 执行器直接抛 UNSUPPORTED，面板给出口径但不给入口。 */
    const UNSUPPORTED_KINDS = {
      deliver: '自动发货：未接线（缺 IM 协议与卡密规则引擎）',
      reply: 'AI 客服：未接线（缺 wss-goofish 握手与心跳）',
    }
    const PUBLISH_MODES = [['dry-run', 'dry-run 只填表', '只填表，不点提交'], ['enqueue', 'enqueue 入队', '写进 daemon 队列，走审批']]
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
    const CATEGORY_MATRIX = '✅ 电子资料 / 学习笔记 / 课业本；❌ 教材教辅 / 培训 / 文学 / 考研咨询（网页端）'
