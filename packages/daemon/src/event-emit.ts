/**
 * 任务事件落库的薄封装（daemon 侧）。
 *
 * 为什么单独一层：事件流是观测面，写失败绝不能影响任务状态机或发布结果。所有调用点
 * 只关心「有没有事件」；异常在这里吞掉并记 warn（core 的 store 校验仍会抛，需要兜）。
 * @module @bigfish/daemon/event-emit
 */
import type { TaskEventInput } from '@bigfish/core'

import type { ExecuteContext, ExecutorDeps } from './executor.ts'
import type { TaskRecord } from '@bigfish/core'

/** 状态事件的附加信息（失败码与脱敏后的消息）。 */
export interface StateEventExtra {
  code?: string
  message?: string
}

/** 队列状态迁移事件：done / failed / needs_review / queued。 */
export function emitTaskState(
  deps: ExecutorDeps,
  task: TaskRecord,
  state: string,
  extra: StateEventExtra = {},
): void {
  append(deps, task, {
    kind: 'task.state',
    state,
    ...(extra.code === undefined ? {} : { code: extra.code }),
    ...(extra.message === undefined ? {} : { message: extra.message }),
  })
}

/** 通道步骤事件：由发布执行器的 onStep 回调驱动。 */
export function emitTaskStep(deps: ExecutorDeps, task: TaskRecord, step: string, message: string): void {
  const state = stepState(message)
  append(deps, task, {
    kind: 'task.step',
    step,
    message,
    ...(state === undefined ? {} : { state }),
  })
}

/**
 * 步骤文案 → 状态。channel-cdp 的 runPublishSteps 只回三种文案（开始/完成/失败：…），
 * 在这里映射而不是改通道层：通道层不认识任务事件，保持纯步骤机。
 */
function stepState(message: string): string | undefined {
  if (message === '开始') return 'started'
  if (message === '完成') return 'done'
  if (message.startsWith('失败')) return 'failed'
  return undefined
}

function append(deps: ExecutorDeps, task: TaskRecord, event: Omit<TaskEventInput, 'taskId' | 'batchId'>): void {
  const events = deps.events
  if (events === undefined) return
  try {
    events.append({ taskId: task.id, ...(task.batchId === undefined ? {} : { batchId: task.batchId }), ...event })
  } catch (error) {
    deps.logger?.warn('写任务事件失败（观测面，不影响任务）', {
      taskId: task.id,
      kind: event.kind,
      step: event.step ?? null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
