/**
 * 面向模型的工具定义。
 *
 * 这里不 import @deepseek-ai/dsh-tools，也不用它的 defineTool：DSH 的
 * `ctx.tools.register()` 直接接受原始 JSON Schema 的 ToolDefinition（第一方工具用
 * defineTool 只是为了类型推导）。插件零依赖、零构建，才能被任意宿主版本加载。
 *
 * 统一输出形状：canonical value 一律是 { text }，render 把它变成一段 text block。
 * 结构化数据以紧凑 JSON 内嵌在 text 里——P0 阶段这样最稳，不会踩输出 schema 的坑。
 *
 * @module @bigfish/plugin-ops/tools
 */
import { runBatch } from './batch.js'
import { DaemonError } from './client.js'
import { CONDITIONS, COPY_STYLE_IDS, planCopy } from './copy.js'
import { loadPublishDraft } from './draft.js'
import { dryRunLines, enqueuePublish, formatDraftSummary, healthNote } from './publish-flow.js'

/** 所有工具共用的输出 schema：一个文本块。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
}

/** 任务种类，与 @bigfish/core 的 TaskKind 一致。 */
const TASK_KINDS = ['publish', 'deliver', 'polish', 'reply', 'probe']
/** 任务状态，与 @bigfish/core 的 TaskState 一致。 */
const TASK_STATES = ['queued', 'leased', 'done', 'failed', 'needs_review']

/** 空参数 schema（无参数工具用）。 */
const NO_PARAMS = { type: 'object', properties: {}, additionalProperties: false }

/**
 * 把一个"返回字符串"的处理函数包成 ToolDefinition。
 *
 * @param {object} spec - name/description/parameters/handler。
 * @returns {object} 原始 ToolDefinition。
 */
function textTool(spec) {
  const { name, description, parameters, handler } = spec
  return {
    name,
    description,
    parameters,
    // 默认 25s 覆盖单条 daemon 调用（15s 超时 + 余量）；批量工具在 spec 里显式放宽。
    timeoutMs: spec.timeoutMs ?? 25_000,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      try {
        return { text: await handler(args ?? {}) }
      } catch (error) {
        if (error instanceof DaemonError) {
          return {
            text: `❌ [${error.code}] ${error.message}${error.retryable ? '（可稍后重试）' : ''}`,
          }
        }
        throw error
      }
    },
  }
}

/** cents → 「¥129.90」；非整数分原样显示，不为展示抛错。 */
function formatMoney(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return String(cents)
  return '¥' + (cents / 100).toFixed(2)
}

/**
 * 窄化 daemon 的参考报告；结构不对直接 INTERNAL（宁可不显示，也不展示半真半假的统计）。
 * 只读口径：报告里本来就没有图片直链，这里也不补。
 */
