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
 * 每条工具同时声明访问级别（access）与审批理由（reason/writeWhen），这是门禁的
 * 唯一事实源；注册与 tools/pre-execute 监听都由 ./tool-middleware.js 统一处理。
 *
 * @module @bigfish/plugin-ops/tools
 */
import { DaemonError } from './client.js'
import { CONDITIONS, COPY_STYLE_IDS, planCopy } from './copy.js'
import {
  formatAccountLine,
  formatCapabilities,
  formatMarketBrief,
  formatReferenceReport,
  formatStatus,
  formatTaskLine,
  formatTaskListNextSteps,
  formatTime,
  readAccountSummary,
  readImportedAccount,
  readMarketBrief,
  readReferenceReport,
  nextStepFor,
  toCopyMarketHints,
} from './tool-format.js'
import { NO_PARAMS, TASK_KINDS, TASK_STATES, taskEnqueueIsWrite, textTool, requireString, requireEnum, readLimit, requireAnyOf } from './tool-kit.js'
import { publishToolSpecs } from './tool-specs-publish.js'

/**
 * 文案请求可选挂一份「市场简报」：给了类目或商家就去 daemon 聚合一次（只读）。
 *
 * 为什么失败直接抛、不降级成「没有参考也行」：简报是这条链路定价与结构的依据，
 * 悄悄跳过会让用户拿一份凭空写出来的价格去发布。
 */
async function readCopyMarket(client, args) {
  /** @type {Record<string, unknown>} */
  const query = {}
  if (args.marketCategoryId !== undefined) query.categoryId = args.marketCategoryId
  if (args.marketSellerId !== undefined) query.sellerId = args.marketSellerId
  if (query.categoryId === undefined && query.sellerId === undefined) return undefined
  query.condition = args.condition
  return toCopyMarketHints(readMarketBrief(await client.marketBrief(query)))
}

/**
 * 构造全部工具规格（定义 + 访问级别 + 审批理由），交给 tool-middleware 统一注册与挂门禁。
 *
 * @param {{client: object, config: {daemonUrl: string, tokenPath: string}, version?: string, owner?: string, readDraftFile?: Function}} deps - 依赖注入，便于测试。
 *   readDraftFile 只在测试里注入假读取器，线上走 node:fs/promises.readFile。
 * @returns {Array<{definition: object, access: 'read'|'confirm', reason?: string, writeWhen?: Function}>} 工具规格数组。
 */
