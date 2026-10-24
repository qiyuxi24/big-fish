/**
 * 「可学习特征」的契约与校验（文案结构 / 主图构成）。
 *
 * 为什么单独成文件：seller-items.ts 已接近 400 行上限（AGENTS §3），而特征这一层
 * 既被仓储读写（落库/读回），又被 channel-mtop 的提取函数当返回类型用，单独收口最省事。
 *
 * 红线（AGENTS §1.6）：这两组特征**只有数字与开关**——不含标题/描述原文，不含任何图片地址。
 * 让 LLM「学别人怎么写、怎么拍」学的是结构与比例，原件不入库、不转发。
 * @module @bigfish/core/seller-features
 */
import { XianyuError, fail } from './errors.ts'

/** 文案结构特征：只留数字与开关（给 LLM 学「长什么样」），**不存原文一个字**。 */
export interface SellerItemCopyFeatures {
  titleChars: number
  /** 描述字符数；没有描述为 0。 */
  descChars: number
  /** 标题被空格 / 竖线 / 顿号 / 逗号切出的段数。 */
  titleSegments: number
  /** 描述段落数（按换行切）。 */
  descParagraphs: number
  /** 描述句子数（句末标点与换行都算）。 */
  descSentences: number
  /** 平均句长（字符，四舍五入）；无描述为 0。 */
  avgSentenceChars: number
  /** 以 · - 1. ① 等开头的行为数（清单式写法）。 */
  bulletLines: number
  /** 是否用【】[]（）打标签。 */
  hasBracketTag: boolean
  emojiCount: number
  /** 标题里的数字组数（型号 / 规格 / 成色）。 */
  titleDigitGroups: number
  /** 出现过的行动号召词个数（包邮 / 秒发 / 可小刀…）。 */
  ctaCount: number
}

/** 主图构成特征：只有张数与宽高比分类，**不含任何图片地址**。 */
export interface SellerItemImageFeatures {
  count: number
  /** 全部图同一比例才算具体值；平台没给宽高时 unknown。 */
  aspect: 'square' | 'portrait' | 'landscape' | 'mixed' | 'unknown'
  /** 真正拿到宽高信息的张数（平台常只给 url）。 */
  measured: number
}

/** 主图比例只有这 5 种取值；未知/混排都不猜。 */
const ASPECTS: readonly SellerItemImageFeatures['aspect'][] = ['square', 'portrait', 'landscape', 'mixed', 'unknown']

/** 特征对象必须是普通对象；数组/基本类型一律拒（外部解析结果不可信）。 */
function requireFeatureObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('VALIDATION', label + ' 必须是对象')
  }
  return value as Record<string, unknown>
}

/** 特征计数：非负安全整数；缺字段也拒（结构特征宁可整条不要，也不半真半假）。 */
function requireFeatureCount(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('VALIDATION', '特征字段 ' + field + ' 必须是非负安全整数：' + String(value).slice(0, 40))
  }
  return value
}

function requireFeatureFlag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail('VALIDATION', '特征字段 ' + field + ' 必须是布尔')
  return value
}

/** 文案结构特征窄化：字段缺一个就整条拒，避免「部分特征」被当成完整数据用。 */
export function assertCopyFeatures(value: unknown): SellerItemCopyFeatures {
  const record = requireFeatureObject(value, 'copyFeatures')
  return {
    titleChars: requireFeatureCount(record, 'titleChars'),
    descChars: requireFeatureCount(record, 'descChars'),
    titleSegments: requireFeatureCount(record, 'titleSegments'),
    descParagraphs: requireFeatureCount(record, 'descParagraphs'),
    descSentences: requireFeatureCount(record, 'descSentences'),
    avgSentenceChars: requireFeatureCount(record, 'avgSentenceChars'),
    bulletLines: requireFeatureCount(record, 'bulletLines'),
    hasBracketTag: requireFeatureFlag(record.hasBracketTag, 'hasBracketTag'),
    emojiCount: requireFeatureCount(record, 'emojiCount'),
    titleDigitGroups: requireFeatureCount(record, 'titleDigitGroups'),
    ctaCount: requireFeatureCount(record, 'ctaCount'),
  }
}

/** 主图构成窄化：aspect 只认 5 个枚举值。 */
export function assertImageFeatures(value: unknown): SellerItemImageFeatures {
  const record = requireFeatureObject(value, 'imageFeatures')
  const aspect = record.aspect
  const matched = ASPECTS.find((candidate) => candidate === aspect)
  if (matched === undefined) {
    fail('VALIDATION', '特征字段 aspect 非法：' + String(aspect).slice(0, 20))
  }
  return {
    count: requireFeatureCount(record, 'count'),
    aspect: matched,
    measured: requireFeatureCount(record, 'measured'),
  }
}

/** 库里的特征列：损坏/结构不对按 STORAGE 上报（不是调用方的 VALIDATION）。 */
export function decodeFeatureColumn<T>(raw: string | undefined, label: string, assert: (value: unknown) => T): T | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new XianyuError({ code: 'STORAGE', message: label + ' 列不是合法 JSON', cause: error })
  }
  try {
    return assert(parsed)
  } catch (error) {
    throw new XianyuError({ code: 'STORAGE', message: label + ' 列结构不对', cause: error })
  }
}