function readReferenceReport(value) {
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
function formatReferenceReport(report) {
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
function formatTaskLine(task) {
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
  const queueLine = TASK_STATES.map(state => `${state}=${queue[state] ?? 0}`).join(' ')
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
function readImportedAccount(value) {
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
function readAccountSummary(value) {
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
function formatAccountLine(account) {
  if (account.broken) return account.accountId + ' | ❌ 凭据损坏：' + (account.brokenReason ?? '无法读取')
  const head = account.accountId + ' | ' + (account.ready ? '✅ 可写' : '⚠️ 不可写（缺 unb 或 _m_h5_tk）')
  const detail = [account.savedFieldCount + ' 字段', '更新于 ' + formatAge(account.ageMs)]
  if (account.unb !== undefined) detail.push('unb=' + account.unb)
  return head + ' | ' + detail.join(' | ')
}

/** epoch ms → 本地 'YYYY-MM-DD HH:mm:ss'；非法值原样显示，不为展示抛错。 */
function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return String(ms)
  const date = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 构造全部工具定义。
 *
 * @param {{client: object, config: {daemonUrl: string, tokenPath: string}, version?: string, owner?: string, readDraftFile?: Function}} deps - 依赖注入，便于测试。
 *   readDraftFile 只在测试里注入假读取器，线上走 node:fs/promises.readFile。
 * @returns {object[]} 原始 ToolDefinition 数组。
 */
export function buildTools(deps) {
  const { client, config } = deps
  const version = deps.version ?? '0.0.0'

  return [
    textTool({
      name: 'xy_ping',
      description: '检查 BigFish 插件与本地 daemon 的连通性：插件版本、daemon 地址、token 路径、健康端点是否可达。排障第一步。',
      parameters: NO_PARAMS,
      async handler() {
        const lines = [
          `插件 @bigfish/plugin-ops v${version}`,
          `daemon: ${config.daemonUrl}`,
          `token: ${config.tokenPath}`,
        ]
        try {
          const health = await client.health()
          lines.push(`health: OK v${health.version} pid=${health.pid} uptime=${Math.round((health.uptimeMs ?? 0) / 1000)}s`)
          const status = await client.status()
          lines.push(`auth: OK，队列 ${JSON.stringify(status.queue ?? {})}`)
        } catch (error) {
          if (!(error instanceof DaemonError)) throw error
          lines.push(`health/auth: ❌ [${error.code}] ${error.message}`)
        }
        return lines.join('\n')
      },
    }),
    textTool({
      name: 'xy_daemon_health',
      description: '只查 daemon 的健康端点（不需要 token）：版本、进程号、运行时长。',
      parameters: NO_PARAMS,
      async handler() {
        const health = await client.health()
        return `daemon OK：v${health.version} pid=${health.pid} uptime=${Math.round((health.uptimeMs ?? 0) / 1000)}s`
      },
    }),
    textTool({
      name: 'xy_status',
      description: '读取 daemon 运行状态：队列各状态计数、已接入账号、熔断账号。回答"现在系统在干嘛/卡在哪"。',
      parameters: NO_PARAMS,
      async handler() {
        return formatStatus(await client.status())
      },
    }),
    textTool({
      name: 'xy_accounts_list',
      description: '列出 daemon 凭据库里的账号（只读摘要：账号 id、最后更新时间、登录态字段数、是否具备写操作所需的 unb+_m_h5_tk）。不含任何 cookie 明文。用于回答"现在有几个号、哪个号登录态过期了"。',
      parameters: NO_PARAMS,
      async handler() {
        const raw = await client.listAccounts()
        const accounts = Array.isArray(raw) ? raw.map(readAccountSummary).filter(account => account !== undefined) : []
        if (accounts.length === 0) {
          return [
            '凭据库里还没有可用账号。',
            '导入：xy_import_account（从带 --remote-debugging-port 的 Chrome 读登录态，需人工确认）',
            '扫码：在仓库里跑 npm run daemon:login（打开登录页等扫码）',
          ].join('\n')
        }
        const lines = ['共 ' + accounts.length + ' 个账号：', ...accounts.map(formatAccountLine)]
        if (accounts.some(account => !account.ready && !account.broken)) {
          lines.push('⚠️ 有账号登录态不完整：_m_h5_tk 约 2h 过期，过期后写操作会 AUTH_EXPIRED；重新导入或扫码即可刷新。')
        }
        return lines.join('\n')
      },
    }),
    textTool({
      name: 'xy_tasks_list',
      description: '列出本地任务队列里的任务（可按状态/种类过滤）。用于查看发布/发货任务是否入队、失败、待在审。',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: TASK_STATES, description: '只看某个状态。' },
          kind: { type: 'string', enum: TASK_KINDS, description: '只看某个种类。' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条，默认 20。' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const tasks = await client.listTasks({ state: args.state, kind: args.kind, limit: args.limit ?? 20 })
        if (!Array.isArray(tasks) || tasks.length === 0) return '队列里没有符合条件的任务。'
        return `共 ${tasks.length} 条：\n` + tasks.map(formatTaskLine).join('\n')
      },
    }),
    textTool({
      name: 'xy_task_enqueue',
      description: '把一次运营动作排进本地队列（publish=发布、deliver=发货、polish=擦亮、reply=回复、probe=探针）。同一 dedupeKey 只会入队一次，可用于防重复发布。入队不等于已执行：真正的写闲鱼动作由 daemon 串行执行。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: TASK_KINDS, description: '任务种类。' },
          dedupeKey: { type: 'string', minLength: 1, maxLength: 200, description: '幂等键，例如 publish:<draftId> 或 deliver:<orderId>。' },
          payload: { type: 'object', additionalProperties: true, description: '执行器需要的载荷（草稿 id、订单号等）。' },
          availableAt: { type: 'integer', description: '最早执行时间（epoch ms），用于预约延后执行。' },
          maxAttempts: { type: 'integer', minimum: 1, maximum: 10, description: '最多尝试几次，默认 3。' },
        },
        required: ['kind', 'dedupeKey'],
        additionalProperties: false,
      },
      async handler(args) {
        const task = await client.enqueue({
          kind: args.kind,
          dedupeKey: args.dedupeKey,
          payload: args.payload ?? {},
          ...(args.availableAt === undefined ? {} : { availableAt: args.availableAt }),
          ...(args.maxAttempts === undefined ? {} : { maxAttempts: args.maxAttempts }),
        })
        return `已入队：${formatTaskLine(task)}`
      },
    }),
    textTool({
      name: 'xy_task_action',
      description: '人工处理一条任务：ack=标记完成、fail=记录失败（会按退避重试或转为待审）、release=立刻放回队列。用于任务卡死或人工确认后收尾。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, description: '任务 id（可用 xy_tasks_list 查）。' },
          action: { type: 'string', enum: ['ack', 'fail', 'release'], description: '要执行的动作。' },
          owner: { type: 'string', description: '租约持有者名，默认取本机主机名。' },
          error: { type: 'string', description: 'fail 时记录的错误信息。' },
          nonRetryable: { type: 'boolean', description: 'fail 时标记为不可重试（直接 failed，而不是重试/待审）。' },
        },
        required: ['id', 'action'],
        additionalProperties: false,
      },
      async handler(args) {
        const owner = args.owner ?? deps.owner ?? 'bigfish-plugin'
        const body = {
          owner,
          ...(args.error === undefined ? {} : { error: args.error }),
          ...(args.nonRetryable === undefined ? {} : { nonRetryable: args.nonRetryable }),
        }
        try {
          const task = await client.taskAction(args.id, args.action, body)
          return `${args.action} 完成：${formatTaskLine(task)}`
        } catch (error) {
          if (!(error instanceof DaemonError) || error.code !== 'VALIDATION') throw error
          // ack/fail/release 都要求任务处于 leased 且 owner 匹配；插件 owner 常与 daemon worker 不同，
          // 人工收尾 failed / needs_review 任务必然撞 VALIDATION。补一句可执行提示，免得用户原地打转。
          throw new DaemonError(
            'VALIDATION',
            `${error.message}。ack/fail/release 只对 leased（worker 正在处理且 owner 匹配）的任务生效；若任务已 failed / needs_review，请用 xy_task_retry 重新排队。`,
            { retryable: error.retryable },
          )
        }
      },
    }),
    textTool({
      name: 'xy_task_retry',
      description:
        '人工重新排队一条 failed / needs_review 的发布任务：attempts 归零（重获完整重试预算）、清空 lastError 与旧租约、保留 dedupeKey 与 payload。写操作，执行前会要人工确认；daemon 以 BF_PUBLISH_SUBMIT=1 启动时，下一轮会真的重放这次发布。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', minLength: 1, description: '任务 id（可用 xy_tasks_list 过滤 state=failed / needs_review 查）。' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
      async handler(args) {
        // client 没暴露 retry：request 是它的公共出口，为一条路由再扩一份 API 不值当（client.js 也不在本任务写盘范围）。
        const task = await client.request(`/tasks/${encodeURIComponent(args.taskId)}/retry`, { method: 'POST', body: {} })
        return `已重新排队：${formatTaskLine(task)}`
      },
    }),
    textTool({
      name: 'xy_items_list',
      description: '列出本地已知的商品（P0 阶段为空表；P1 由抓取/发布结果落库）。',
      parameters: NO_PARAMS,
      async handler() {
        const items = await client.listItems()
        if (!Array.isArray(items) || items.length === 0) return '本地还没有商品记录（P1 接入抓取与发布后填充）。'
        return items
          .map(item => `${item.itemId} | ${item.accountId} | ${item.state} | ¥${(item.priceCents / 100).toFixed(2)} | ${item.title}`)
          .join('\n')
      },
    }),
    textTool({
      name: 'xy_import_account',
      description: '从本机已登录闲鱼的真 Chrome（需带 --remote-debugging-port 启动）读取登录态 cookie，加密写入 daemon 凭据库。写操作，执行前会要人工确认。导入后 /status 的账号列表会刷新；插件侧看不到 cookie 明文。',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', minLength: 1, maxLength: 64, description: '账号 id，默认取浏览器里的闲鱼 userId（unb cookie）。' },
          port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Chrome DevTools 端口，默认 9222。' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const input = {}
        if (args.accountId !== undefined) input.accountId = args.accountId
        if (args.port !== undefined) input.port = args.port
        const account = readImportedAccount(await client.importAccount(input))
        return [
          `已导入账号 ${account.accountId}：${account.savedFieldCount} 条登录态字段已加密落盘（source=${account.source}）。`,
          `导入时间：${formatTime(account.updatedAt)}`,
          '下一步：xy_status 确认账号出现在 daemon 的 accounts 里；发布前先用 xy_publish_draft 的 dry-run 校准。',
        ].join('\n')
      },
    }),
    textTool({
      name: 'xy_copy_plan',
      description: '按选定的语言风格，把商品事实组装成「listing 文案生成请求」：产出注入好的提示词（skill + 风格约束 + 事实 + 输出契约 + 待补项）。只读、不调模型、不写文件——拿到提示词后由你按 skills/xianyu-listing-copy 出草稿 JSON，再走 xy_publish_draft。',
      parameters: {
        type: 'object',
        properties: {
          styleId: { type: 'string', enum: COPY_STYLE_IDS, description: '语言风格 id，默认 plain（闲鱼口语）。' },
          productName: { type: 'string', minLength: 1, maxLength: 120, description: '原始商品名（可含商家话术），只允许基于它和下面的字段改写。' },
          condition: { type: 'string', enum: CONDITIONS, description: '成色，必填；不允许猜。' },
          priceYuan: { type: 'string', description: '售价（元），最多两位小数，如 "129.90"；与 priceCents 二选一。' },
          priceCents: { type: 'integer', minimum: 100, description: '售价（整数分）；与 priceYuan 二选一，两者都给时以它为准。' },
          shipping: { type: 'string', enum: ['free', 'none'], description: 'free=包邮（默认），none=不包邮。' },
          categoryHint: { type: 'string', maxLength: 120, description: '类目提示（如「数码/手机」）；不给则由 skill 给候选。' },
          specs: { type: 'object', additionalProperties: { type: 'string' }, description: '型号/尺寸/材质等键值，值一律字符串。' },
          flaws: { type: 'array', maxItems: 10, items: { type: 'string' }, description: '瑕疵清单，每条一个；不给表示未填写。' },
          accessories: { type: 'array', maxItems: 20, items: { type: 'string' }, description: '配件清单。' },
          imagePaths: { type: 'array', maxItems: 9, items: { type: 'string' }, description: '本机图片绝对路径；面板入口通常暂缺，提示词会标为待补。' },
          variantCount: { type: 'integer', minimum: 1, maximum: 3, description: '备选套数，默认 1。' },
          usedAiImages: { type: 'boolean', description: '是否含 AI 生成图；true 时描述第 3 段必须声明。' },
        },
        required: ['productName', 'condition'],
        anyOf: [{ required: ['priceCents'] }, { required: ['priceYuan'] }],
        additionalProperties: false,
      },
      async handler(args) {
        return planCopy(args).text
      },
    }),
    textTool({
      name: 'xy_reference_collect',
      description: '采集「参考分析」只读统计：给定商品 id 或商家 id，读出价格带、标题长度、类目分布、高频卖点词、图片数量与商家量级。只读、不下载图片、不产出可发布草稿（不搬运他人商品）。用于给自己定价/写自己的文案时找参照。',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', minLength: 1, maxLength: 64, description: '用哪个账号的登录态去读（需已在 daemon 凭据库里）。' },
          itemIds: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 }, description: '要分析的闲鱼商品 id 数组；与 sellerId 至少给一个。' },
          sellerId: { type: 'string', minLength: 1, description: '商家数字 id：先取其的主页与在售列表（一页最多 20 件）再逐件统计。' },
        },
        required: ['accountId'],
        anyOf: [{ required: ['itemIds'] }, { required: ['sellerId'] }],
        additionalProperties: false,
      },
      timeoutMs: 100_000,
      async handler(args) {
        const input = { accountId: args.accountId }
        if (args.itemIds !== undefined) input.itemIds = args.itemIds
        if (args.sellerId !== undefined) input.sellerId = args.sellerId
        return formatReferenceReport(readReferenceReport(await client.collectReferences(input)))
      },
    }),
    textTool({
      name: 'xy_publish_draft',
      description: '校验本机发布草稿 JSON 并给出执行路径。默认 dry-run：只输出 daemon 发布命令（只填表、不点提交、不入队）；mode=enqueue 才把 publish 任务排进队列（写操作，需人工确认；daemon 只有以 BF_PUBLISH_SUBMIT=1 启动才会真提交）。',
      parameters: {
        type: 'object',
        properties: {
          draftPath: { type: 'string', minLength: 1, description: '草稿 JSON 路径：title/desc/priceCents/images，可选 pricingMode/shipping/address。' },
          mode: { type: 'string', enum: ['dry-run', 'enqueue'], description: 'dry-run（默认）只输出命令；enqueue 才写 daemon 队列。' },
          accountId: { type: 'string', minLength: 1, description: '期望账号 id；enqueue 必填，dry-run 可选（daemon 会拿它和浏览器账号比对，防发错号）。' },
          chromePort: { type: 'integer', minimum: 1, maximum: 65535, description: 'Chrome DevTools 端口，默认 9222。' },
          screenshotsDir: { type: 'string', minLength: 1, description: '每步截图目录；真机校准强烈建议传。' },
          dedupeKey: { type: 'string', minLength: 1, maxLength: 200, description: '幂等键，默认按草稿内容生成 publish:<hash>。' },
        },
        required: ['draftPath'],
        additionalProperties: false,
      },
      async handler(args) {
        // readDraftFile 只是测试注入点；线上用 node:fs/promises.readFile。
        const draft = await loadPublishDraft(args.draftPath, deps.readDraftFile)
        const summary = formatDraftSummary(args.draftPath, draft)
        if (args.mode === 'enqueue') {
          const lines = await enqueuePublish(args, draft, { client, formatTask: formatTaskLine })
          return [summary, '', ...lines].join('\n')
        }
        return [summary, '', ...dryRunLines(args, draft), '', await healthNote(client)].join('\n')
      },
    }),
    textTool({
      name: 'xy_publish_batch',
      description: '批量发布：一次性校验多条草稿并逐条入队（自动发布的批量入口）。默认 dry-run（与 xy_publish_draft 一致）：只输出逐条计划（幂等键/标题/价格/状态），不碰 daemon 写队列；mode=enqueue 才逐条写 daemon 队列（写操作，需人工确认；daemon 以 BF_PUBLISH_SUBMIT=1 启动才会逐条真提交）。同一批里内容相同的草稿只入队一次；单条非法不拖垮整批。',
      parameters: {
        type: 'object',
        properties: {
          drafts: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: true }, description: '内联草稿对象数组；与 draftPaths 至少给一个，可同时给。' },
          draftPaths: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 }, description: '草稿 JSON 文件路径数组；与 drafts 至少给一个，可同时给。' },
          accountId: { type: 'string', minLength: 1, maxLength: 64, description: '发布账号 id；mode=enqueue 必填，dry-run 可选。' },
          mode: { type: 'string', enum: ['dry-run', 'enqueue'], description: 'dry-run（默认）只出计划；enqueue 才写 daemon 队列。' },
          maxItems: { type: 'integer', minimum: 1, maximum: 20, description: '本批最多处理多少条，默认 20（上限 20）。' },
        },
        anyOf: [{ required: ['drafts'] }, { required: ['draftPaths'] }],
        additionalProperties: false,
      },
      timeoutMs: 60_000,
      async handler(args) {
        return runBatch(args, { client, readDraftFile: deps.readDraftFile })
      },
    }),
  ]
}
