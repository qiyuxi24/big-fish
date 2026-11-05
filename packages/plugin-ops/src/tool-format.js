/**
 * 工具输出的格式化与窄化助手。
 *
 * 为什么单独成文件：这些函数是「daemon JSON → 人类可读文本」的纯函数，
 * 与工具注册（访问级别/门禁/参数 schema）无关。tools.js 只留规格声明，
 * 加一条工具不用再翻过 170 行格式化代码。
 * @module @bigfish/plugin-ops/tool-format
 */
import { DaemonError } from './client.js'

/** formatStatus 的输出顺序：与 core 的 TaskState 一致。 */
const TASK_STATE_ORDER = ['queued', 'leased', 'done', 'failed', 'needs_review']

/** cents → 「¥129.90」；非整数分原样显示，不为展示抛错。 */
export function formatMoney(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return String(cents)
  return '¥' + (cents / 100).toFixed(2)
}

/**
 * 窄化 daemon 的参考报告；结构不对直接 INTERNAL（宁可不显示，也不展示半真半假的统计）。
 * 只读口径：报告里本来就没有图片直链，这里也不补。
 */
export function readReferenceReport(value) {
  if (value === null || typeof value !== 'object') {
    throw new DaemonError('INTERNAL', 'daemon 返回的参考报告不是对象')
  }
  const summary = value.summary
  if (summary === null || typeof summary !== 'object') {
    throw new DaemonError('INTERNAL', 'daemon 返回的参考报告缺少 summary')
  }
  const number = field => (typeof summary[field] === 'number' ? summary[field] : 0)
  const price = summary.priceCents ?? {}
  const title = summary.titleLength ?? {}
  const aspect = summary.imageAspect ?? {}
  const structure = summary.copyStructure ?? {}
  const aspectOf = key => (typeof aspect[key] === 'number' ? aspect[key] : 0)
  const structureOf = key => (typeof structure[key] === 'number' ? structure[key] : 0)
  return {
    items: Array.isArray(value.items) ? value.items.length : 0,
    summary: {
      count: number('count'),
      priceCents: {
        min: typeof price.min === 'number' ? price.min : 0,
        median: typeof price.median === 'number' ? price.median : 0,
        max: typeof price.max === 'number' ? price.max : 0,
        avg: typeof price.avg === 'number' ? price.avg : 0,
      },
      titleLength: {
        min: typeof title.min === 'number' ? title.min : 0,
        max: typeof title.max === 'number' ? title.max : 0,
        avg: typeof title.avg === 'number' ? title.avg : 0,
      },
      imageCountAvg: number('imageCountAvg'),
      descRatio: number('descRatio'),
      categories: Array.isArray(summary.categories) ? summary.categories : [],
      keywords: Array.isArray(summary.keywords) ? summary.keywords : [],
      imageAspect: {
        square: aspectOf('square'),
        portrait: aspectOf('portrait'),
        landscape: aspectOf('landscape'),
        mixed: aspectOf('mixed'),
        unknown: aspectOf('unknown'),
      },
      copyStructure: {
        titleSegmentsAvg: structureOf('titleSegmentsAvg'),
        descSentencesAvg: structureOf('descSentencesAvg'),
        bracketTagRatio: structureOf('bracketTagRatio'),
        ctaRatio: structureOf('ctaRatio'),
      },
    },
    sellers: Array.isArray(value.sellers) ? value.sellers : [],
    skipped: Array.isArray(value.skipped) ? value.skipped : [],
    ...(value.seller === undefined || value.seller === null ? {} : { seller: value.seller }),
  }
}

