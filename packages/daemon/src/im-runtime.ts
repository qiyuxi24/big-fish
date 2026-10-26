/**
 * IM 运行时：按账号维护 ImClient 的生命周期，并把「回复任务」路由到对应账号的连接。
 *
 * 为什么单独一层而不是塞进 runtime.ts：runtime 已经 360 行，且这一层要能在
 * 测试里独立注入 fake ws / fake mtop；runtime 只负责「建一次、关一次、把端口接上」。
 *
 * 默认不启用（enabled=false）：daemon 每次启动都自己去连 wss，会让测试、离线排障、
 * 以及「只想跑发布」的用户都意外暴露在登录态与风控面上。必须显式 BF_IM=1。
 * @module @bigfish/daemon/im-runtime
 */
import { fail } from '@bigfish/core'
import type { CredentialStore, ImMessageSink, Logger } from '@bigfish/core'
import type { MtopTransport } from '@bigfish/channel-mtop'

import { ImClient } from './im-client.ts'
import type { ImClientEvent } from './im-client.ts'
import type { ReplyRequest } from './executors.ts'
import type { ImTokenSession } from './im-token.ts'
import type { WebSocketFactory } from './im-transport.ts'

export interface ImRuntimeOptions {
  credentials: CredentialStore
  transport: MtopTransport
  /** im_messages 落地仓储（core/createImMessageRepository）。 */
  sink: ImMessageSink
  /** 默认关闭；只有显式开启才会连 wss。 */
  enabled?: boolean
  webSocketFactory?: WebSocketFactory
  now?: () => number
  logger?: Logger
}

/** 一个账号的 IM 连接状态（面板只读诊断用，不含任何凭据）。 */
export interface ImAccountStatus {
  accountId: string
  state: string
  lastError?: string
}

export interface ImRuntime {
  readonly enabled: boolean
  /** 为账号建立连接并启动（幂等；失败只告警，不拖垮其它账号）。 */
  startAccount(accountId: string): void
  /** 批量启动（daemon 启动时按凭据列表调用）。 */
  startAll(accountIds: readonly string[]): void
  /** 回复任务入口：没有连接就现建一个（等就绪最多 10s）。 */
  sendReply(input: { accountId: string; reply: ReplyRequest; signal?: AbortSignal }): Promise<void>
  status(): ImAccountStatus[]
  /** 停掉所有连接（幂等）。 */
  stop(): void
}

/** 构造 IM 运行时；真正建连接发生在 startAccount / sendReply。 */
export function createImRuntime(options: ImRuntimeOptions): ImRuntime {
  const enabled = options.enabled === true
  const clients = new Map<string, ImClient>()

  /** 凭据每次现读：cookie 会在别的通道（mtop/扫码）被刷新，缓存一份就会用旧令牌握手。 */
  function loadSession(accountId: string): () => Promise<ImTokenSession | undefined> {
    return async (): Promise<ImTokenSession | undefined> => {
      const record = await options.credentials.load(accountId)
      if (record === undefined) return undefined
      const deviceId = record.meta?.['deviceId']
      const save = options.credentials.save
      return {
        accountId: record.accountId,
        cookies: record.cookies,
        ...(typeof deviceId === 'string' ? { deviceId } : {}),
        // 令牌刷新回写：meta 原样带回，否则 deviceId 会在下一次保存时丢失。
        ...(save === undefined
          ? {}
          : {
              onSessionUpdate: async (cookies: Record<string, string>): Promise<void> => {
                await save.call(options.credentials, {
                  accountId: record.accountId,
                  cookies,
                  ...(record.meta === undefined ? {} : { meta: record.meta }),
                })
              },
            }),
      }
    }
  }

  function logEvent(accountId: string, event: ImClientEvent): void {
    const logger = options.logger
    if (logger === undefined) return
    if (event.type === 'challenge') {
      logger.warn('IM 需要人工处理（风控/登录失效）', {
        accountId,
        code: event.code,
        message: event.message,
        ...(event.punishUrl === undefined ? {} : { punishUrl: event.punishUrl }),
      })
      return
    }
    if (event.type === 'state') {
      logger.info('IM 连接状态变化', { accountId, state: event.state, previous: event.previous })
      return
    }
    if (event.type === 'reconnect') {
      logger.info('IM 将重连', { accountId, attempt: event.attempt, delayMs: event.delayMs, reason: event.reason })
      return
    }
    if (event.type === 'message') {
      logger.debug('IM 收到消息', { accountId, cid: event.message.cid, messageId: event.message.messageId })
      return
    }
    logger.warn('IM 错误', { accountId, message: event.error.message })
  }

  function ensure(accountId: string): ImClient {
    const existing = clients.get(accountId)
    if (existing !== undefined) return existing
    if (!enabled) {
      fail('UNSUPPORTED', 'IM 通道未开启：设置 BF_IM=1 并重启 daemon（默认不连 wss，避免测试/离线时自己暴露登录态）')
    }
    const client = new ImClient({
      accountId,
      transport: options.transport,
      sink: options.sink,
      loadSession: loadSession(accountId),
      ...(options.webSocketFactory === undefined ? {} : { webSocketFactory: options.webSocketFactory }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      onEvent: (event) => {
        logEvent(accountId, event)
      },
    })
    clients.set(accountId, client)
    return client
  }

  return {
    enabled,

    startAccount(accountId: string): void {
      try {
        ensure(accountId).start()
      } catch (error) {
        // 单账号起不来（如未开启/没凭据）不能影响其它账号与 daemon 启动。
        options.logger?.warn('IM 账号启动失败（其它账号继续）', {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },

    startAll(accountIds: readonly string[]): void {
      if (!enabled) return
      for (const accountId of accountIds) this.startAccount(accountId)
    },

    async sendReply(input): Promise<void> {
      const client = ensure(input.accountId)
      // 已 ready/connecting/backoff 时 start 是幂等的；blocked 状态保持不动，由 sendReply 抛出原因。
      client.start()
      await client.sendReply(input.reply, input.signal)
    },

    status(): ImAccountStatus[] {
      return [...clients.entries()].map(([accountId, client]) => ({
        accountId,
        state: client.state,
        ...(client.lastError === undefined ? {} : { lastError: client.lastError.message }),
      }))
    },

    stop(): void {
      for (const client of clients.values()) client.stop()
      clients.clear()
    },
  }
}
