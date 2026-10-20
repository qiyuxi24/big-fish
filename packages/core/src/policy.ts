/**
 * 发布前策略校验（风控红线资产化）。
 *
 * 纯函数、零 IO、零依赖：发布执行器在真正调平台接口前调用 checkListing，
 * 把「能在本地判定」的违规挡掉，避免拿账号去试错。
 *
 * 规则来源（均为"事实"重写，未复制原仓库代码）：
 * - fancyboi999/goofish-cli（Apache-2.0）skills/goofish-risk-guard/references/publish-red-lines.md
 *   红线 3/4/5/2：首图 1:1、≤9 张、描述 <30 字权重低、价格偏离市场价 >70% 进人工审核、类目错放降权。
 * - xiaolu-ai26/XY-Agent（无 LICENSE，仅借鉴思路）forbidden_words.py 的词表分类：
 *   绝对化用语 / 假货术语 / 医疗功效 / 金融承诺 / 违禁品。
 * - 《广告法》第九条极限词与闲鱼社区禁售品类常识（词表为短词，便于命中与维护）。
 *
 * 判定语义：severity==='error' 必须拦下；'warn' 仅提示，不阻塞发布（ok 只由 error 决定）。
 * @module @bigfish/core/policy
 */

/** 待发布草稿；金额一律整数分，imageCount 为已上传成功的图片数。 */
export interface ListingDraft {
  title: string
  description: string
  priceCents: number
  imageCount: number
  /** 首图是否 1:1 正方形；未知可不传（不告警）。 */
  firstImageSquare?: boolean
  /** 同款市场均价（整数分），用于偏离度检查；未知可不传。 */
  marketPriceCents?: number
  /** 类目路径（从一级到末级），用于禁售类目检查。 */
  categoryPath?: readonly string[]
}

/** 本地策略问题码；稳定字符串，daemon 与插件可按码做差异化处理。 */
export type PolicyIssueCode =
  | 'TITLE_EMPTY'
  | 'TITLE_TOO_LONG'
  | 'TITLE_EMOJI'
  | 'DESC_TOO_SHORT'
  | 'DESC_FORBIDDEN_WORD'
  | 'PRICE_INVALID'
  | 'PRICE_DEVIATION'
  | 'IMAGE_COUNT'
  | 'IMAGE_FIRST_NOT_SQUARE'
  | 'CATEGORY_FORBIDDEN'

/** 单条策略问题。 */
export interface PolicyIssue {
  code: PolicyIssueCode
  field: 'title' | 'description' | 'price' | 'images' | 'category'
  message: string
  severity: 'error' | 'warn'
}

/** 默认限额；对应实测结论：标题宜 ≤30 字、描述 <30 字权重低、最多 9 张图、价格偏离 >70% 进人工审核。 */
export const POLICY_LIMITS = {
  maxTitleChars: 30,
  minDescChars: 30,
  maxImages: 9,
  priceDeviationRatio: 0.7,
} as const

/** 发布违禁词（短词，命中即 error）。按类别分组，注释即分类依据。 */
export const FORBIDDEN_WORDS: readonly string[] = [
  // 绝对化用语（广告法极限词）：平台与监管都盯得最紧
  '国家级',
  '最高级',
  '最佳',
  '顶级',
  '绝对',
  '唯一',
  '首个',
  '独家',
  '100%',
  '纯天然',
  '无副作用',
  '零风险',
  // 金融承诺：无资质不得承诺收益
  '稳赚不赔',
  '保证收益',
  '高回报',
  // 假货/侵权术语：直接触发假货判定
  '高仿',
  '复刻',
  '原单',
  '尾单',
  '精仿',
  '假冒',
  '山寨',
  '水货',
  // 医疗功效：普通商品不得宣称疗效
  '包治百病',
  '根治',
  '药到病除',
  '治愈',
  '抗癌',
  '壮阳',
  '三天见效',
  '立竿见影',
  // 违禁品/黑产服务
  '办证',
  '代开发票',
  '枪支',
  '弹药',
  '毒品',
  '窃听器',
  '外挂',
]

/** 禁售/需资质类目关键词；类目路径任一段命中即 error（宁可转人工，也别发错类目）。 */
export const FORBIDDEN_CATEGORIES: readonly string[] = [
  '药品',
  '医疗器械',
  '保健食品',
  '烟草',
  '电子烟',
  '枪支',
  '弹药',
  '管制刀具',
  '毒品',
  '易燃易爆',
  '活体动物',
  '野生动物',
  '证件',
  '发票',
  '银行卡',
  '电话卡',
  '虚拟货币',
  '赌博',
  '色情',
  '成人用品',
]

/** 整数分价格下限：1 元。 */
const MIN_PRICE_CENTS = 100

/** 标题 emoji 检测；Extended_Pictographic 覆盖绝大多数表情，不误伤中文标点。 */
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u

/** 可选阈值覆盖；非法值（非整数、非有限数）回退到 POLICY_LIMITS。 */
export interface ListingPolicyOptions {
  maxTitleChars?: number
  minDescChars?: number
  maxImages?: number
  priceDeviationRatio?: number
}

