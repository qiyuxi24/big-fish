/**
 * daemon 运行时装配：把 store/queue/items/凭据/限流/熔断/执行器/通道/worker/HTTP 串成一个进程。
 *
 * 为什么单独一个文件：cli.ts 只该负责「参数 → 配置 → 启动 → 等信号」，
 * 集成测试又需要同样的装配但换掉通道（fake transport）与端口。装配逻辑放这里，
 * 两边共用一份，避免测试跑的不是生产那条路径。
 * @module @bigfish/daemon/runtime
 */
import {
  CircuitBreaker,
  CredentialStore,
  RateLimiter,
  createItemRepository,
  createLogger,
  createTaskQueue,
  fail,
  openStore,
} from '@bigfish/core'
import type {
  DaemonConfig,
  ItemRepository,
  Logger,
  Store,
  TaskQueueHandle,
} from '@bigfish/core'

import { importAccountFromChrome } from './accounts.ts'
import { listAccountSummaries } from './account-list.ts'
import { loginAndSave } from './login.ts'
import { createReferenceCollector } from './reference.ts'
import { createExecutors } from './executors.ts'
import type { OperationPort } from './executors.ts'
import type { ExecutorDeps } from './executor.ts'
import { createFetchTransport, createOperationPort } from './operations.ts'
import type { PublishPortOptions } from './operations.ts'
import { startDaemon } from './server.ts'
import type { Daemon } from './server.ts'
import { startWorker } from './worker.ts'
import type { WorkerHandle } from './worker.ts'
import type { MtopTransport } from '@bigfish/channel-mtop'

export interface DaemonRuntimeOptions {
  config: DaemonConfig
  /** 通道传输层；测试注入 fake，生产用全局 fetch。 */
  transport?: MtopTransport
  /** 覆盖单个通道方法（集成测试用）；未覆盖的走 transport。 */
  ports?: Partial<OperationPort>
  /** 发布通道配置；缺省时 publish 仍是 UNSUPPORTED（安全默认）。 */
  publish?: PublishPortOptions
  /** 注入时钟（毫秒）；测试用。 */
  now?: () => number
  logger?: Logger
  /** worker 租约持有者，默认 daemon-<pid>。 */
  owner?: string
  /** 是否自动开始 worker 轮询，默认 true；集成测试传 false 手动 tick。 */
  autoStartWorker?: boolean
  version?: string
}

export interface DaemonRuntime {
  daemon: Daemon
  worker: WorkerHandle
  store: Store
  queue: TaskQueueHandle
  items: ItemRepository
  credentials: CredentialStore
  limiter: RateLimiter
  circuits: CircuitBreaker
  /** 刷新 /status 里的账号列表缓存（凭据列表是异步的，status 是同步的）。 */
  refreshAccounts(): Promise<string[]>
  /** 顺序：停 worker → 停 HTTP → 关 SQLite；幂等。 */
  close(): Promise<void>
}

/**
 * 启动完整 daemon。失败时自己回收已建的资源，不把半启动状态抛给调用方。
 */
