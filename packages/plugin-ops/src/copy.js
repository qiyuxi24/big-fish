/**
 * 文案风格注入（skill 侧的「语言风格」策略）。
 *
 * 定位：
 * - 本模块只做**确定性的数据组装**：风格表 → 校验输入 → 生成一份可交给 skill/agent 的请求与提示词。
 * - **不调模型、不联网、不写文件、不碰 daemon**。真正出文案的是 agent（按 .agents/skills/xianyu-listing-copy 执行），
 *   将来换成别的 provider 也只替换执行者，请求契约不变——这就是「去耦合」的边界。
 * - 依赖方向：client（面板）只产出 `xy_copy_plan` 的参数 JSON；host 侧本模块把它变成提示词。
 *
 * 单一来源：`COPY_STYLES` 是风格定义的唯一权威。面板 `client.js` 里内嵌了同 id/label 的展示副本
 * （loader 只允许 require 9 个宿主静态模块，拿不到本文件），由 `test/client-bundle.test.mjs` 的
 * 漂移守护比对两边 id 集合，改风格时必须同时改两处。
 *
 * @module @bigfish/plugin-ops/copy
 */
import { DaemonError } from './client.js'

/** 成色枚举，与 .agents/skills/xianyu-listing-copy/references/input-schema.json 对齐。 */
export const CONDITIONS = ['new', 'like-new', 'light-wear', 'visible-wear', 'flawed']

/** 成色中文名，只用于提示词里给人看。 */
export const CONDITION_LABELS = {
  new: '全新',
  'like-new': '几乎全新',
  'light-wear': '轻微使用痕迹',
  'visible-wear': '明显使用痕迹',
  flawed: '有瑕疵',
}

/** 默认风格：闲鱼口语，最不容易写油。 */
export const DEFAULT_STYLE_ID = 'plain'

/**
 * 语言风格表。新增风格只需往这里加一条，工具 schema 与提示词会自动跟上；
 * 面板展示副本要手工同步（见文件头说明）。
 */
export const COPY_STYLES = [
  {
    id: 'plain',
    label: '闲鱼口语',
    summary: '短句直给，像老买家聊天，不客套',
    titleHints: ['型号/规格优先，前 15 字放最值钱的检索词', '不用「超值」「捡漏」「手慢无」这类空话'],
    descHints: ['第一段第一句就给结论（是什么 + 成色）', '多用短句，避免书面语与长定语'],
    tagHints: ['用类目大词 + 型号词，别用形容词凑数'],
    avoid: ['不用「亲」「宝贝」等客服腔', '不写价格与「包邮」（发布页单独填）'],
  },
  {
    id: 'warm',
    label: '亲切安利',
    summary: '带使用感受与推荐理由，语气温和',
    titleHints: ['核心规格 + 一个真实使用场景词', '不为了亲切牺牲检索词'],
    descHints: ['第 2 段写真实使用场景与适合人群，可以温和推荐，但不编个人经历', '交易段语气友好，边界写清楚'],
    tagHints: ['加 1 个人群/场景词（如 #学生党 #通勤）'],
    avoid: ['不写「闭眼入」「无敌好用」等极限词', '不虚构使用故事或赠品'],
  },
  {
    id: 'professional',
    label: '参数党',
    summary: '参数与成色逐条列清楚，适合数码、器材',
    titleHints: ['型号 + 关键参数 + 成色，一项不漏', '不用主观形容词占字数'],
    descHints: ['第 1、3 段规格与瑕疵列表化，每行一条', '瑕疵精确到位置 + 程度 + 是否影响使用'],
    tagHints: ['型号/参数词为主，至少 2 个精准词'],
    avoid: ['不堆砌与成交无关的参数', '不写未做过的检测结论（如「已拆机验过」）'],
  },
  {
    id: 'urgent',
    label: '急出清仓',
    summary: '搬家/换新/清库存，节奏快、直奔交易条件',
    titleHints: ['品类 + 规格 + 真实原因词（如「搬家出」）', '不加虚假倒计时'],
    descHints: ['第 2 段写真实的急出原因，一句话说完', '第 4 段把发货时间、自提点、议价空间写死'],
    tagHints: ['加 1 个出清类词（如 #搬家出清 #清衣柜）'],
    avoid: ['不写「最后一天」「明天删」等虚假紧迫', '不催付款、不写「拍下不退」这类违规话术'],
  },
  {
    id: 'story',
    label: '场景氛围',
    summary: '以使用场景开头，适合家居、服饰、手作',
    titleHints: ['品类 + 材质/风格 + 成色，氛围词最多一个'],
    descHints: ['第 1 段用一句场景带入，随后立刻给参数与成色', '氛围词每段不超过一句，不能挤掉瑕疵与交易信息'],
    tagHints: ['加 1 个风格/空间词（如 #出租屋 #原木风）'],
    avoid: ['不写虚构故事或来历', '不因氛围描写省略瑕疵'],
  },
]