function issue(code: PolicyIssueCode, field: PolicyIssue['field'], message: string, severity: PolicyIssue['severity']): PolicyIssue {
  return { code, field, message, severity }
}

/** 取正整数阈值；非安全正整数回退默认值，避免调用方传 0/NaN 把校验关掉。 */
function pickInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fallback
}

/** 取比例阈值 (0,1)；越界回退，避免除以 0 或负偏离。 */
function pickRatio(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : fallback
}

function checkTitle(draft: ListingDraft, maxTitleChars: number): PolicyIssue[] {
  const title = typeof draft.title === 'string' ? draft.title.trim() : ''
  if (title.length === 0) return [issue('TITLE_EMPTY', 'title', '标题不能为空', 'error')]
  const issues: PolicyIssue[] = []
  const chars = Array.from(title).length
  if (chars > maxTitleChars) {
    issues.push(issue('TITLE_TOO_LONG', 'title', '标题 ' + String(chars) + ' 字，超过建议上限 ' + String(maxTitleChars) + ' 字', 'warn'))
  }
  if (EMOJI_PATTERN.test(title)) issues.push(issue('TITLE_EMOJI', 'title', '标题含 emoji，建议去掉以降低被误判风险', 'warn'))
  return issues
}

function checkDescription(draft: ListingDraft, minDescChars: number): PolicyIssue[] {
  const description = typeof draft.description === 'string' ? draft.description.trim() : ''
  const issues: PolicyIssue[] = []
  if (Array.from(description).length < minDescChars) {
    issues.push(issue('DESC_TOO_SHORT', 'description', '描述不足 ' + String(minDescChars) + ' 字，搜索权重会偏低', 'warn'))
  }
  for (const word of FORBIDDEN_WORDS) {
    if (description.includes(word)) {
      issues.push(issue('DESC_FORBIDDEN_WORD', 'description', '描述含发布违禁词「' + word + '」', 'error'))
    }
  }
  return issues
}

function checkPrice(draft: ListingDraft, priceDeviationRatio: number): PolicyIssue[] {
  const price = draft.priceCents
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < MIN_PRICE_CENTS) {
    return [issue('PRICE_INVALID', 'price', '价格必须是 ≥1 元的整数分，当前为 ' + String(price), 'error')]
  }
  const market = draft.marketPriceCents
  if (typeof market !== 'number' || !Number.isSafeInteger(market) || market <= 0) return []
  // 只做比例比较，不把金额转成浮点做运算；超出则提示人工确认，避免超低价进审核队列。
  const deviation = Math.abs(price - market) / market
  if (deviation > priceDeviationRatio) {
    const percent = Math.round(deviation * 100)
    return [
      issue('PRICE_DEVIATION', 'price', '价格偏离市场价约 ' + String(percent) + '%，超过 ' + String(Math.round(priceDeviationRatio * 100)) + '% 阈值', 'warn'),
    ]
  }
  return []
}

function checkImages(draft: ListingDraft, maxImages: number): PolicyIssue[] {
  const count = draft.imageCount
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > maxImages) {
    return [issue('IMAGE_COUNT', 'images', '图片数必须在 1-' + String(maxImages) + ' 张之间，当前为 ' + String(count), 'error')]
  }
  if (draft.firstImageSquare === false) {
    return [issue('IMAGE_FIRST_NOT_SQUARE', 'images', '首图不是 1:1 正方形，会被平台判为图片不合规', 'warn')]
  }
  return []
}

function checkCategory(draft: ListingDraft): PolicyIssue[] {
  const path = draft.categoryPath
  if (!Array.isArray(path)) return []
  for (const segment of path) {
    if (typeof segment !== 'string') continue
    const normalized = segment.trim().toLowerCase()
    const hit = FORBIDDEN_CATEGORIES.find((word) => normalized.includes(word))
    if (hit !== undefined) {
      return [issue('CATEGORY_FORBIDDEN', 'category', '类目「' + segment + '」疑似禁售类目（命中「' + hit + '」）', 'error')]
    }
  }
  return []
}

/**
 * 校验发布草稿。纯函数：不修改入参、不读环境、不抛异常。
 * ok===true 表示没有 error 级问题（warn 不阻塞发布）。
 */
export function checkListing(
  draft: ListingDraft,
  options?: ListingPolicyOptions,
): { ok: boolean; issues: PolicyIssue[] } {
  const maxTitleChars = pickInt(options?.maxTitleChars, POLICY_LIMITS.maxTitleChars)
  const minDescChars = pickInt(options?.minDescChars, POLICY_LIMITS.minDescChars)
  const maxImages = pickInt(options?.maxImages, POLICY_LIMITS.maxImages)
  const priceDeviationRatio = pickRatio(options?.priceDeviationRatio, POLICY_LIMITS.priceDeviationRatio)
  const issues: PolicyIssue[] = [
    ...checkTitle(draft, maxTitleChars),
    ...checkDescription(draft, minDescChars),
    ...checkPrice(draft, priceDeviationRatio),
    ...checkImages(draft, maxImages),
    ...checkCategory(draft),
  ]
  return { ok: issues.every((item) => item.severity !== 'error'), issues }
}
