/**
 * 批量发布的渲染层：把 prepareBatch/runBatch 产出的计划渲染成模型可读文本（逐条一行 + 汇总 + 下一步）。
 * 从 batch.js 拆出（2026-10-24，守 AGENTS §3「文件 ≤400 行」）；纯字符串拼接，不碰 IO、不读时钟。
 *
 * @module @bigfish/plugin-ops/batch-format
 */

/** 标题只用于展示：超过 24 个字符就截断，避免一行输出被长标题撑爆。 */
function formatTitle(draft) {
  if (draft.title === '') return '（空标题，入队前必须补）'
  return draft.title.length <= 24 ? draft.title : draft.title.slice(0, 24) + '…'
}

function formatPrice(draft) {
  // 价格只在展示时除以 100，不参与任何计算（AGENTS.md §3：金额一律整数分）。
  return '¥' + (draft.priceCents / 100).toFixed(2)
}

function formatItemLine(item, mode) {
  const status = mode === 'dry-run' && item.status === 'ok' ? 'plan' : item.status
  const head = '#' + String(item.index) + ' [' + status + '] ' + item.source
  if (item.status === 'invalid' || item.status === 'failed') return head + '：' + item.reason
  const parts = [head, 'key=' + item.dedupeKey, '标题=' + formatTitle(item.draft), '价格=' + formatPrice(item.draft)]
  if (item.taskId !== undefined) parts.push('task=' + item.taskId)
  if (item.status === 'skipped-duplicate') parts.push('（' + item.reason + '）')
  if (item.status === 'existing' && item.reason !== undefined) parts.push('（' + item.reason + '）')
  return parts.join(' ')
}

function countStatuses(items) {
  const counts = { planned: 0, queued: 0, existing: 0, duplicate: 0, invalid: 0, failed: 0 }
  for (const item of items) {
    if (item.status === 'queued') counts.queued += 1
    else if (item.status === 'existing') counts.existing += 1
    else if (item.status === 'skipped-duplicate') counts.duplicate += 1
    else if (item.status === 'invalid') counts.invalid += 1
    else if (item.status === 'failed') counts.failed += 1
    else counts.planned += 1
  }
  return counts
}

function summaryLine(plan) {
  const counts = countStatuses(plan.items)
  if (plan.mode === 'enqueue') {
    return '合计：新入队 ' + String(counts.queued) + ' / 已在队列 ' + String(counts.existing)
      + ' / 批内重复 ' + String(counts.duplicate) + ' / 非法 ' + String(counts.invalid) + ' / 失败 ' + String(counts.failed)
  }
  return '合计：可入队 ' + String(counts.planned) + ' / 批内重复 ' + String(counts.duplicate)
    + ' / 非法 ' + String(counts.invalid)
}

function nextStepLines(plan) {
  if (plan.mode === 'enqueue') {
    return [
      '下一步：xy_tasks_list（kind=publish）看队列；卡住或待审的任务用 xy_task_action 处理。',
      '⚠ 只有 daemon 以 BF_PUBLISH_SUBMIT=1 启动才会真提交；否则任务会以 UNSUPPORTED 直接失败（failed，不是 needs_review），不会假装成功。',
    ]
  }
  return [
    "真跑：把 mode 改成 'enqueue'（写操作，会走审批门禁把任务排进 daemon 队列）；daemon 需要以 BF_PUBLISH_SUBMIT=1 启动才会真提交。",
    '建议先用 xy_publish_draft 对单条做真机校准（带 --screenshots），确认选择器后再批量入队。',
  ]
}

/** daemon 的批次视图：入队后回读一次，告诉调用方「服务端现在怎么记账」。 */
function formatServerBatchView(plan) {
  const stats = plan.batchStats
  if (plan.mode !== 'enqueue' || stats === null || typeof stats !== 'object') return undefined
  const counts = stats.counts ?? {}
  const order = ['queued', 'leased', 'done', 'failed', 'needs_review']
  const parts = order.map((state) => state + ' ' + String(counts[state] ?? 0))
  return 'daemon 批次视图（' + String(stats.batchId ?? plan.batchId) + '）：共 ' + String(stats.total ?? 0) + ' 条 · ' + parts.join(' / ')
}

/** 把计划渲染成模型可读文本：逐条一行 + 汇总 + 下一步。 */
export function formatBatchResult(plan) {
  const total = plan.items.length + plan.truncated
  const header = plan.mode === 'enqueue'
    ? '批量发布：enqueue（逐条写 daemon 队列' + (plan.batchId === undefined ? '' : '，批次 ' + plan.batchId) + '）'
    : '批量发布计划：dry-run（只出计划，不碰 daemon 写队列）'
  const truncated = plan.truncated > 0
    ? '（按 maxItems 截断 ' + String(plan.truncated) + ' 条，本批只处理前 ' + String(plan.items.length) + ' 条）'
    : ''
  const rows = plan.items.map((item) => formatItemLine(item, plan.mode))
  const serverView = formatServerBatchView(plan)
  const viewError = plan.batchViewError === undefined ? [] : ['（批次视图读取失败：' + plan.batchViewError + '；逐条入队结果不受影响）']
  return [header + '，共 ' + String(total) + ' 条' + truncated, ...rows, '', summaryLine(plan), ...(serverView === undefined ? [] : [serverView]), ...viewError, ...nextStepLines(plan)].join('\n')
}