/** 人类可读的参考分析摘要：只给统计，不给任何「拿来就能发」的成品。 */
export function formatReferenceReport(report) {
  const { summary } = report
  const lines = ['参考分析：' + summary.count + ' 件（只读统计，不含图片与可发布草稿）']
  if (summary.count > 0) {
    lines.push(
      '价格带：' + formatMoney(summary.priceCents.min) + ' ~ ' + formatMoney(summary.priceCents.max) +
        '，中位 ' + formatMoney(summary.priceCents.median) + '，均值 ' + formatMoney(summary.priceCents.avg),
    )
    lines.push(
      '标题：' + summary.titleLength.min + '~' + summary.titleLength.max + ' 字（均 ' + summary.titleLength.avg + '）；' +
        '图片均 ' + summary.imageCountAvg.toFixed(1) + ' 张；有描述占 ' + Math.round(summary.descRatio * 100) + '%',
    )
    if (summary.categories.length > 0) {
      lines.push('类目分布：' + summary.categories.slice(0, 5).map(c => c.categoryId + ' ×' + c.count).join('、'))
    }
    if (summary.keywords.length > 0) {
      lines.push('高频卖点词：' + summary.keywords.slice(0, 10).map(k => k.word + '(' + k.count + ')').join('、'))
    }
    // 结构特征：只有比例与计数，学「怎么写、怎么拍」，不含任何原文与图片地址。
    lines.push(
      '结构：主图 方 ' + summary.imageAspect.square + ' / 竖 ' + summary.imageAspect.portrait +
        ' / 横 ' + summary.imageAspect.landscape + ' / 混 ' + summary.imageAspect.mixed +
        ' / 未测 ' + summary.imageAspect.unknown +
        '；标题均 ' + summary.copyStructure.titleSegmentsAvg + ' 段、描述均 ' + summary.copyStructure.descSentencesAvg + ' 句；' +
        '带标签 ' + Math.round(summary.copyStructure.bracketTagRatio * 100) + '%、含行动号召 ' + Math.round(summary.copyStructure.ctaRatio * 100) + '%',
    )
  }
  const seller = report.seller
  if (seller !== undefined) {
    const bits = []
    if (typeof seller.displayName === 'string') bits.push(seller.displayName)
    if (typeof seller.city === 'string') bits.push(seller.city)
    if (typeof seller.itemCount === 'number') bits.push('在售 ' + seller.itemCount + ' 件')
    if (bits.length > 0) lines.push('商家：' + bits.join(' · '))
  }
  if (report.skipped.length > 0) {
    lines.push('⚠️ ' + report.skipped.length + ' 件读取失败已跳过：' + report.skipped.slice(0, 5).join('、') + '（单条失败不影响整批）')
  }
  lines.push('红线：只做统计参考，不下载他人图片、不照抄文案、不跨账号复制商品；要发的是自己的货。')
  return lines.join('\n')
}

/**
 * 窄化 daemon 的「市场简报」（聚合已采集的他人商品快照）。
 * 结构不对直接 INTERNAL：定价和结构建议是发布前的依据，宁可报错也不展示半真半假的数字。
 * 兼容两种信封：`{brief, priceSuggestion, keywords}` 与直接把 brief 摊平返回。
 */
export function readMarketBrief(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DaemonError('INTERNAL', 'daemon 返回的市场简报不是对象')
  }
  const envelope = value
  const brief = envelope.brief === undefined || envelope.brief === null ? envelope : envelope.brief
  if (brief === null || typeof brief !== 'object' || Array.isArray(brief)) {
    throw new DaemonError('INTERNAL', 'daemon 返回的市场简报缺少 brief')
  }
  const number = (raw) => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0)
  const price = brief.priceCents ?? {}
  const title = brief.titleLength ?? {}
  const aspect = brief.imageAspect ?? {}
  const suggestion = envelope.priceSuggestion ?? brief.priceSuggestion
  const keywords = Array.isArray(envelope.keywords) ? envelope.keywords : Array.isArray(brief.keywords) ? brief.keywords : []
  return {
    sampleSize: number(brief.sampleSize),
    priceCents: {
      p25: number(price.p25),
      p50: number(price.p50),
      p75: number(price.p75),
      min: number(price.min),
      max: number(price.max),
    },
    titleLength: { min: number(title.min), max: number(title.max), avg: number(title.avg) },
    titleSegmentsAvg: number(brief.titleSegmentsAvg),
    descSentencesAvg: number(brief.descSentencesAvg),
    bracketTagRatio: number(brief.bracketTagRatio),
    ctaRatio: number(brief.ctaRatio),
    imageCountAvg: number(brief.imageCountAvg),
    imageAspect: {
      square: number(aspect.square),
      portrait: number(aspect.portrait),
      landscape: number(aspect.landscape),
      mixed: number(aspect.mixed),
      unknown: number(aspect.unknown),
    },
    keywords: keywords
      .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.word === 'string' && entry.word !== '')
      .slice(0, 10)
      .map(entry => ({ word: entry.word, count: number(entry.count) })),
    priceSuggestion: suggestion === null || typeof suggestion !== 'object' || Array.isArray(suggestion)
      ? undefined
      : {
        lowCents: number(suggestion.lowCents),
        suggestedCents: number(suggestion.suggestedCents),
        highCents: number(suggestion.highCents),
        basis: typeof suggestion.basis === 'string' ? suggestion.basis : '',
      },
  }
}

