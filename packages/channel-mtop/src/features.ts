/**
 * 商品「可学习特征」提取：文案结构 + 主图构成（纯函数、零 IO）。
 *
 * 为什么要这层：单件商品的原始描述与图片**不入库**（AGENTS §1.6 不搬运他人素材），
 * 但「别人的标题怎么分段、描述写几句、主图是方图还是竖图」这类结构信息可以让 LLM 学，
 * 产出的又只有数字与开关 —— 原件过一遍就丢，落库的只有特征。
 *
 * 为什么不猜：平台没给宽高就报 unknown（只计数不编比例）；标题/描述里没有的东西一律 0，
 * 绝不从别处推断。要发的是用户自己的货，这里只负责让「参考」变得可计算。
 * @module @bigfish/channel-mtop/features
 */
import { fail } from '@bigfish/core'
import type { SellerItemCopyFeatures, SellerItemImageFeatures } from '@bigfish/core'

/** 标题分段符：空格 / 全角空格 / 竖线 / 斜杠 / 顿号 / 逗号 / 分号 / 间隔号。 */
const SEGMENT_RE = /[\s\u3000|｜/、,，;；·•]+/u
/** 清单行开头：· - * — / 1. 1、 1) / ① / （1）。 */
const BULLET_RE = /^[\s\u3000]*(?:[·•*—]|-(?=\s)|\d+[.、)）]|[①-⑳]|[（(]\d+[)）])/u
/** emoji 与常见装饰符号（只计数，不保留字符）。 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu
/** 句末：中英文句号/问号/叹号/分号/省略号；换行也算一句结束。 */
const SENTENCE_RE = /[。！？!?；;…\r\n]+/u
/** 行动号召词：只数「出现过几种」，不记录位置也不保留句子。 */
const CTA_WORDS: readonly string[] = [
  '包邮', '秒发', '现货', '可小刀', '私聊', '议价', '拍下',
  '顺丰', '当天发', '不议价', '支持验货', '走平台',
]

/** 平台宽高字段可能是数字或纯数字字符串；其他形态当「没给」。 */
function readDimension(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) {
    const num = Number(value.trim())
    return num > 0 ? num : undefined
  }
  return undefined
}

/** 单张图的比例分类；容差 ±5%（手机直出 3:4 与 0.75 的抖动不当作「混排」）。 */
function classifyRatio(width: number, height: number): 'square' | 'portrait' | 'landscape' {
  const ratio = width / height
  if (Math.abs(ratio - 1) <= 0.05) return 'square'
  return ratio > 1 ? 'landscape' : 'portrait'
}

/**
 * 主图构成：张数 + 宽高比分类 + 真正拿到宽高的张数。
 * 入参必须是详情响应里的 `imageInfos` 原样；**本函数不读、不返回 url**。
 */
export function analyzeImageFeatures(imageInfos: unknown): SellerItemImageFeatures {
  if (!Array.isArray(imageInfos)) return { count: 0, aspect: 'unknown', measured: 0 }
  const shapes = new Set<'square' | 'portrait' | 'landscape'>()
  let measured = 0
  for (const entry of imageInfos) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    // mtop 详情实测字段是 widthSize/heightSize（2026-10-23 真机：imageInfos[*].widthSize=512）；
    // width/height 是早期 fixture 与列表页形态，两种都认，避免「平台换个字段名就永远 unknown」。
    const width = readDimension(record.widthSize) ?? readDimension(record.width)
    const height = readDimension(record.heightSize) ?? readDimension(record.height)
    if (width === undefined || height === undefined) continue
    measured += 1
    shapes.add(classifyRatio(width, height))
  }
  const aspect: SellerItemImageFeatures['aspect'] = measured === 0
    ? 'unknown'
    : shapes.size === 1
      ? (shapes.values().next().value as 'square' | 'portrait' | 'landscape')
      : 'mixed'
  return { count: imageInfos.length, aspect, measured }
}

function countMatches(text: string, pattern: RegExp): number {
  const matched = text.match(pattern)
  return matched === null ? 0 : matched.length
}

/**
 * 文案结构：标题分段/数字组，描述段落/句子/清单行/标签/emoji/行动号召。
 * 只吃标题与描述文本，**只吐数字与开关**——调用方拿不到任何可复用的原文。
 */
export function analyzeCopyStructure(title: unknown, desc?: unknown): SellerItemCopyFeatures {
  if (typeof title !== 'string' || title.trim().length === 0) {
    fail('VALIDATION', 'analyzeCopyStructure 需要非空标题')
  }
  if (desc !== undefined && desc !== null && typeof desc !== 'string') {
    fail('VALIDATION', 'analyzeCopyStructure 的 desc 必须是字符串')
  }
  const titleText = title.trim()
  const descText = typeof desc === 'string' ? desc.trim() : ''
  const lines = descText.length === 0 ? [] : descText.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
  const sentences = descText.length === 0
    ? []
    : descText.split(SENTENCE_RE).map((part) => part.trim()).filter((part) => part.length > 0)
  const segments = titleText.split(SEGMENT_RE).filter((part) => part.trim().length > 0)
  const haystack = titleText + '\n' + descText
  return {
    titleChars: titleText.length,
    descChars: descText.length,
    titleSegments: segments.length,
    descParagraphs: lines.length,
    descSentences: sentences.length,
    avgSentenceChars: sentences.length === 0 ? 0 : Math.round(descText.length / sentences.length),
    bulletLines: lines.filter((line) => BULLET_RE.test(line)).length,
    hasBracketTag: /[【】\[\]（）()]/u.test(haystack),
    emojiCount: countMatches(haystack, EMOJI_RE),
    titleDigitGroups: countMatches(titleText, /\d+/gu),
    ctaCount: CTA_WORDS.filter((word) => haystack.includes(word)).length,
  }
}
