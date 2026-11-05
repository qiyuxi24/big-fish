/**
 * 发布类工具规格（xy_publish_draft / xy_publish_batch）。
 *
 * 为什么单独成文件：发布是当前主线模块，两条规格占 tools.js 近一半篇幅；
 * 拆出来后「加一个发布工具」只改这里，读工具列表时也不用跳过两百行发布参数。
 * 门禁口径不变：默认 dry-run 放行，显式 enqueue 才要人工确认。
 * @module @bigfish/plugin-ops/tool-specs-publish
 */
import { runBatch } from './batch.js'
import { loadPublishDraft, validatePublishDraft } from './draft.js'
import { dryRunLines, enqueuePublish, formatDraftSummary, healthNote, policyLines } from './publish-flow.js'
import { formatTaskLine } from './tool-format.js'
import { nonDryRunIsWrite, textTool } from './tool-kit.js'
import { DaemonError } from './client.js'

/** 内联草稿没有落盘时，CDP 真机校准命令里的 --draft 占位值（配合说明行，别吐一条看似能跑的假命令）。 */
const INLINE_DRAFT_PATH_HINT = '<把内联 draft 存成 .json 后替换此路径>'

/**
 * 取一条单件草稿：draftPath 与 draft 二选一，都给时以 draftPath 为准。
 *
 * 为什么加内联入口：xy_copy_plan 只出提示词，agent 得自己落盘成 JSON 文件再校验，
 * 三段式摩擦太大（审计 §四.3）。内联 draft 直接走与文件完全相同的 validatePublishDraft，
 * 不新增工具、不改 16 个工具的名字/数量。
 *
 * @param {Record<string, unknown>} args - 工具参数。
 * @param {Function | undefined} readDraftFile - 测试注入的文件读取器。
 * @returns {Promise<{draft: object, label: string, inline: boolean}>} 规范化草稿、来源标签与是否内联。
 */
async function resolveSingleDraft(args, readDraftFile) {
  if (typeof args.draftPath === 'string') {
    if (args.draftPath.trim() === '') {
      throw new DaemonError('VALIDATION', 'draftPath 不能是空字符串：给一个草稿 JSON 文件路径，或改用 draft 内联对象')
    }
    return { draft: await loadPublishDraft(args.draftPath, readDraftFile), label: args.draftPath, inline: false }
  }
  if (args.draft !== undefined && args.draft !== null && typeof args.draft === 'object' && !Array.isArray(args.draft)) {
    return { draft: validatePublishDraft(args.draft), label: '(内联 draft)', inline: true }
  }
  if (args.draft !== undefined) {
    throw new DaemonError('VALIDATION', 'draft 必须是草稿对象（title/desc/priceCents/images）')
  }
  throw new DaemonError('VALIDATION', '缺少草稿：给 draftPath（文件路径）或 draft（内联草稿对象）')
}

/**
 * 构造发布类工具规格。
 *
 * @param {{client: object, readDraftFile?: Function}} deps - daemon 客户端与测试用的草稿读取器。
 * @returns {Array<{definition: object, access: 'read'|'confirm', reason?: string, writeWhen?: Function}>} 工具规格。
 */
