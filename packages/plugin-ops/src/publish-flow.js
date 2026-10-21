/**
 * 发布草稿的两条执行路径：dry-run 命令提示与入队发布。
 *
 * 为什么单独成文件：tools.js 只负责 ToolDefinition 的形状，这里的文本编排和
 * 入队前校验都属于流程逻辑，拆开才能守住单文件 ≤400 行 / 单函数 ≤60 行。
 * formatTask 由调用方注入（复用 src/tools.js 的 formatTaskLine），避免循环 import。
 *
 * @module @bigfish/plugin-ops/publish-flow
 */
import { DaemonError } from './client.js'
import { buildPublishCommand, describeDraft, draftDedupeKey } from './draft.js'

/** 草稿路径 + 字段摘要。 */
export function formatDraftSummary(path, draft) {
  return ['草稿：' + path, ...describeDraft(draft)].join('\n')
}

/** dry-run 的正文：命令、为什么默认不提交、真机校准建议。 */
export function dryRunLines(args, draft) {
  const lines = [
    '模式：dry-run（默认）。只填表、不点提交，也不碰 daemon 写队列。',
    '校准命令：',
    '  ' + buildPublishCommand({
      draftPath: args.draftPath,
      accountId: args.accountId,
      chromePort: args.chromePort,
      screenshotsDir: args.screenshotsDir,
    }),
    '说明：daemon 的 CDP 步骤机会打开真实 Chrome，按草稿填标题/文案/价格/图片；命令不带 --submit 就不会发布。',
    '建议加 --screenshots <目录> 保留每步截图，真机校准对着截图检查选择器。',
  ]
  if (draft.quantity !== undefined) {
    lines.push('注意：草稿里的 quantity 还没接入 CDP 步骤机，dry-run 会报 VALIDATION，请先去掉该字段。')
  }
  return lines
}

/** dry-run 时顺带探一次 daemon；连不上只提示，不影响输出（dry-run 不依赖 daemon）。 */
export async function healthNote(client) {
  try {
    const health = await client.health()
    const version = health !== null && typeof health === 'object' && typeof health.version === 'string' ? health.version : '未知版本'
    return 'daemon：在线（v' + version + '）。dry-run 本身不依赖 daemon。'
  } catch (error) {
    if (!(error instanceof DaemonError)) throw error
    return 'daemon：' + error.code + '（dry-run 不依赖 daemon，可直接跑上面的命令）'
  }
}

/**
 * 单条入队的校验与载荷拼装。批量发布也复用这里：单条与批量必须共用同一份
 * title/quantity/accountId 校验和 payload 形状，否则两条路径迟早漂移
 * （例如批量漏校验 title，任务入队后必然 failed）。
 *
 * @param {Record<string, unknown>} args - 工具参数；批量只传 accountId。
 * @param {object} draft - validatePublishDraft 的结果。
 * @returns {{kind: string, dedupeKey: string, payload: object}} daemon /tasks 的入队体。
 */
export function buildPublishEnqueueInput(args, draft) {
  if (draft.title === '') {
    throw new DaemonError('VALIDATION', '入队发布要求草稿 title 非空：在草稿文件里补上 title 再试')
  }
  // CDP 步骤机当前只发 1 件，带 quantity 的草稿在 executor 里必然 VALIDATION。
  if (draft.quantity !== undefined) {
    throw new DaemonError('VALIDATION', '队列发布当前只支持 1 件：草稿请去掉 quantity 字段')
  }
  if (typeof args.accountId !== 'string' || args.accountId.trim() === '') {
    throw new DaemonError('VALIDATION', '入队发布必须给 accountId：daemon 按账号载入登录态，这也是防发错号的依据')
  }
  const dedupeKey = typeof args.dedupeKey === 'string' && args.dedupeKey !== '' ? args.dedupeKey : draftDedupeKey(draft)
  return {
    kind: 'publish',
    dedupeKey,
    payload: {
      accountId: args.accountId,
      title: draft.title,
      desc: draft.desc,
      priceCents: draft.priceCents,
      images: draft.images,
      // 草稿里显式给了分类就一起入队：否则 daemon 侧只能靠页面 AI 识别，
      // 识别到网页端不支持的类目会在提交时失败。
      ...(draft.category === undefined ? {} : { category: draft.category }),
      // 地址与包邮必须一起入队：队列任务执行时 daemon 没有草稿文件可读，
      // 少了 address，「必填项预检」必然 VALIDATION（宝贝所在地为空），任务只会 failed。
      ...(draft.shipping === undefined ? {} : { shipping: draft.shipping }),
      ...(draft.address === undefined ? {} : { address: draft.address }),
    },
  }
}

/**
 * 入队发布。本地先把能被 daemon 执行器拒绝的草稿挡掉，避免任务进去才 failed。
 *
 * @param {Record<string, unknown>} args - 工具参数。
 * @param {object} draft - validatePublishDraft 的结果。
 * @param {{client: object, formatTask: (task: object) => string}} deps - 依赖注入。
 * @returns {Promise<string[]>} 输出行。
 */
export async function enqueuePublish(args, draft, deps) {
  const input = buildPublishEnqueueInput(args, draft)
  const task = await deps.client.enqueue(input)
  return [
    '已入队：' + deps.formatTask(task),
    '幂等键：' + input.dedupeKey + '（同一份草稿重复调用只会留一条任务）',
    '⚠ 队列发布只有 daemon 以 BF_PUBLISH_SUBMIT=1 启动才会真提交；默认会以 UNSUPPORTED 失败并转 needs_review，不会假装发布成功。',
    '真机校准仍建议先跑 dry-run：' + buildPublishCommand({
      draftPath: args.draftPath,
      accountId: args.accountId,
      chromePort: args.chromePort,
      screenshotsDir: args.screenshotsDir,
    }),
  ]
}