/** 主图规格分布里占多数的那一种；全 0 时返回「未测」。 */
function dominantAspect(aspect) {
  const labels = { square: '方图', portrait: '竖图', landscape: '横图', mixed: '混排', unknown: '未测' }
  let best = 'unknown'
  for (const key of ['square', 'portrait', 'landscape', 'mixed']) {
    if (aspect[key] > aspect[best]) best = key
  }
  return labels[best]
}

/**
 * 样本价格跨度过大时给一句提醒（返回 null 表示不需要）。
 *
 * 为什么需要：同一类目下常混着「电子版资料 ¥4」和「实体笔记 ¥150」，中位价会被拉低，
 * 建议价看着便宜但根本不是同类货的行情（2026-10-23 真机采集：笔记类目样本 ¥3.88 ~ ¥150）。
 * 阈值取 3 倍：同款不同成色的正常浮动很少超过 3 倍，超过就该提示「先按同款再核一遍」。
 */
export function priceSpreadNote(priceCents) {
  const min = typeof priceCents?.min === 'number' ? priceCents.min : 0
  const max = typeof priceCents?.max === 'number' ? priceCents.max : 0
  if (min <= 0 || max < min * 3) return null
  const times = Math.round((max * 10) / min) / 10
  return '注意：样本价格跨度 ' + String(times) + ' 倍（' + formatMoney(min) + ' ~ ' + formatMoney(max) +
    '），可能混了不同形态/成色的货，建议价只当量级参考，落地前按同款再核一遍。'
}

/** 人类可读的市场简报：只给统计与建议价，不给任何成品文案（不照抄他人）。 */
export function formatMarketBrief(brief) {
  if (brief.sampleSize === 0) {
    return [
      '市场简报：还没有可用的样本。',
      '先采集他人的在售商品入库（xy_reference_collect 或面板「采集」tab），再来取简报。',
      '红线：只学结构与价格带，不下载他人图片、不照抄文案、不跨账号复制商品。',
    ].join('\n')
  }
  const lines = ['市场简报：' + brief.sampleSize + ' 件样本（已入库的他人商品，只读统计）']
  lines.push(
    '价格带：' + formatMoney(brief.priceCents.p25) + ' ~ ' + formatMoney(brief.priceCents.p75) +
      '（p25~p75），中位 ' + formatMoney(brief.priceCents.p50) +
      '，最低 ' + formatMoney(brief.priceCents.min) + ' / 最高 ' + formatMoney(brief.priceCents.max),
  )
  if (brief.priceSuggestion !== undefined) {
    const s = brief.priceSuggestion
    lines.push(
      '建议价：' + formatMoney(s.suggestedCents) + '（区间 ' + formatMoney(s.lowCents) + ' ~ ' + formatMoney(s.highCents) + '）' +
        (s.basis === '' ? '' : ' · ' + s.basis),
    )
  }
  const spread = priceSpreadNote(brief.priceCents)
  if (spread !== null) lines.push(spread)
  lines.push(
    '结构：标题均 ' + brief.titleLength.avg + ' 字 / ' + brief.titleSegmentsAvg + ' 段；描述均 ' + brief.descSentencesAvg + ' 句；' +
      '带标签 ' + Math.round(brief.bracketTagRatio * 100) + '%、含行动号召 ' + Math.round(brief.ctaRatio * 100) + '%',
  )
  lines.push('图片：均 ' + brief.imageCountAvg.toFixed(1) + ' 张，主图以' + dominantAspect(brief.imageAspect) + '为主')
  if (brief.keywords.length > 0) {
    lines.push('高频词：' + brief.keywords.map(k => k.word + '(' + k.count + ')').join('、'))
  }
  lines.push('怎么用：xy_copy_plan 带上 marketCategoryId/marketSellerId 就会把这份简报写进提示词；定价偏离建议价超过 30% 要在草稿里给理由。')
  lines.push('红线：只学结构与价格带，不下载他人图片、不照抄文案、不跨账号复制商品。')
  return lines.join('\n')
}

