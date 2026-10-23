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
  createTaskEventStore,
  createTaskQueue,
  fail,
  openStore,
} from '@bigfish/core'
import type {
  DaemonConfig,
  ItemRepository,
  Logger,
  Settings,
  Store,
  TaskQueueHandle,
} from '@bigfish/core'

import { dirname, join } from 'node:path'

import { importAccountFromChrome } from './accounts.ts'
import { listAccountSummaries } from './account-list.ts'
import { createAccountStateStore } from './account-state.ts'
import { createAccountVerifier } from './account-session.ts'
import { createAccountLifecycle } from './account-lifecycle.ts'
import { createKeepAlivePicker, startAccountKeepAlive } from './account-keepalive.ts'
import type { AccountKeepAlive } from './account-keepalive.ts'
import { loginAndSave } from './login.ts'
import { createReferenceCollector } from './reference.ts'
import { createExecutors } from './executors.ts'
import type { OperationPort } from './executors.ts'
import type { ExecutorDeps } from './executor.ts'
import { createFetchTransport, createOperationPort } from './operations.ts'
import type { PublishPortOptions } from './operations.ts'
import { startDaemon } from './server.ts'
import type { Daemon } from './server.ts'
import type { RequestShutdown } from './routes.ts'
import { createSettingsStore } from './settings.ts'
import type { SettingsStore } from './settings.ts'
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
  /** 是否随设置启动账号保活定时器，默认 true；测试传 false，避免定时器泄漏到下一个用例。 */
  autoStartKeepAlive?: boolean
  /** 优雅关停回调（POST /shutdown 触发）；cli 注入，测试可不传。 */
  requestShutdown?: RequestShutdown
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
    // 任务事件流：worker/执行器写，GET /events 与面板工作流树读（表由 v3 迁移建）。
    const events = createTaskEventStore(store, now === undefined ? {} : { now })
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
    // 设置跟数据库放同一目录：一次备份/迁移就是搬整个数据目录，不用记两处路径。
    const settings = createSettingsStore(join(dirname(config.dbPath), 'settings.json'))
    // 最近一次登录态检测的缓存：与 settings 同目录；文件坏了就当没有历史，绝不影响 /accounts。
    const accountState = createAccountStateStore({
      path: join(dirname(config.dbPath), 'account-state.json'),
      ...(now === undefined ? {} : { now }),
    })

    // ports：真实通道 + 测试覆盖；Partial 覆盖只替换指定方法。
    const basePorts = createOperationPort({
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(now === undefined ? {} : { now }),
      ...(options.publish === undefined ? {} : { publish: options.publish }),
    })
    const ports: OperationPort = { ...basePorts, ...(options.ports ?? {}) }

    // 登录态校验执行器：同账号单飞 + 5s 冷却，结果与结论都落 account-state（见 account-session.ts）。
    const verifier = createAccountVerifier({
      credentials,
      ports,
      state: accountState,
      now: now ?? Date.now,
      onRecordError: (error) => {
        logger.warn('账号状态缓存写入失败（不影响本次校验结论）', { error: messageOf(error) })
      },
    })
    const lifecycle = createAccountLifecycle({
      credentials,
      settings,
      state: accountState,
      onStateError: (error) => {
        logger.warn('账号状态缓存清理失败（凭据已删除）', { error: messageOf(error) })
      },
    })

    // 保活定时器由设置驱动：update 成功后立刻按新开关/间隔重建，否则用户改完设置要等重启才生效。
    // 包一层 SettingsStore 而不是改 routes：路由调用面保持不变（routes 只依赖 get/update）。
    const autoStartKeepAlive = options.autoStartKeepAlive ?? true
    let keepAlive: AccountKeepAlive | undefined
    const stopKeepAlive = (): void => {
      keepAlive?.stop()
      keepAlive = undefined
    }
    const reconcileKeepAlive = (current: Settings): void => {
      stopKeepAlive()
      if (!autoStartKeepAlive || !current.keepAliveEnabled) return
      keepAlive = startAccountKeepAlive({
        intervalMs: current.keepAliveIntervalMs,
        verify: (accountId) => verifier.verify(accountId, 'keepalive'),
        pickAccountId: createKeepAlivePicker({ credentials, settings }),
        onError: (error) => {
          logger.warn('保活检测失败（定时器继续下一轮）', { error: messageOf(error) })
        },
      })
    }
    const settingsWithKeepAlive: SettingsStore = {
      get: () => settings.get(),
      update: async (patch) => {
        const next = await settings.update(patch)
        reconcileKeepAlive(next)
        return next
      },
    }

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
      events,
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
        settings: settingsWithKeepAlive,
        events,
        accounts: () => accounts,
        // 账号面板的列表：只读摘要，cookie 值不出进程（见 account-list.ts）；顺带带上当前账号与最近检测结论。
        accountSummaries: async () => {
          const state = await accountState.read()
          return listAccountSummaries({
            credentials,
            state,
            activeAccountId: await readActiveAccountId(settings),
            ...(options.now === undefined ? {} : { now: options.now }),
          })
        },
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
        ...(options.requestShutdown === undefined ? {} : { requestShutdown: options.requestShutdown }),
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
          // 第一个导入的账号自动成为当前账号：否则面板与保活都没有默认可操作对象。
          // 设置写失败不回滚导入（凭据已经安全落盘），只在日志里提示。
          try {
            await lifecycle.activateIfEmpty(imported.accountId)
          } catch (error) {
            logger.warn('导入成功但设置当前账号失败（可在设置里手动切换）', {
              accountId: imported.accountId,
              error: messageOf(error),
            })
          }
          return imported
        },
        // 扫码登录与导入共用 CredentialStore，只是多了「开页面 + 等扫码」的轮询。
        loginAccount: async (input) => {
          const logged = await loginAndSave(
            { credentials, ...(options.now === undefined ? {} : { now: options.now }) },
            input,
          )
          await refreshAccounts()
          try {
            await lifecycle.activateIfEmpty(logged.accountId)
          } catch (error) {
            logger.warn('登录成功但设置当前账号失败（可在设置里手动切换）', {
              accountId: logged.accountId,
              error: messageOf(error),
            })
          }
          return logged
        },
        // 登录态校验：只读探测，失败也回 200 + online:false——面板要的是「账号掉没掉线」，
        // 而不是把 mtop 错误码当成 daemon 故障。只有账号不存在（VALIDATION）与能力未装配走错误信封。
        verifyAccount: async (input) => verifier.verify(input.accountId),
        // 切换当前账号只是本地设置，不触达闲鱼；退出登录只删本地凭据（见 account-lifecycle.ts）。
        activateAccount: async (input) => lifecycle.activate(input.accountId),
        logoutAccount: async (input) => {
          const result = await lifecycle.logout(input.accountId)
          // /status 的账号列表是启动时快照（见下方注释）：退出后必须刷新，否则概览面板仍显示已删账号。
          await refreshAccounts()
          return result
        },
        ...(options.version === undefined ? {} : { version: options.version }),
      })
    } catch (error) {
      stopKeepAlive()
      await worker.stop()
      throw error
    }

    // 启动保活：设置读失败只告警，不让一个可选后台任务拖垮 daemon 启动。
    try {
      reconcileKeepAlive(await settings.get())
    } catch (error) {
      logger.warn('读取设置失败，账号保活未启动', { error: messageOf(error) })
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
        stopKeepAlive()
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

/** settings 读不出来时只影响「当前账号」高亮，不该让账号列表 500。 */
async function readActiveAccountId(settings: SettingsStore): Promise<string> {
  try {
    return (await settings.get()).activeAccountId
  } catch {
    return ''
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}