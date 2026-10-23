/**
 * 通道装配：把 channel-mtop / channel-cdp 接到执行器的 OperationPort 上。
 *
 * P1.1 落地的真实通道：
 * - fetchItemDetail：mtop 详情接口 → core 的 ItemSummary（probe 任务用）。
 * - polishItem：mtop 擦亮接口 v2.0（写操作，已过执行器的限流与熔断）。
 *
 * P1.2 落地的通道：
 * - publishItem：CDP 发布步骤机（见 cdp-publish.ts）。默认仍是 UNSUPPORTED——
 *   只有显式开启 publish.submit（BF_PUBLISH_SUBMIT=1）才允许队列任务真提交，
 *   避免「一不小心把草稿发上线」。
 *
 * 尚未落地的通道（显式抛 UNSUPPORTED，避免任务被静默当成功）：
 * - deliverOrder / sendReply：IM 协议与发货规则在 P2 实现。
 *
 * 为什么 publish 不用 mtop：发布载荷含图片上传后的 imageInfoDOList，且部分类目只支持 App，
 * 网页端 CDP 是唯一能同时覆盖"图片 + 类目属性 + 地址"的通道（见 docs/xianyu-4q-research.md）。
 * @module @bigfish/daemon/operations
 */
import {
  MTOP_APIS,
  MTOP_API_VERSIONS,
  USER_MTOP_APIS,
  buildItemDetailData,
  buildPolishData,
  buildUserHeadData,
  callMtop,
  parseItemDetail,
} from '@bigfish/channel-mtop'
import type { MtopCallOptions, MtopHttpRequest, MtopHttpResponse, MtopTransport } from '@bigfish/channel-mtop'
import { XianyuError, fail } from '@bigfish/core'

import { publishViaCdp } from './cdp-publish.ts'
import type { PublishViaCdpInput, PublishViaCdpResult } from './cdp-publish.ts'
import type { DetailSnapshot, OperationPort, PublishDraft, Session } from './executors.ts'

/**
 * 取 Set-Cookie 原始行；运行时没有 getSetCookie 时返回空数组。
 * headers 里的 'set-cookie' 是多条逗号拼接串，Expires 也带逗号，不能可靠反解。
 */
function readSetCookieLines(headers: Headers): string[] {
  const withGetter = headers as { getSetCookie?: () => string[] }
  return typeof withGetter.getSetCookie === 'function' ? withGetter.getSetCookie() : []
}

/**
 * 执行器 Session → mtop 会话参数。
 * onSessionUpdate 只在凭据层可写时才带上，这样「刷新后回写不了」会在通道层被识别成不刷新，
 * 而不是刷新完悄悄丢掉新令牌。
 */
function mtopSession(session: Session): Pick<MtopCallOptions, 'session' | 'onSessionUpdate'> {
  return {
    session: {
      cookies: session.cookies,
      ...(session.deviceId === undefined ? {} : { deviceId: session.deviceId }),
    },
    ...(session.onSessionUpdate === undefined ? {} : { onSessionUpdate: session.onSessionUpdate }),
  }
}

/** 基于全局 fetch 的 mtop 传输层；超时由 callMtop 合并的 AbortSignal 负责。 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): MtopTransport {
  return {
    async request(request: MtopHttpRequest): Promise<MtopHttpResponse> {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        body: request.body,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      const response = await fetchImpl(request.url, init)
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      const setCookie = readSetCookieLines(response.headers)
      return {
        status: response.status,
        headers,
        text: await response.text(),
        ...(setCookie.length === 0 ? {} : { setCookie }),
      }
    },
  }
}

export interface PublishPortOptions {
  /** 必须显式为 true 才允许队列任务真提交；false 且未开 dryRun 时一律 UNSUPPORTED。 */
  submit: boolean
  /** 只填表、不点提交（队列链路真机校准用）；开它不要求 submit，也不产出 itemId。 */
  dryRun?: boolean
  /** Chrome DevTools 端口，默认 channel-cdp 的 DEFAULT_PORT（9222）。 */
  chromePort?: number
  /** 每步截图目录；真机校准时必开，便于对着截图修选择器。 */
  screenshotsDir?: string
  /** 发布实现；测试注入假实现，生产用 publishViaCdp。 */
  run?: (input: PublishViaCdpInput) => Promise<PublishViaCdpResult>
}

export interface OperationPortOptions {
  /** 传输层；测试注入 fake，生产用 createFetchTransport()。 */
  transport?: MtopTransport
  /** 发布时间戳注入（毫秒），测试用。 */
  now?: () => number
  /** 未实现通道的提示前缀（写进错误信息，便于用户知道该等哪个版本）。 */
  pendingHint?: string
  /** 发布通道配置；缺省时 publish 仍是 UNSUPPORTED（安全默认）。 */
  publish?: PublishPortOptions
}

