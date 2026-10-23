/**
 * 发布执行器 → 任务步骤事件：onStep 回调映射成 task.step 事件（工作流树的数据源）。
 * 事件流是观测面：写失败不能改变发布结果。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CredentialRecord, TaskEventInput, TaskEventRecord, TaskEventSink } from '@bigfish/core'

import { createExecutors } from '../src/executors.ts'
import type { OperationPort } from '../src/executors.ts'
import type { ExecuteContext } from '../src/executor.ts'

interface FakeSink extends TaskEventSink {
  events: TaskEventInput[]
}

function makeSink(options: { throwOnAppend?: boolean } = {}): FakeSink {
  const events: TaskEventInput[] = []
  return {
    events,
    append(input) {
      if (options.throwOnAppend === true) throw new Error('disk full')
      events.push(input)
      const record: TaskEventRecord = { id: events.length, at: 1, taskId: input.taskId, kind: input.kind }
      return record
    },
    list() {
      return []
    },
  }
}

const CREDENTIALS = {
  async load(accountId: string): Promise<CredentialRecord | undefined> {
    return { accountId, cookies: {}, updatedAt: 1 }
  },
}

function makeCtx(events: TaskEventSink | undefined): ExecuteContext {
  return {
    task: {
      id: 't1',
      kind: 'publish',
      dedupeKey: 'k1',
      payload: { accountId: 'acc1', title: 'T', desc: 'D', priceCents: 1000, images: ['a.png'] },
      state: 'leased',
      attempts: 1,
      maxAttempts: 3,
      availableAt: 0,
      batchId: 'b1',
      createdAt: 0,
      updatedAt: 0,
    },
    signal: new AbortController().signal,
    credentials: CREDENTIALS,
    ...(events === undefined ? {} : { events }),
    now: () => 1_000,
  } as ExecuteContext
}

function makePort(onStepRun: (onStep: (step: string, message: string) => void) => void): OperationPort {
  return {
    async fetchItemDetail() {
      throw new Error('不该被调用')
    },
    async polishItem() {
      throw new Error('不该被调用')
    },
    async publishItem(input) {
      onStepRun(input.onStep ?? ((): void => {}))
      return {}
    },
    async deliverOrder() {
      throw new Error('不该被调用')
    },
    async sendReply() {
      throw new Error('不该被调用')
    },
    async verifySession() {
      throw new Error('不该被调用')
    },
  }
}

describe('发布执行器 → 任务步骤事件', () => {
  it('onStep 的 开始/完成/失败 映射成 started/done/failed 事件，带 taskId 与 batchId', async () => {
    const sink = makeSink()
    const port = makePort((onStep) => {
      onStep('填标题', '开始')
      onStep('填标题', '完成')
      onStep('选类目', '失败：类目不支持')
    })
    const executors = createExecutors({ ports: port })
    const ctx = makeCtx(sink)
    await executors.publish?.execute(ctx.task, ctx)
    assert.deepEqual(
      sink.events.map((event) => [event.kind, event.step, event.state]),
      [
        ['task.step', '填标题', 'started'],
        ['task.step', '填标题', 'done'],
        ['task.step', '选类目', 'failed'],
      ],
    )
    assert.equal(sink.events[0]?.taskId, 't1')
    assert.equal(sink.events[0]?.batchId, 'b1')
    assert.equal(sink.events[2]?.message, '失败：类目不支持')
  })

  it('未注入事件流：发布照常成功（执行器不强制依赖观测面）', async () => {
    const port = makePort((onStep) => {
      onStep('填标题', '开始')
    })
    const executors = createExecutors({ ports: port })
    const ctx = makeCtx(undefined)
    await executors.publish?.execute(ctx.task, ctx)
    assert.equal(ctx.task.id, 't1')
  })

  it('事件写入抛错：发布仍成功（观测面失败不影响任务状态机）', async () => {
    const sink = makeSink({ throwOnAppend: true })
    const port = makePort((onStep) => {
      onStep('填标题', '开始')
    })
    const executors = createExecutors({ ports: port })
    const ctx = makeCtx(sink)
    await executors.publish?.execute(ctx.task, ctx)
    assert.deepEqual(sink.events, [])
  })
})
