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

/** 人类可读的任务一行摘要。 */
export function formatTaskLine(task) {
  const parts = [
    `${task.id.slice(0, 8)}…`,
    task.kind,
    task.state,
    `attempt ${task.attempts}/${task.maxAttempts}`,
  ]
  if (task.dedupeKey) parts.push(`key=${task.dedupeKey}`)
  if (task.lastError) parts.push(`last=${String(task.lastError).slice(0, 80)}`)
  return parts.join(' | ')
}

/** 人类可读的状态摘要。 */
export function formatStatus(status) {
  const queue = status.queue ?? {}
  const queueLine = TASK_STATE_ORDER.map(state => `${state}=${queue[state] ?? 0}`).join(' ')
  const circuits = status.circuits ?? {}
  const circuitEntries = Object.entries(circuits)
  const lines = [
    `daemon v${status.version} pid=${status.pid} 已运行 ${Math.round((status.uptimeMs ?? 0) / 1000)}s`,
    `队列：${queueLine}`,
    `账号：${(status.accounts ?? []).length === 0 ? '（未接入）' : (status.accounts ?? []).join(', ')}`,
    `熔断：${circuitEntries.length === 0 ? '无' : circuitEntries.map(([id, reason]) => `${id}(${reason})`).join(', ')}`,
  ]
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
