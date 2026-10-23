/**
 * 发布类工具规格（xy_publish_draft / xy_publish_batch）。
 *
 * 为什么单独成文件：发布是当前主线模块，两条规格占 tools.js 近一半篇幅；
 * 拆出来后「加一个发布工具」只改这里，读工具列表时也不用跳过两百行发布参数。
 * 门禁口径不变：默认 dry-run 放行，显式 enqueue 才要人工确认。
 * @module @bigfish/plugin-ops/tool-specs-publish
 */
import { runBatch } from './batch.js'
import { loadPublishDraft } from './draft.js'
import { dryRunLines, enqueuePublish, formatDraftSummary, healthNote } from './publish-flow.js'
import { formatTaskLine } from './tool-format.js'
import { nonDryRunIsWrite, textTool } from './tool-kit.js'

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
      access: 'confirm',
      reason: '会把一批发布任务排进 daemon 队列（daemon 以 BF_PUBLISH_SUBMIT=1 启动时会逐条真发布），需要人工确认。',
      // 与 xy_publish_draft 同一口径：默认 dry-run 只读草稿（文件）并出计划，不写队列。
      writeWhen: nonDryRunIsWrite,
      description: '批量发布：一次性校验多条草稿并逐条入队（自动发布的批量入口）。默认 dry-run（与 xy_publish_draft 一致）：只输出逐条计划（幂等键/标题/价格/状态），不碰 daemon 写队列；mode=enqueue 才逐条写 daemon 队列（写操作，需人工确认；daemon 以 BF_PUBLISH_SUBMIT=1 启动才会逐条真提交）。同一批里内容相同的草稿只入队一次；单条非法不拖垮整批。',
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
      timeoutMs: 60_000,
      async handler(args) {
        return runBatch(args, { client, readDraftFile: deps.readDraftFile })
      },
    }),
  ]
}