export function publishToolSpecs(deps) {
  const { client } = deps

  return [
    textTool({
      name: 'xy_publish_draft',
      access: 'confirm',
      reason: '会把发布任务排进 daemon 队列（daemon 以 BF_PUBLISH_SUBMIT=1 启动时会真发布），需要人工确认。',
      // 默认 dry-run：只读草稿文件并打印校准命令，不碰 daemon 写队列，无需审批。
      writeWhen: nonDryRunIsWrite,
      description: '校验发布草稿并给出执行路径。草稿可给 draftPath（文件路径）或 draft（内联对象，无需落盘），都给时以 draftPath 为准。默认 dry-run：只输出 daemon 发布命令（只填表、不点提交、不入队）；mode=enqueue 才把 publish 任务排进队列（写操作，需人工确认；daemon 只有以 BF_PUBLISH_SUBMIT=1 启动才会真提交）。',
      parameters: {
        type: 'object',
        properties: {
          draftPath: { type: 'string', minLength: 1, description: '草稿 JSON 文件路径：title/desc/priceCents/images，可选 pricingMode/shipping/address。与 draft 二选一，优先。' },
          draft: { type: 'object', description: '内联草稿对象（title/desc/priceCents/images 等，字段同 draftPath 的 JSON）；无需落盘，走同一套 validatePublishDraft 校验。' },
          mode: { type: 'string', enum: ['dry-run', 'enqueue'], description: 'dry-run（默认）只输出命令；enqueue 才写 daemon 队列。' },
          accountId: { type: 'string', minLength: 1, description: '期望账号 id；enqueue 必填，dry-run 可选（daemon 会拿它和浏览器账号比对，防发错号）。' },
          chromePort: { type: 'integer', minimum: 1, maximum: 65535, description: 'Chrome DevTools 端口，默认 9222。' },
          screenshotsDir: { type: 'string', minLength: 1, description: '每步截图目录；真机校准强烈建议传。' },
          dedupeKey: { type: 'string', minLength: 1, maxLength: 200, description: '幂等键，默认按草稿内容生成 publish:<hash>。' },
        },
        anyOf: [{ required: ['draftPath'] }, { required: ['draft'] }],
        additionalProperties: false,
      },
      async handler(args) {
        const { draft, label, inline } = await resolveSingleDraft(args, deps.readDraftFile)
        const summary = formatDraftSummary(label, draft)
        // dryRunLines / enqueuePublish 用 args.draftPath 拼 CDP 真机校准命令；内联草稿没落盘，
        // 只能给显式占位值，避免拼出「--draft 」这种看似能跑的假命令（入队发布不依赖该文件）。
        const flowArgs = inline ? { ...args, draftPath: INLINE_DRAFT_PATH_HINT } : args
        const lines = args.mode === 'enqueue'
          ? await enqueuePublish(flowArgs, draft, { client, formatTask: formatTaskLine })
          : [...dryRunLines(flowArgs, draft), '', ...(await policyLines(client, draft)), '', await healthNote(client)]
        if (inline) {
          lines.push('', '注意：内联草稿没有落盘，上面校准命令里的 --draft 是占位值；真机校准前请把这份 draft 存成 .json 文件并替换路径（入队发布不依赖该文件）。')
        }
        return [summary, '', ...lines].join('\n')
      },
    }),
    textTool({
      name: 'xy_publish_batch',
      access: 'confirm',
      reason: '会把一批发布任务排进 daemon 队列（daemon 以 BF_PUBLISH_SUBMIT=1 启动时会逐条真发布），需要人工确认。',
      // 与 xy_publish_draft 同一口径：默认 dry-run 只读草稿（文件）并出计划，不写队列。
      writeWhen: nonDryRunIsWrite,
      description: '批量发布：一次性校验多条草稿并逐条入队（自动发布的批量入口）。默认 dry-run（与 xy_publish_draft 一致）：只输出逐条计划（幂等键/标题/价格/状态），不碰 daemon 写队列；mode=enqueue 才逐条写 daemon 队列（写操作，需人工确认；daemon 以 BF_PUBLISH_SUBMIT=1 启动才会逐条真提交）。同一批里内容相同的草稿只入队一次；单条非法不拖垮整批。\n\n用哪个工具：一次发多条用本工具；只发一条用 xy_publish_draft（带草稿文件的发布前校验）；给发货/擦亮等非发布动作排队用 xy_task_enqueue。',
      parameters: {
        type: 'object',
        properties: {
          drafts: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: true }, description: '内联草稿对象数组；与 draftPaths 至少给一个，可同时给。' },
          draftPaths: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 }, description: '草稿 JSON 文件路径数组；与 drafts 至少给一个，可同时给。' },
          accountId: { type: 'string', minLength: 1, maxLength: 64, description: '发布账号 id；mode=enqueue 必填，dry-run 可选。' },
          mode: { type: 'string', enum: ['dry-run', 'enqueue'], description: 'dry-run（默认）只出计划；enqueue 才写 daemon 队列。' },
          maxItems: { type: 'integer', minimum: 1, maximum: 20, description: '本批最多处理多少条，默认 20（上限 20）。' },
          batchId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$', description: '批次 id（字母数字 . _ -，≤64）；不给则自动生成。用于事后按批次查进度（GET /batches/:id / 面板「批次」视图）。' },
        },
        anyOf: [{ required: ['drafts'] }, { required: ['draftPaths'] }],
        additionalProperties: false,
      },
      // 20 条串行入队 + 一次批次回读。单条入队是本地 SQLite 写（毫秒级），但每条都可能
      // 撞 15s 的 HTTP 超时上限，60s 在最坏情况下会在第 5 条左右被工具层掐断、
      // 让「前 4 条已入队」这个事实说不出口。放宽到 120s：仍能兜住正常批量，又不会挂太久。
      timeoutMs: 120_000,
      async handler(args) {
        return runBatch(args, { client, readDraftFile: deps.readDraftFile })
      },
    }),
  ]
}