/** 把简报压成提示词里的一小段（只留有决策价值的字段，不塞整份 JSON）。 */
export function toCopyMarketHints(brief) {
  return {
    sampleSize: brief.sampleSize,
    priceCents: brief.priceCents,
    priceSuggestion: brief.priceSuggestion,
    titleSegmentsAvg: brief.titleSegmentsAvg,
    descSentencesAvg: brief.descSentencesAvg,
    bracketTagRatio: brief.bracketTagRatio,
    ctaRatio: brief.ctaRatio,
    imageCountAvg: brief.imageCountAvg,
    imageAspect: dominantAspect(brief.imageAspect),
    keywords: brief.keywords.map(k => k.word),
  }
}
/** daemon 返回的任务至少要有 id/kind/state 三个身份字段才算「任务详情」。 */
function hasTaskIdentity(task) {
  return task !== null && typeof task === 'object' && !Array.isArray(task)
    && typeof task.id === 'string' && task.id !== ''
    && typeof task.kind === 'string' && task.kind !== ''
    && typeof task.state === 'string' && task.state !== ''
}

/** 人类可读的任务一行摘要。
 *
 * id 必须给全长：用户要拿它调 xy_task_retry、或者去日志里 grep，
 * 截断成 8 位就再也对不上了（面板侧也一样，见 09-publish.part.js）。
 * 拿到的不是任务对象时给一句人话，而不是四个空竖线（审计 §1.3）。
 */
export function formatTaskLine(task) {
  if (!hasTaskIdentity(task)) return '(未返回任务详情)'
  const attemptText = typeof task.attempts === 'number' && typeof task.maxAttempts === 'number'
    ? `attempt ${task.attempts}/${task.maxAttempts}`
    : 'attempt ?'
  const parts = [task.id, task.kind, task.state, attemptText]
  if (task.dedupeKey) parts.push(`key=${task.dedupeKey}`)
  if (task.lastError) parts.push(`last=${String(task.lastError).slice(0, 80)}`)
  return parts.join(' | ')
}

/**
 * 列表末尾按需给「至多一行」汇总导航，取代原来每条任务都挂一句 taskNextStep。
 *
 * 为什么收成一行：failed/leased 的指路文本随每次 xy_tasks_list 常驻进上下文，
 * 20 条里 7 条 failed 就重复 7 次；具体 id 本就在 formatTaskLine 里全长给出，
 * 模型照着拼参数即可，不需要逐条喂命令（2026-11-05 审计 §二.B / §四.2）。
 *
 * @param {unknown[]} tasks - 本轮取回的任务数组。
 * @returns {string} 空串表示没有需要提示的状态。
 */
export function formatTaskListNextSteps(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  const replayable = list.some(task => task?.state === 'failed' || task?.state === 'needs_review')
  const stuck = list.some(task => task?.state === 'leased' && typeof task?.availableAt === 'number' && task.availableAt <= Date.now())
  const bits = []
  if (replayable) bits.push('failed/needs_review 用 xy_task_retry 重放')
  if (stuck) bits.push('卡住的 leased 用 xy_task_action release')
  return bits.length === 0 ? '' : '\n提示：' + bits.join('；') + '。'
}

/**
 * 一行结论：把「4 行原始计数」翻译成「现在能不能开工」。
 *
 * 为什么需要：四个读工具（health/status/accounts/tasks）里只有 xy_status 是「我该干什么」的入口，
 * 但它原先只有 4 行裸计数，用户还得自己判断。结论行放在第一行——先给判断，再给证据。
 */
export function statusVerdict(status) {
  const queue = status.queue ?? {}
  const worker = status.worker ?? undefined
  const accounts = Array.isArray(status.accounts) ? status.accounts : []
  const circuits = Object.keys(status.circuits ?? {})
  if (accounts.length === 0) return '现在不能开工：还没有账号。先在面板「账号」tab 导入，或跑 pnpm daemon:login 扫码。'
  // 注意：熔断表里可能有已删/未接入的账号，所以判「全熔断」要比账号 id，而不是比数量。
  if (accounts.every(id => circuits.includes(id))) {
    return '现在不能开工：所有账号都在熔断中（' + circuits.join(', ') + '）。等冷却，或用 xy_circuit_reset 复位后再试（写操作，要人工确认）。'
  }
  if (worker !== undefined && worker.errors > 0 && worker.leased === 0 && (queue.leased ?? 0) > 0) {
    return '卡住了：有 ' + String(queue.leased) + ' 条任务在租约里，但 worker 一次都没领到（内部错误 ' + String(worker.errors) + ' 次）。先看 daemon 日志。'
  }
  if ((queue.needs_review ?? 0) > 0) {
    return '需要人看一眼：' + String(queue.needs_review) + ' 条任务在待审（needs_review）。用 xy_tasks_list --state needs_review 看原因。'
  }
  if ((queue.failed ?? 0) > 0) {
    return '有失败要处理：' + String(queue.failed) + ' 条任务 failed。用 xy_task_retry 重放，或 xy_tasks_list 看 lastError。'
  }
  if ((queue.queued ?? 0) > 0) return '现在能开工：' + String(queue.queued) + ' 条任务排队中，worker 会自己取。'
  // 队列空时说「直接发新任务」是撒谎的前提：发布通道没开的话，发出去必然 failed。
  const publish = status.capabilities?.publish
  if (publish === 'off') {
    return '队列是空的，但发布通道没开：现在只读（探详情/擦亮可试），publish 入队会直接 failed。要让发布可用先设 BF_PUBLISH_SUBMIT=1 重启 daemon。'
  }
  if (publish === 'dry-run') {
    return '队列是空的：发布通道只开了 dry-run（只填表、不点提交），publish 入队仍会失败；要真发布设 BF_PUBLISH_SUBMIT=1。'
  }
  return '现在能开工：队列是空的，直接发新任务即可。'
}