export async function startDaemonRuntime(options: DaemonRuntimeOptions): Promise<DaemonRuntime> {
  const { config } = options
  const now = options.now
  const logger = options.logger ?? createLogger({ level: config.logLevel, name: 'bigfish-daemon' })

  const store = openStore({ path: config.dbPath, ...(now === undefined ? {} : { now }) })
  try {
    const queue = createTaskQueue({ store, ...(now === undefined ? {} : { now }) })
    const items = createItemRepository({ store, ...(now === undefined ? {} : { now }) })
    const credentials = new CredentialStore({
      dir: config.credentialsDir,
      ...(now === undefined ? {} : { now }),
    })
    const limiter = new RateLimiter(now === undefined ? {} : { now })
    const circuits = new CircuitBreaker({
      path: config.circuitPath,
      ...(now === undefined ? {} : { now }),
    })

    // ports：真实通道 + 测试覆盖；Partial 覆盖只替换指定方法。
    const basePorts = createOperationPort({
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(now === undefined ? {} : { now }),
      ...(options.publish === undefined ? {} : { publish: options.publish }),
    })
    const ports: OperationPort = { ...basePorts, ...(options.ports ?? {}) }

    // 参考采集与执行器共用一份 transport：同一个账号、同一套超时语义。
    // 单独建 collector 而不是塞进 OperationPort：它不由队列任务驱动，是只读的即时查询。
    const referenceCollector = createReferenceCollector({
      transport: options.transport ?? createFetchTransport(),
      ...(now === undefined ? {} : { now }),
    })

    const deps: ExecutorDeps = {
      items,
      credentials,
      limiter,
      circuits,
      logger,
      ...(now === undefined ? {} : { now }),
    }
    const executors = createExecutors({ ports })

    // 账号缓存：/status 是同步接口，凭据列表是异步的，所以启动时刷一次，
    // 之后由 refreshAccounts() 显式刷新（写凭据的插件侧可以间接触发）。
    let accounts: string[] = []
    const refreshAccounts = async (): Promise<string[]> => {
      accounts = await credentials.list()
      return accounts
    }
    await refreshAccounts()

    const worker = startWorker({
      queue,
      executors,
      deps,
      owner: options.owner ?? 'daemon-' + String(process.pid),
      leaseTtlMs: config.leaseTtlMs,
      pollIntervalMs: config.pollIntervalMs,
      logger,
      autoStart: options.autoStartWorker ?? true,
      ...(now === undefined ? {} : { now }),
    })

    let daemon: Daemon
    try {
      daemon = await startDaemon({
        config,
        queue,
        items,
        circuits,
        accounts: () => accounts,
        // 账号面板的列表：只读摘要，cookie 值不出进程（见 account-list.ts）。
        accountSummaries: () =>
          listAccountSummaries({
            credentials,
            ...(options.now === undefined ? {} : { now: options.now }),
          }),
        worker: () => worker.stats(),
        // 人工收尾：requeue 成功后必须立刻唤醒 worker，否则要等下一个 pollIntervalMs，
        // 用户在面板点「重试」会看起来没反应。tick 自身串行（正在 tick 时直接返回），
        // 所以不 await、不阻塞 HTTP 响应；唤醒失败不该让「已成功入队」的重试变成 500。
        retryTask: (id) => {
          const record = queue.requeue(id)
          void worker.tick().catch((error: unknown) => {
            logger.warn('retry 后唤醒 worker 失败（任务已重新排队，下一轮轮询会接手）', {
              taskId: id,
              error: error instanceof Error ? error.message : String(error),
            })
          })
          return record
        },
        // 采集参考：只读统计，cookie 值不出进程；令牌过期时用回写的凭据库刷新。
        referenceCollect: async (input) => {
          const record = await credentials.load(input.accountId)
          if (record === undefined) {
            fail('UNAUTHORIZED', '没有账号 ' + input.accountId + ' 的登录态，先导入或扫码登录')
          }
          return referenceCollector.collect({
            accountId: input.accountId,
            cookies: record.cookies,
            ...(input.itemIds === undefined ? {} : { itemIds: input.itemIds }),
            ...(input.sellerId === undefined ? {} : { sellerId: input.sellerId }),
            signal: input.signal,
            onSessionUpdate: async (cookies) => {
              await credentials.save({
                accountId: input.accountId,
                cookies,
                ...(record.meta === undefined ? {} : { meta: record.meta }),
              })
            },
          })
        },
        importAccount: async (input) => {
          const imported = await importAccountFromChrome({
            credentials,
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
            ...(input.port === undefined ? {} : { port: input.port }),
          })
          // /status 的账号列表是启动时快照；导入后立刻刷新，概览面板才不会显示旧列表。
          await refreshAccounts()
          return imported
        },
        // 扫码登录与导入共用 CredentialStore，只是多了「开页面 + 等扫码」的轮询。
        loginAccount: async (input) => {
          const logged = await loginAndSave(
            { credentials, ...(options.now === undefined ? {} : { now: options.now }) },
            input,
          )
          await refreshAccounts()
          return logged
        },
        ...(options.version === undefined ? {} : { version: options.version }),
      })
    } catch (error) {
      await worker.stop()
      throw error
    }

    let closed = false
    return {
      daemon,
      worker,
      store,
      queue,
      items,
      credentials,
      limiter,
      circuits,
      refreshAccounts,
      async close(): Promise<void> {
        if (closed) return
        closed = true
        await worker.stop()
        await daemon.close()
        queue.close()
        store.close()
      },
    }
  } catch (error) {
    store.close()
    throw error
  }
}