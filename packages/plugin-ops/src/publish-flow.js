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

/**
 * 用 daemon 的 checkListing 跑一遍合规预检，把 error/warn 都摊开。
 *
 * 为什么值得多一次 HTTP：发布执行器会先跑 requirePolicy，不合规的草稿到那一刻就必然 failed。
 * 与其让模型「入队 → 等失败 → 读错误 → 改草稿」走三轮，不如在 dry-run 这一屏就把
 * 「描述只有 18 字（至少要 30）」「描述含违禁词 高仿」这些确定性的问题说清楚。
 *
 * 连不上 daemon 时只降级成一行提示，不阻断 dry-run（dry-run 本来就不依赖 daemon）。
 *
 * @param {object} client - daemon 客户端。
 * @param {object} draft - validatePublishDraft 的结果。
 * @returns {Promise<string[]>} 输出行；永远不抛。
 */
export async function policyLines(client, draft) {
  if (typeof client.checkPolicy !== 'function') return []
  let result
  try {
    result = await client.checkPolicy({
      title: draft.title,
      desc: draft.desc,
      priceCents: draft.priceCents,
      imageCount: draft.images.length,
      ...(draft.category === undefined ? {} : { categoryPath: [draft.category] }),
    })
  } catch (error) {
    if (!(error instanceof DaemonError)) throw error
    return ['合规预检：跳过（daemon ' + error.code + '，dry-run 仍可继续，但入队一定会在执行器里再查一遍）']
  }
  if (result === null || typeof result !== 'object') {
    return ['合规预检：跳过（daemon 没返回结果，dry-run 仍可继续）']
  }
  const issues = Array.isArray(result.issues) ? result.issues : []
  if (issues.length === 0) return ['合规预检：通过（标题/描述/价格/图片都在平台规则内）']
  const lines = ['合规预检：' + (result.ok === true ? '只有提示项' : '有会阻塞发布的问题')]
  for (const issue of issues) {
    if (issue === null || typeof issue !== 'object') continue
    const mark = issue.severity === 'error' ? '✖' : '!'
    const where = typeof issue.field === 'string' ? '[' + issue.field + '] ' : ''
    lines.push('  ' + mark + ' ' + where + String(issue.message ?? '') + (typeof issue.code === 'string' ? '（' + issue.code + '）' : ''))
  }
  if (result.ok !== true) {
    lines.push('  → 这些是 error 级：改了再入队，否则任务会在执行器里被 requirePolicy 拒掉（failed，不是 needs_review）。')
  }
  return lines
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
 * 入队前把 error 级合规问题挡掉。
 *
 * 为什么必须在这里挡：入队接口对任何 kind 都回 201，一条描述 18 字的草稿会安静地变成
 * 一条 failed 任务，占掉一个 attempts、在面板里留一行红字，然后还要人工去读 lastError。
 * 这类问题在入队前就是确定性的，本地能判就本地判。
 */
async function assertPolicyOk(client, draft) {
  if (typeof client.checkPolicy !== 'function') return
  let result
  try {
    result = await client.checkPolicy({
      title: draft.title,
      desc: draft.desc,
      priceCents: draft.priceCents,
      imageCount: draft.images.length,
      ...(draft.category === undefined ? {} : { categoryPath: [draft.category] }),
    })
  } catch (error) {
    // 预检自身失败不该阻止入队：执行器还会再查一遍，结果的正确性不受影响。
    if (error instanceof DaemonError) return
    throw error
  }
  if (result === null || typeof result !== 'object' || result.ok === true) return
  const issues = Array.isArray(result.issues) ? result.issues : []
  const errors = issues.filter((issue) => issue !== null && typeof issue === 'object' && issue.severity === 'error')
  const summary = errors.map((issue) => String(issue.message ?? '')).filter((text) => text !== '').join('；')
  throw new DaemonError('VALIDATION', '草稿未通过平台合规预检：' + (summary === '' ? '存在 error 级问题' : summary), {
    details: { issues },
  })
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
  const dedupeKey = typeof args.dedupeKey === 'string' && args.dedupeKey !== ''
    ? args.dedupeKey
    // 幂等键把账号算进去：daemon 的 dedupe_key 全局唯一，不带账号会让 B 号发同款被判重复。
    : draftDedupeKey(draft, args.accountId)
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
  await assertPolicyOk(deps.client, draft)
  const input = buildPublishEnqueueInput(args, draft)
  const task = await deps.client.enqueue(input)
  return [
    '已入队：' + deps.formatTask(task),
    '幂等键：' + input.dedupeKey + '（同一份草稿重复调用只会留一条任务）',
    '⚠ 队列发布只有 daemon 以 BF_PUBLISH_SUBMIT=1 启动才会真提交；默认会以 UNSUPPORTED 直接失败（failed，不是 needs_review），不会假装发布成功。',
    '真机校准仍建议先跑 dry-run：' + buildPublishCommand({
      draftPath: args.draftPath,
      accountId: args.accountId,
      chromePort: args.chromePort,
      screenshotsDir: args.screenshotsDir,
    }),
  ]
}