/** 全部合法风格 id。 */
export const COPY_STYLE_IDS = COPY_STYLES.map(style => style.id)

/** 输出契约路径，写进提示词让执行者自己读。 */
const SKILL_PATH = '.agents/skills/xianyu-listing-copy'
const OUTPUT_SCHEMA = SKILL_PATH + '/references/output-schema.json'
const INPUT_SCHEMA = SKILL_PATH + '/references/input-schema.json'

function invalid(message) {
  return new DaemonError('VALIDATION', message)
}

/**
 * 取一条风格定义；未知 id 直接失败，不做「猜一个最像的」。
 *
 * @param {string} [styleId] - 风格 id，缺省用 DEFAULT_STYLE_ID。
 * @returns {object} 风格定义。
 */
export function resolveCopyStyle(styleId) {
  const id = styleId ?? DEFAULT_STYLE_ID
  const style = COPY_STYLES.find(candidate => candidate.id === id)
  if (style === undefined) {
    throw invalid('未知的文案风格：' + String(id) + '（可选：' + COPY_STYLE_IDS.join(' / ') + '）')
  }
  return style
}

/**
 * 「12.30」→ 1230 分。按字符串拆，不做浮点乘法（0.1*100 会出 10.000000000000002）。
 *
 * @param {unknown} value - 用户输入的元（字符串或数字）。
 * @returns {number} 整数分。
 */
export function parseYuanToCents(value) {
  const text = String(value ?? '').trim().replace(/^[¥￥]/u, '')
  if (!/^\d+(\.\d{1,2})?$/u.test(text)) {
    throw invalid('价格必须是元，最多两位小数（例：120 或 99.90），实际收到：' + String(value))
  }
  const [integerPart, decimalPart = ''] = text.split('.')
  const cents = Number(integerPart) * 100 + Number(decimalPart.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents < 100) throw invalid('价格至少 1 元（100 分）')
  return cents
}

function readText(record, key, label, options = {}) {
  const value = record[key]
  if (value === undefined) {
    if (options.required === true) throw invalid(label + ' 必填')
    return undefined
  }
  if (typeof value !== 'string') throw invalid(label + ' 必须是字符串')
  const text = value.trim()
  if (text === '') throw invalid(label + ' 不能是空字符串')
  const max = options.max ?? 200
  if (Array.from(text).length > max) throw invalid(label + ' 超过 ' + String(max) + ' 字')
  return text
}

function readEnum(record, key, label, allowed, fallback) {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(label + ' 只能是：' + allowed.join(' / ') + '，实际收到：' + String(value))
  }
  return value
}

/** 必填枚举：缺省不猜（猜错成色会变成虚假描述）。 */
function readRequiredEnum(record, key, label, allowed) {
  if (record[key] === undefined) throw invalid(label + ' 必填，可选：' + allowed.join(' / '))
  return readEnum(record, key, label, allowed, undefined)
}

function readStringList(record, key, label, max) {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalid(label + ' 必须是字符串数组')
  if (value.length > max) throw invalid(label + ' 最多 ' + String(max) + ' 条')
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw invalid(label + '[' + String(index) + '] 必须是非空字符串')
    }
    return item.trim()
  })
}

function readSpecs(record) {
  const value = record.specs
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('specs 必须是「键 → 字符串」的对象')
  }
  const entries = Object.entries(value)
  if (entries.length > 20) throw invalid('specs 最多 20 项')
  /** @type {Record<string, string>} */
  const specs = {}
  for (const [key, item] of entries) {
    if (typeof item !== 'string') throw invalid('specs.' + key + ' 必须是字符串（尺寸写「约 30cm」也行）')
    specs[key] = item
  }
  return specs
}

/**
 * 把工具参数/面板请求校验并归一化成一份 facts。
 * 价格接受 `priceCents`（整数分，优先）或 `priceYuan`（元，字符串/数字）。
 *
 * @param {unknown} raw - 未校验的输入。
 * @returns {{style: object, facts: object, missing: string[]}} 归一化结果。
 */