/**
 * 错误码 → 「下一步做什么」。
 *
 * 为什么需要：`tool-kit.js` 只渲染 `❌ [CODE] message`，用户看完不知道往哪走；
 * 面板侧（`03-rpc.part.js`）连 code 都拿不到，只剩「操作失败」。
 * 这张表是唯一的说法来源：工具文本、面板提示、文档都从这里取。
 */
export const ERROR_NEXT_STEPS = {
  NETWORK: 'daemon 没起或在重启：在仓库跑 pnpm daemon:start，再用 xy_ping 确认。',
  AUTH_EXPIRED: '登录态过期（_m_h5_tk 约 2h）：重新导入或扫码刷新，再重试。',
  UNAUTHORIZED: 'daemon 不认这个 token：确认 <dataDir>/daemon.token 与插件配置一致（或重跑 pnpm daemon:start 让它重建）。',
  RISK_CONTROL: '闲鱼风控：停手，等至少 30 分钟，别再重试同一件商品。',
  RATE_LIMITED: '撞到限流：等退避窗口过去再发；不要手动连点重试。',
  CIRCUIT_OPEN: '账号被熔断：等内容冷却，或确认无风险后用 xy_circuit_reset 复位（写操作，要人工确认）。',
  STORAGE: '本地数据库读写失败：检查 <dataDir>/bigfish.db 是否被占用/只读，或先 pnpm daemon:stop 再启。',
  UNSUPPORTED: '这条路径 daemon 还没实现（例如 deliver）：别重试，去看 docs/STATUS.md §4.1 的实际能力。',
  VALIDATION: '参数不对：按上面的提示与「细节」改参数再发。',
  NOT_FOUND: '目标不存在（id 写错或已被删）：用 xy_tasks_list / xy_items_list 拿真实 id 再试。',
  METHOD_NOT_ALLOWED: '这是插件内部用法错误（HTTP 方法不对），不是你的操作问题；记下来报 issue。',
  INTERNAL: 'daemon 内部错误：看 daemon 日志尾部（pnpm daemon:logs）再决定是否重试。',
}

/** 取某个错误码的下一步；未知码给一句通用建议，不返回 undefined。 */
export function nextStepFor(code) {
  return ERROR_NEXT_STEPS[code] ?? '未知错误码：先跑 xy_ping 确认 daemon 状态，并把上面的 message 原样贴出来。'
}

/** 把 /status.capabilities 翻成一行「这台 daemon 现在能写什么」。 */
export function formatCapabilities(capabilities) {
  if (capabilities === null || typeof capabilities !== 'object') return undefined
  const publish = capabilities.publish
  const publishText = publish === 'submit'
    ? '真提交'
    : publish === 'dry-run'
      ? '仅 dry-run（只填表，不点提交）'
      : '未开启'
  const parts = [
    'publish=' + publishText,
    'polish=' + (capabilities.polish === true ? '可用' : '未开启'),
    'reply=' + (capabilities.reply === true ? '可用' : '未开启'),
    'deliver=' + (capabilities.deliver === true ? '可用' : '未实现'),
  ]
  const hint = publish === 'submit'
    ? ''
    : '——入队 publish 会失败：先设 BF_PUBLISH_SUBMIT=1 重启 daemon（校准用 BF_PUBLISH_DRYRUN=1）；deliver/reply 同理要先开对应开关。'
  return '能力：' + parts.join(' / ') + hint
}