export function buildTools(deps) {
  const { client, config } = deps
  const version = deps.version ?? '0.0.0'

  return [
    textTool({
      name: 'xy_ping',
      access: 'read',
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
          const capabilities = formatCapabilities(status.capabilities)
          if (capabilities !== undefined) lines.push(capabilities)
        } catch (error) {
          if (!(error instanceof DaemonError)) throw error
          lines.push(`health/auth: ❌ [${error.code}] ${error.message}`)
          // 与其它工具共用同一张「下一步」表：ping 是排障第一步，它自己更应该指路。
          lines.push('→ ' + nextStepFor(error.code))
        }
        return lines.join('\n')
      },
    }),
    textTool({
      name: 'xy_daemon_health',
      access: 'read',
      description: '只查 daemon 的健康端点（不需要 token）：版本、进程号、运行时长。',
      parameters: NO_PARAMS,
      async handler() {
        const health = await client.health()
        return `daemon OK：v${health.version} pid=${health.pid} uptime=${Math.round((health.uptimeMs ?? 0) / 1000)}s`
      },
    }),
    textTool({
      name: 'xy_status',
      access: 'read',
      description: '读取 daemon 运行状态：队列各状态计数、已接入账号、熔断账号。回答"现在系统在干嘛/卡在哪"。',
      parameters: NO_PARAMS,
      async handler() {
        return formatStatus(await client.status())
      },
    }),
    textTool({
      name: 'xy_accounts_list',
      access: 'read',
      description: '列出 daemon 凭据库里的账号（只读摘要：账号 id、最后更新时间、登录态字段数、是否具备写操作所需的 unb+_m_h5_tk）。不含任何 cookie 明文。用于回答"现在有几个号、哪个号登录态过期了"。',
      parameters: NO_PARAMS,
      async handler() {
        const raw = await client.listAccounts()
        const accounts = Array.isArray(raw) ? raw.map(readAccountSummary).filter(account => account !== undefined) : []
        if (accounts.length === 0) {
          return [
            '凭据库里还没有可用账号。',
            '导入：xy_import_account（从带 --remote-debugging-port 的 Chrome 读登录态，需人工确认）',
            '扫码：在仓库里跑 pnpm daemon:login（打开登录页等扫码）',
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
      access: 'read',
      description: '列出本地任务队列里的任务（可按状态/种类过滤）。用于查看发布/发货任务是否入队、失败、待在审。',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: TASK_STATES, description: '只看某个状态。' },
          kind: { type: 'string', enum: TASK_KINDS, description: '只看某个种类。' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条，默认 10；要翻页再显式调大。' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const limit = readLimit(args, 10, 200)
        const tasks = await client.listTasks({ state: args.state, kind: args.kind, limit })
        // 「共 N 条」曾经等于本轮取回条数，用户会误以为队列就这么长；总数只能问 /status。
        let counts = ''
        try {
          const status = await client.status()
          const queue = status?.queue ?? {}
          const parts = TASK_STATES.map(state => `${state}=${queue[state] ?? 0}`)
          counts = `队列各状态：${parts.join(' ')}\n`
        } catch {
          // 数不上就不数：列表本身仍然有用，不让一次额外调用拖垮整个工具。
        }
        if (!Array.isArray(tasks) || tasks.length === 0) {
          return counts + '队列里没有符合条件的任务。'
        }
        const truncated = tasks.length >= limit ? `\n（只列前 ${limit} 条，可能还有更多；用 state 过滤或调大 limit）` : ''
        // 导航话术从「每条都带」收成「末尾一行」，省掉重复文本（审计 §四.2）。
        const lines = tasks.map(formatTaskLine)
        return `${counts}取回 ${tasks.length} 条：\n` + lines.join('\n') + truncated + formatTaskListNextSteps(tasks)
      },
    }),
    textTool({
      name: 'xy_task_enqueue',
      access: 'confirm',
      reason: '会入队写类任务（真机写闲鱼），需要人工确认。',
      // 只读探针与 IM 回复不触碰商品数据，先不拦；publish/deliver/polish 要确认。
      writeWhen: taskEnqueueIsWrite,
      description: '把一次运营动作排进本地队列（publish=发布、deliver=发货、polish=擦亮、reply=回复、probe=探针）。同一 dedupeKey 只会入队一次；入队不等于已执行，daemon 串行执行。发商品用 xy_publish_draft / xy_publish_batch，本工具管其它动作。\n\npayload 必填字段（缺了当场 400，不会入队）：publish=accountId/title/desc/priceCents(分)/images；deliver=accountId/orderId/content；polish=accountId/itemId；probe=accountId/itemId；reply=accountId/cid/text。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: TASK_KINDS, description: '任务种类。' },
          dedupeKey: { type: 'string', minLength: 1, maxLength: 200, description: '幂等键，例如 publish:<draftId> 或 deliver:<orderId>。' },
          payload: { type: 'object', additionalProperties: true, description: '执行器需要的载荷。必填字段随 kind 变：publish 要 accountId/title/desc/priceCents/images，deliver 要 accountId/orderId/content，polish 与 probe 要 accountId/itemId，reply 要 accountId/cid/text。缺字段当场 400，不会入队。' },
          availableAt: { type: 'integer', description: '最早执行时间（epoch ms），用于预约延后执行。' },
          maxAttempts: { type: 'integer', minimum: 1, maximum: 10, description: '最多尝试几次，默认 3。' },
        },
        required: ['kind', 'dedupeKey'],
        additionalProperties: false,
      },
      async handler(args) {
        const kind = requireEnum(args, 'kind', TASK_KINDS)
        const dedupeKey = requireString(args, ['dedupeKey'], 'dedupeKey')
        const task = await client.enqueue({
          kind,
          dedupeKey,
          payload: args.payload ?? {},
          ...(args.availableAt === undefined ? {} : { availableAt: args.availableAt }),
          ...(args.maxAttempts === undefined ? {} : { maxAttempts: args.maxAttempts }),
        })
        // 回执要说清「这次是真新建，还是撞了幂等键」——后者如果被误解成「又发了一件」，
        // 就会重复发布。daemon 的 201 响应里带 created 布尔（routes-tasks.ts）。
        const created = task?.created
        const head = created === false
          ? 'ℹ️ 幂等命中：同样的 dedupeKey 之前已入队，这次没有新建（不会重复发布）。'
          : '已入队：'
        const lines = [head + formatTaskLine(task)]
        if (task?.batchId !== undefined) lines.push(`批次：${task.batchId}（用 GET /batches/:id 或面板「发布」看进度）`)
        if (typeof task?.availableAt === 'number' && task.availableAt > Date.now()) {
          lines.push(`预约执行：${formatTime(task.availableAt)}（到点前不会动）`)
        }
        lines.push('进度：xy_tasks_list。')
        return lines.join('\n')
      },
    }),
    textTool({
      name: 'xy_task_action',
      access: 'read',
      // ack/fail/release 只流转本地队列（2026-10-21 裁决），不触达闲鱼，不挂门禁。
      description: '人工处理一条任务：ack=标记完成、fail=记录失败（会按退避重试或转为待审）、release=立刻放回队列。用于任务卡死或人工确认后收尾。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, description: '任务 id（可用 xy_tasks_list 查）。' },
          action: { type: 'string', enum: ['ack', 'fail', 'release'], description: '要执行的动作。' },
          owner: { type: 'string', description: '租约持有者名；不给则自动读任务的 leaseOwner（通常是 daemon-<pid>，只有确实要冒充别的持有者时才手动指定）。' },
          error: { type: 'string', description: 'fail 时记录的错误信息。' },
          nonRetryable: { type: 'boolean', description: 'fail 时标记为不可重试（直接 failed，而不是重试/待审）。' },
        },
        required: ['id', 'action'],
        additionalProperties: false,
      },
      async handler(args) {
        // 必填边界先挡：缺 id/action 曾经把 undefined 拼进 URL，回一句「undefined 完成」的静默空结果。
        const id = requireString(args, ['id'], 'id')
        const action = requireEnum(args, 'action', ['ack', 'fail', 'release'])
        // owner 必须取「真的持有租约的那个人」，否则 ack/fail/release 永远撞 VALIDATION。
        //
        // 为什么不能写死一个名字：daemon worker 的 owner 是 `daemon-<pid>`（runtime.ts），
        // 重启一次 pid 就变；插件侧猜不到，历史上默认值 'bigfish-plugin' 因此从未匹配成功，
        // 「任务卡在 leased」这个场景事实上无解。这里先读一次任务拿真实 leaseOwner，
        // 读不到（或不是 leased）才退回调用方给的 owner。
        let owner = args.owner
        if (owner === undefined) {
          // getTask 不是所有嵌入方都会提供（测试替身/老客户端），缺了就退回显式 owner。
          const readTask = typeof client.getTask === 'function' ? client.getTask.bind(client) : undefined
          const current = readTask === undefined ? undefined : await readTask(id).catch(() => undefined)
          owner = typeof current?.leaseOwner === 'string' && current.leaseOwner !== ''
            ? current.leaseOwner
            : deps.owner ?? 'bigfish-plugin'
        }
        const body = {
          owner,
          ...(args.error === undefined ? {} : { error: args.error }),
          ...(args.nonRetryable === undefined ? {} : { nonRetryable: args.nonRetryable }),
        }
        try {
          const task = await client.taskAction(id, action, body)
          return `${action} 完成（owner=${owner}）：${formatTaskLine(task)}`
        } catch (error) {
          if (!(error instanceof DaemonError)) throw error
          if (error.code === 'NOT_FOUND') {
            throw new DaemonError('NOT_FOUND', `${error.message}。先用 xy_tasks_list 拿到真实 id（不要凭记忆拼）`, {
              details: error.details,
            })
          }
          if (error.code !== 'VALIDATION') throw error
          // ack/fail/release 只对 leased 任务生效。把 details 里的现场翻成人话，
          // 让人知道是「已经跑完/已停下」还是「被别的实例拿着」。
          const details = error.details ?? {}
          const state = typeof details.state === 'string' ? details.state : ''
          const actualOwner = typeof details.actualOwner === 'string' ? details.actualOwner : ''
          const remaining = typeof details.leaseRemainingMs === 'number' ? Math.ceil(details.leaseRemainingMs / 1000) : undefined
          const hint = state === 'leased' && actualOwner !== ''
            ? `任务正被 ${actualOwner} 持有${remaining === undefined ? '' : `（租约还剩约 ${remaining}s）`}；等它跑完或用 xy_task_action release 放回队列。`
            : `任务 state=${state || '未知'}，不在租约里：ack/fail/release 只对 leased 生效；failed/needs_review 用 xy_task_retry 重排，queued 会自己执行。`
          throw new DaemonError('VALIDATION', `${error.message}。${hint}`, { details: error.details })
        }
      },
    }),
    textTool({
      name: 'xy_task_retry',
      access: 'confirm',
      reason: '会把失败/待审任务重新排队并清零 attempts（daemon 以 BF_PUBLISH_SUBMIT=1 启动时会重放这次发布），需要人工确认。',
      description:
        '人工重新排队一条 failed / needs_review 的发布任务：attempts 归零（重获完整重试预算）、清空 lastError 与旧租约、保留 dedupeKey 与 payload。写操作，执行前会要人工确认；daemon 以 BF_PUBLISH_SUBMIT=1 启动时，下一轮会真的重放这次发布。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', minLength: 1, description: '任务 id（可用 xy_tasks_list 过滤 state=failed / needs_review 查）。' },
          id: { type: 'string', minLength: 1, description: '任务 id，taskId 的兼容别名；两者都给时以 taskId 为准。' },
        },
        anyOf: [{ required: ['taskId'] }, { required: ['id'] }],
        additionalProperties: false,
      },
      async handler(args) {
        // 参数名归一：历史上三个工具各叫 taskId / id / dedupeKey，传错名字不报错，
        // undefined 被拼进 URL、daemon 回空对象，formatTaskLine 再拼成「已重新排队： |  | 」
        // 的静默空结果（审计 §1.3）。这里同时接受 taskId 与 id，缺一即 VALIDATION。
        const taskId = requireString(args, ['taskId', 'id'], 'taskId（或 id）')
        // client 没暴露 retry：request 是它的公共出口，为一条路由再扩一份 API 不值当。
        const task = await client.request(`/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST', body: {} })
        return `已重新排队：${formatTaskLine(task)}`
      },
    }),
    textTool({
      name: 'xy_circuit_reset',
      access: 'confirm',
      reason: '会把账号从熔断表里摘掉，下一次写操作会立刻真的打到闲鱼；熔断本来就是防连击的刹车，解除必须人工确认。',
      description: '手动复位某个账号的熔断状态（只在本地状态表里摘掉记录，不触达闲鱼）。熔断由发布侧风控命中或连续失败触发，默认 600 秒冷却；确实确认过没问题（例如上次是误判）再用本工具提前解除。用 xy_status 看哪些账号在熔断。',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', minLength: 1, maxLength: 64, description: '要复位的账号 id（xy_accounts_list / xy_status 里能看到）。' },
        },
        required: ['accountId'],
        additionalProperties: false,
      },
      async handler(args) {
        const accountId = requireString(args, ['accountId'], 'accountId')
        const result = await client.resetCircuit(accountId)
        if (result?.reset === false) {
          return [
            `账号 ${accountId} 其实不在熔断表里（daemon 没有加载熔断器）。`,
            '→ 如果 xy_status 里仍显示熔断，先跑 xy_ping 确认连的是哪个 daemon。',
          ].join('\n')
        }
        return [
          `已复位账号 ${accountId} 的熔断。`,
          '下一步：xy_status 确认 circuits 为空；再发写类任务前，先想清楚上次为什么被熔断（风控命中通常要等 30 分钟以上）。',
        ].join('\n')
      },
    }),
    textTool({
      name: 'xy_items_list',
      access: 'read',
      description: '列出本地已知的商品（发布结果与探测结果落库）。可按账号/状态过滤——多账号时务必带上 accountId，否则会把别的号的商品混进来，后续擦亮/探测会带错账号。',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', minLength: 1, maxLength: 64, description: '只看某个账号的商品；多账号场景建议总是带上。' },
          state: { type: 'string', enum: ['online', 'offline', 'unknown'], description: '只看某个上架状态。' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回多少条，默认 20；要翻页再显式调大。' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const limit = readLimit(args, 20, 500)
        const items = await client.listItems({ accountId: args.accountId, state: args.state, limit })
        if (!Array.isArray(items) || items.length === 0) {
          const filter = args.accountId === undefined ? '' : `账号 ${args.accountId} 下`
          // 空库指路压成一行：商品来源两条路用一句话说完（审计 §四.5）。
          return `本地还没有${filter}商品记录（来自 xy_publish_draft/xy_publish_batch 入队落库，或 xy_task_enqueue(kind="probe") 探测）。`
        }
        return items
          .map(item => `${item.itemId} | ${item.accountId} | ${item.state} | ¥${(item.priceCents / 100).toFixed(2)} | ${item.title}`)
          .join('\n')
      },
    }),
    textTool({
      name: 'xy_import_account',
      access: 'confirm',
      reason: '会从本机 Chrome 读取闲鱼登录态 cookie 并加密落盘（写凭据），需要人工确认。',
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
          '下一步：xy_status 确认账号已接入；发布前先跑 xy_publish_draft 的 dry-run 校准。',
        ].join('\n')
      },
    }),
    textTool({
      name: 'xy_copy_plan',
      access: 'read',
      description: '按选定的语言风格，把商品事实组装成「listing 文案生成请求」：产出注入好的提示词（skill + 风格约束 + 事实 + 输出契约 + 待补项）。只读、不调模型、不写文件；出草稿 JSON 后可交给 xy_publish_draft 的 draft 参数（无需落盘）。',
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
          reason: { type: 'string', maxLength: 200, description: '出售原因（换新/搬家/闲置）；第 2 段的事实来源，不给就不许编故事。' },
          usedMonths: { type: 'integer', minimum: 0, maximum: 600, description: '已使用月数；不给就不写。' },
          imagePaths: { type: 'array', maxItems: 9, items: { type: 'string' }, description: '本机图片绝对路径；面板入口通常暂缺，提示词会标为待补。' },
          variantCount: { type: 'integer', minimum: 1, maximum: 3, description: '备选套数，默认 1。' },
          usedAiImages: { type: 'boolean', description: '是否含 AI 生成图；true 时描述第 3 段必须声明。' },
          marketCategoryId: { type: 'string', minLength: 1, maxLength: 64, description: '可选：把该闲鱼类目的市场简报（价格带/结构/高频词/建议价）写进提示词；与 marketSellerId 二选一。' },
          marketSellerId: { type: 'string', minLength: 1, maxLength: 20, description: '可选：按已采集的某个商家出简报；与 marketCategoryId 二选一。' },
        },
        required: ['productName', 'condition'],
        anyOf: [{ required: ['priceCents'] }, { required: ['priceYuan'] }],
        additionalProperties: false,
      },
      // 带类目/商家时要先读 daemon 的市场简报，因此 handler 是异步的；纯函数逻辑仍在 copy.js。
      async handler(args) {
        const market = await readCopyMarket(client, args)
        return planCopy(market === undefined ? args : { ...args, market }).text
      },
    }),
    textTool({
      name: 'xy_reference_collect',
      access: 'read',
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
      // 工具总超时必须宽于 client 的 HTTP 超时（90s，20 件串行、每件一次 mtop），
      // 否则工具层先被掐断时拿不到 client 的 NETWORK 错误码，只剩一句笼统的「超时」。
      // 120s 给 30s 余量：client 一定先失败并带回可执行的原因。
      timeoutMs: 120_000,
      async handler(args) {
        const accountId = requireString(args, ['accountId'], 'accountId')
        requireAnyOf(args, ['itemIds', 'sellerId'])
        const input = { accountId }
        if (args.itemIds !== undefined) input.itemIds = args.itemIds
        if (args.sellerId !== undefined) input.sellerId = args.sellerId
        return formatReferenceReport(readReferenceReport(await client.collectReferences(input)))
      },
    }),
    textTool({
      name: 'xy_market_brief',
      access: 'read',
      description: '市场简报：把已入库的他人商品快照聚合成价格带（p25/p50/p75）、按成色的建议价、标题/描述结构、主图规格与高频词。只读、不触达闲鱼、不下载图片、不含他人原句。先用 xy_reference_collect 或面板「采集」入库，再取简报；用 xy_copy_plan 可把简报写进文案提示词。',
      parameters: {
        type: 'object',
        properties: {
          categoryId: { type: 'string', minLength: 1, maxLength: 64, description: '只看该闲鱼类目（seller_items.category_id）；不传则看全部已采集商品。' },
          sellerId: { type: 'string', minLength: 1, maxLength: 20, description: '只看该商家的商品；与 categoryId 二选一（两个都给 daemon 会报 VALIDATION）。' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多取多少条样本，默认 200。' },
          condition: { type: 'string', enum: CONDITIONS, description: '你的商品成色；给了才出建议价（同一市场里成色不同价格不同）。' },
        },
        additionalProperties: false,
      },
      timeoutMs: 20_000,
      async handler(args) {
        /** @type {Record<string, unknown>} */
        const input = {}
        if (args.categoryId !== undefined) input.categoryId = args.categoryId
        if (args.sellerId !== undefined) input.sellerId = args.sellerId
        if (args.limit !== undefined) input.limit = args.limit
        if (args.condition !== undefined) input.condition = args.condition
        return formatMarketBrief(readMarketBrief(await client.marketBrief(input)))
      },
    }),
    // 发布类工具（draft / batch）在 tool-specs-publish.js：默认 dry-run，显式 enqueue 才要审批。
    ...publishToolSpecs(deps),
  ]
}