export function buildCopyRequest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('文案请求必须是 JSON 对象')
  }
  const record = /** @type {Record<string, unknown>} */ (raw)
  const style = resolveCopyStyle(typeof record.styleId === 'string' ? record.styleId : undefined)

  const priceCents = record.priceCents !== undefined
    ? readPriceCents(record.priceCents)
    : parseYuanToCents(record.priceYuan)

  const imagePaths = readStringList(record, 'imagePaths', 'imagePaths', 9)
  const flaws = readStringList(record, 'flaws', 'flaws', 10)
  const accessories = readStringList(record, 'accessories', 'accessories', 20)
  const variantCount = readEnumCount(record.variantCount)

  /** @type {Record<string, unknown>} */
  const facts = {
    productName: readText(record, 'productName', '商品名', { required: true, max: 120 }),
    condition: readRequiredEnum(record, 'condition', '成色', CONDITIONS),
    priceCents,
    shipping: readEnum(record, 'shipping', '运费', ['free', 'none'], 'free'),
    tone: style.id,
    variantCount,
    usedAiImages: record.usedAiImages === true,
  }

  const categoryHint = readText(record, 'categoryHint', '类目提示', { max: 120 })
  if (categoryHint !== undefined) facts.categoryHint = categoryHint
  const specs = readSpecs(record)
  if (specs !== undefined) facts.specs = specs
  if (flaws !== undefined) facts.flaws = flaws
  if (accessories !== undefined) facts.accessories = accessories
  if (imagePaths !== undefined) facts.imagePaths = imagePaths

  // 图片缺失不阻断「出提示词」，但必须显式告诉执行者：落稿前要补 images（1–9 张）。
  const missing = []
  if (imagePaths === undefined || imagePaths.length === 0) missing.push('imagePaths')

  return { style, facts, missing }
}

function readPriceCents(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 100) {
    throw invalid('priceCents 必须是 ≥100 的整数（单位：分）；用元请传 priceYuan')
  }
  return value
}

function readEnumCount(value) {
  if (value === undefined) return 1
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 3) {
    throw invalid('variantCount 只能是 1–3 的整数')
  }
  return value
}

/**
 * 把归一化结果渲染成可直接喂给 agent 的提示词。
 * 刻意不复述 38 条违禁词：红线由 .agents/skills/xianyu-listing-audit 统一持有，避免两处规则漂移。
 *
 * @param {{style: object, facts: object, missing: string[]}} request - buildCopyRequest 的返回值。
 * @returns {string} 多行提示词。
 */
export function renderCopyPrompt(request) {
  const { style, facts, missing } = request
  const lines = [
    '【skill】' + SKILL_PATH + '（按 SKILL.md 的步骤 3–5 执行；本段风格约束优先于其中的默认语气）',
    '【语言风格】' + style.id + ' · ' + style.label + ' —— ' + style.summary,
    '',
    '【风格约束】',
    ...style.titleHints.map(hint => '- 标题：' + hint),
    ...style.descHints.map(hint => '- 描述：' + hint),
    ...style.tagHints.map(hint => '- 标签：' + hint),
  ]
  if (style.avoid.length > 0) {
    lines.push('', '【这个风格最容易写油的地方】', ...style.avoid.map(item => '- ' + item))
  }
  lines.push(
    '',
    '【事实（唯一允许的信息来源，不得编造/推断）】',
    JSON.stringify(facts, null, 2),
    '',
    '【输入契约】' + INPUT_SCHEMA,
    '【输出契约】' + OUTPUT_SCHEMA + '：只输出纯 JSON，不加 markdown 围栏与解释。',
    '【红线】按 .agents/skills/xianyu-listing-audit 自检；违规就换词，不删事实。',
  )
  if (missing.length > 0) {
    lines.push('', '【待补】' + missing.join(' / ') + '：出稿前必须补齐（图片 1–9 张，本机绝对路径），否则不能进入 dry-run。')
  }
  lines.push('', '【下一步】写出草稿 JSON → xy_publish_draft(mode="dry-run") → 人工确认价格/图/AI 图声明 → mode="enqueue"。')
  return lines.join('\n')
}

/**
 * 一次性完成「校验 + 渲染」，工具与测试共用。
 *
 * @param {unknown} raw - 未校验的输入。
 * @returns {{text: string, request: {style: object, facts: object, missing: string[]}}} 结果。
 */
export function planCopy(raw) {
  const request = buildCopyRequest(raw)
  return { text: renderCopyPrompt(request), request }
}
