/**
 * 品类模板：面板「打印机」的字段清单（选品类 → 勾字段 → 填值 → 生成请求）。
 *
 * 边界：
 * - 只描述「问什么、哪些必填、值是什么类型」，**不含任何合规阈值**——标题 ≤30 字、38 条违禁词、
 *   禁售类目都在 `packages/core/src/policy.ts` 与 `xianyu-listing-audit` skill 里，避免两处规则漂移。
 * - 纯常量 + 深拷贝导出，无 IO、不联网、不调模型；由 rpc `copy.templates` 下发给面板。
 *   client bundle 拿不到 host 模块，所以不能再复刻一份副本（COPY_STYLES 那份副本是 loader 的无奈）。
 * - 除 common 的顶层字段外，品类字段的 id 同时是 `specs` 的键，故限小写字母/数字。
 *
 * @module @bigfish/plugin-ops/category-templates
 */
import { CONDITION_LABELS, CONDITIONS } from './copy.js'

const CONDITION_OPTIONS = CONDITIONS.map(value => ({ value, label: CONDITION_LABELS[value] }))
const SHIPPING_OPTIONS = [{ value: 'free', label: '包邮' }, { value: 'none', label: '不包邮' }]

/** specs 里的规格字段：值一律字符串（尺寸写「约 30cm」也行）。 */
const spec = (id, label, extra = {}) => ({ id, label, type: 'text', group: 'specs', maxLength: 60, ...extra })

/**
 * 通用字段（所有品类都问）。
 * 必填项在面板上锁定勾选、不可取消；`group` 决定 UI 分区与组装位置。
 */
export const COMMON_FIELDS = [
  { id: 'productName', label: '商品名', type: 'text', group: 'base', required: true, maxLength: 120, hint: '原始商品名，可含商家话术；只允许基于它改写' },
  { id: 'condition', label: '成色', type: 'enum', group: 'base', required: true, options: CONDITION_OPTIONS },
  { id: 'priceYuan', label: '售价（元）', type: 'text', group: 'base', required: true, maxLength: 20, hint: '最多两位小数；转分交给 host' },
  { id: 'shipping', label: '运费', type: 'enum', group: 'base', options: SHIPPING_OPTIONS, default: 'free' },
  { id: 'imagePaths', label: '图片路径', type: 'list', group: 'media', maxItems: 9, hint: '本机绝对路径，1–9 张；素材库接入前可在对话里给' },
  { id: 'reason', label: '出售原因', type: 'text', group: 'story', maxLength: 200, hint: '换新 / 搬家 / 闲置；不填就不许编故事' },
  { id: 'usedMonths', label: '使用时长（月）', type: 'integer', group: 'story', min: 0, max: 600 },
  { id: 'flaws', label: '瑕疵', type: 'list', group: 'story', maxItems: 10, hint: '位置 + 现象 + 实拍可证；没有就写「无」' },
  { id: 'accessories', label: '配件', type: 'list', group: 'story', maxItems: 20 },
  { id: 'usedAiImages', label: '含 AI 生成图', type: 'bool', group: 'story', hint: '勾选后描述必须声明 AI 场景示意' },
]

/**
 * 品类表。新增品类 = 追加一项，面板与 rpc 自动跟上；
 * `categoryHint` 只是给 skill 的提示（真正类目由发布页 AI 推荐，工具不自动选）。
 */
export const CATEGORY_TEMPLATES = [
  {
    id: 'digital', label: '数码/手机', categoryHint: '数码/手机',
    specs: [
      spec('model', '型号', { maxLength: 60 }),
      spec('storage', '容量/内存', { maxLength: 40 }),
      spec('battery', '电池健康', { maxLength: 20, hint: '如 89%；换过电池要写明' }),
      spec('warranty', '保修', { maxLength: 40, hint: '在保/过保/无发票' }),
    ],
  },
  {
    id: 'computer', label: '电脑/平板', categoryHint: '电脑/平板',
    specs: [
      spec('model', '型号', { maxLength: 60 }),
      spec('cpu', '处理器', { maxLength: 40 }),
      spec('ram', '内存', { maxLength: 20 }),
      spec('storage', '硬盘/容量', { maxLength: 40 }),
      spec('screen', '屏幕', { maxLength: 40, hint: '尺寸/分辨率/有无划痕' }),
    ],
  },
  {
    id: 'apparel', label: '服饰/鞋包', categoryHint: '服饰/鞋包',
    specs: [
      spec('size', '尺码', { maxLength: 20 }),
      spec('material', '材质', { maxLength: 40 }),
      spec('fit', '版型/跟高', { maxLength: 40 }),
      spec('wear', '穿着次数', { maxLength: 20 }),
    ],
  },
  {
    id: 'home', label: '家居/日用', categoryHint: '家居/日用',
    specs: [
      spec('dimensions', '尺寸', { maxLength: 60, hint: '长 × 宽 × 高，带单位' }),
      spec('material', '材质', { maxLength: 40 }),
      spec('style', '风格/颜色', { maxLength: 40 }),
    ],
  },
  {
    id: 'notes', label: '图书/资料笔记', categoryHint: '图书/资料笔记',
    specs: [
      spec('subject', '科目/主题', { maxLength: 40 }),
      spec('pages', '页数/篇幅', { maxLength: 20 }),
      spec('year', '年份/版本', { maxLength: 20 }),
      spec('format', '形式', { maxLength: 40, hint: '纸质/电子/手写笔记' }),
    ],
  },
  { id: 'other', label: '其他', categoryHint: '', specs: [] },
]

/** 全部品类 id。 */
export const CATEGORY_IDS = CATEGORY_TEMPLATES.map(template => template.id)

/** 找不到品类就返回 undefined（面板据此回退到 first）。 */
export function findCategoryTemplate(categoryId) {
  if (typeof categoryId !== 'string') return undefined
  return CATEGORY_TEMPLATES.find(template => template.id === categoryId)
}

/** 深拷贝：返回值可被调用方随意改，不会污染模块常量（JSON 里全是原始类型）。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * rpc `copy.templates` 的返回值。面板据此渲染品类芯片与字段清单。
 *
 * @returns {{common: object[], categories: {id: string, label: string, categoryHint: string, specs: object[]}[]}} 模板快照。
 */
export function listCategoryTemplates() {
  return { common: clone(COMMON_FIELDS), categories: clone(CATEGORY_TEMPLATES) }
}