/** 人类可读的状态摘要。 */
export function formatStatus(status) {
  const queue = status.queue ?? {}
  const queueLine = TASK_STATE_ORDER.map(state => `${state}=${queue[state] ?? 0}`).join(' ')
  const circuits = status.circuits ?? {}
  const circuitEntries = Object.entries(circuits)
  const total = TASK_STATE_ORDER.reduce((sum, state) => sum + (typeof queue[state] === 'number' ? queue[state] : 0), 0)
  const lines = [
    statusVerdict(status),
    `daemon v${status.version} pid=${status.pid} 已运行 ${Math.round((status.uptimeMs ?? 0) / 1000)}s`,
    `队列：共 ${total} 条（${queueLine}）`,
    `账号：${(status.accounts ?? []).length === 0 ? '（未接入）' : (status.accounts ?? []).join(', ')}`,
    `熔断：${circuitEntries.length === 0 ? '无' : circuitEntries.map(([id, reason]) => `${id}(${reason})`).join(', ')}`,
  ]
  // 能力行：入队接口对所有 kind 都回 201，不先说清楚「现在能写什么」，
  // 模型就会把一条必然 failed 的任务排进去，再花一轮对话去读失败原因。
  const capabilities = formatCapabilities(status.capabilities)
  if (capabilities !== undefined) lines.push(capabilities)
  // worker 计数是「任务到底有没有人执行」的唯一证据，有就一定要显示。
  const worker = status.worker
  if (worker !== undefined && worker !== null) {
    const parts = [`领到 ${worker.leased}`, `完成 ${worker.done}`, `失败 ${worker.failed}`, `内部错误 ${worker.errors}`]
    if (typeof worker.lastError === 'string' && worker.lastError !== '') parts.push(`最近错误 ${worker.lastError.slice(0, 120)}`)
    lines.push(`worker：${parts.join(' / ')}`)
  }
  return lines.join('\n')
}

/** 窄化 daemon 的账号导入结果；结构不对直接报 INTERNAL，不猜字段。 */
export function readImportedAccount(value) {
  if (value === null || typeof value !== 'object') {
    throw new DaemonError('INTERNAL', 'daemon 返回的账号导入结果不是对象')
  }
  const record = value
  if (typeof record.accountId !== 'string' || record.accountId === '') {
    throw new DaemonError('INTERNAL', 'daemon 返回的账号导入结果缺少 accountId')
  }
  if (typeof record.savedFieldCount !== 'number') {
    throw new DaemonError('INTERNAL', 'daemon 返回的账号导入结果缺少 savedFieldCount')
  }
  return {
    accountId: record.accountId,
    savedFieldCount: record.savedFieldCount,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
    source: typeof record.source === 'string' ? record.source : 'unknown',
  }
}

/** 宽化 daemon 的账号摘要；单条结构不对就跳过（列表里一条坏数据不该让整块不可用）。 */
export function readAccountSummary(value) {
  if (value === null || typeof value !== 'object') return undefined
  const record = value
  if (typeof record.accountId !== 'string' || record.accountId === '') return undefined
  return {
    accountId: record.accountId,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    savedFieldCount: typeof record.savedFieldCount === 'number' ? record.savedFieldCount : 0,
    ready: record.ready === true,
    ageMs: typeof record.ageMs === 'number' ? record.ageMs : 0,
    broken: record.broken === true,
    ...(typeof record.brokenReason === 'string' ? { brokenReason: record.brokenReason } : {}),
    ...(typeof record.unb === 'string' ? { unb: record.unb } : {}),
  }
}

/** 毫秒 → 人类可读的「多久以前」；只看量级，不追求精确。 */
function formatAge(ageMs) {
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  return Math.floor(hours / 24) + ' 天前'
}

/** 人类可读的账号一行摘要。 */
export function formatAccountLine(account) {
  if (account.broken) return account.accountId + ' | ❌ 凭据损坏：' + (account.brokenReason ?? '无法读取')
  const head = account.accountId + ' | ' + (account.ready ? '✅ 可写' : '⚠️ 不可写（缺 unb 或 _m_h5_tk）')
  const detail = [account.savedFieldCount + ' 字段', '更新于 ' + formatAge(account.ageMs)]
  if (account.unb !== undefined) detail.push('unb=' + account.unb)
  return head + ' | ' + detail.join(' | ')
}

/** epoch ms → 本地 'YYYY-MM-DD HH:mm:ss'；非法值原样显示，不为展示抛错。 */
export function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return String(ms)
  const date = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
