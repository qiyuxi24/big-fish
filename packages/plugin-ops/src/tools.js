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
import { DaemonError } from './client.js'
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
    timeoutMs: 25_000,
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
        const task = await client.taskAction(args.id, args.action, body)
        return `${args.action} 完成：${formatTaskLine(task)}`
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
  ]
}