/**
 * 构造 OperationPort。
 * 注意：publish/deliver/reply 是有意的 UNSUPPORTED 占位，worker 会按"不可重试"处理成 needs_review，
 * 不会反复重试消耗账号写入配额。
 */
export function createOperationPort(options: OperationPortOptions = {}): OperationPort {
  const transport = options.transport ?? createFetchTransport()
  const now = options.now ?? ((): number => Date.now())
  const hint = options.pendingHint ?? '该通道将在 P1.2/P2 落地'

  return {
    async fetchItemDetail(input: { session: Session; itemId: string; signal: AbortSignal }): Promise<DetailSnapshot> {
      const raw = await callMtop(transport, {
        api: MTOP_APIS.detail,
        data: buildItemDetailData({ itemId: input.itemId }),
        ...mtopSession(input.session),
        signal: input.signal,
      })
      const summary = parseItemDetail(raw, input.session.accountId, now())
      return { itemId: summary.itemId, title: summary.title, priceCents: summary.priceCents, state: summary.state }
    },

    async polishItem(input: { session: Session; itemId: string; signal: AbortSignal }): Promise<void> {
      await callMtop(transport, {
        api: MTOP_APIS.polish,
        version: MTOP_API_VERSIONS.polish,
        data: buildPolishData({ itemId: input.itemId }),
        ...mtopSession(input.session),
        signal: input.signal,
      })
    },

    async publishItem(input: {
      session: Session
      draft: PublishDraft
      signal: AbortSignal
      onStep?: (step: string, message: string) => void
    }): Promise<{ itemId?: string }> {
      const publish = options.publish
      const dryRun = publish?.dryRun === true
      if (publish === undefined || (!publish.submit && !dryRun)) {
        fail(
          'UNSUPPORTED',
          '发布通道未开启：' + hint + '（校准队列链路设 BF_PUBLISH_DRYRUN=1 只填表；确认后设 BF_PUBLISH_SUBMIT=1 才会真发布）',
        )
      }
      // dryRun 优先：即使同时给了 submit，也绝不点提交（真机校准阶段防误发）。
      const submit = publish.submit && !dryRun
      const runner = publish.run ?? publishViaCdp
      const result = await runner({
        draft: input.draft,
        accountId: input.session.accountId,
        submit,
        ...(publish.chromePort === undefined ? {} : { chromePort: publish.chromePort }),
        ...(publish.screenshotsDir === undefined ? {} : { screenshotsDir: publish.screenshotsDir }),
        ...(input.onStep === undefined ? {} : { onLog: input.onStep }),
        signal: input.signal,
      })
      if (submit && result.itemId === undefined) fail('INTERNAL', 'CDP 发布返回成功但没有 itemId，按失败处理')
      return result.itemId === undefined ? {} : { itemId: result.itemId }
    },

    async verifySession(input: { session: Session }): Promise<void> {
      // 缺 unb 时 head 接口即使成功也证明不了「人已登录」：账号摘要同样把无 unb 视为不可用。
      const unb = input.session.cookies['unb']
      if (typeof unb !== 'string' || unb.trim().length === 0) {
        fail('VALIDATION', '凭据里没有 unb，无法校验登录态')
      }
      // head 接口不产生业务副作用，适合作为登录态探针；令牌过期由 callMtop 统一刷新回写。
      await callMtop(transport, {
        api: USER_MTOP_APIS.head,
        data: buildUserHeadData({ userId: unb }),
        ...mtopSession(input.session),
      })
    },

    async deliverOrder(): Promise<{ delivered: boolean }> {
      fail('UNSUPPORTED', '自动发货通道尚未接入：' + hint + '（IM 协议 + 卡密规则引擎）')
    },

    async sendReply(): Promise<void> {
      fail('UNSUPPORTED', 'IM 回复通道尚未接入：' + hint + '（wss-goofish 握手与心跳，见 docs/im-protocol.md）')
    },
  }
}

/** 读出 mtop 响应里的 ret（测试与诊断用）；非对象返回 undefined。 */
export function readMtopRet(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const ret = (raw as Record<string, unknown>)['ret']
  if (!Array.isArray(ret)) return undefined
  const first = ret[0]
  return typeof first === 'string' ? first : undefined
}

/** 断言通道错误码可被 daemon 白名单接受（开发期自检用）。 */
export function assertSupportedChannelError(error: unknown): XianyuError {
  if (error instanceof XianyuError) return error
  return new XianyuError({ code: 'INTERNAL', message: '通道抛出了非 XianyuError 的异常', details: {} })
}
