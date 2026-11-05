/**
 * client ↔ host rpc 桥：面板（client bundle）经宿主通道请求「读数据 / 触发动作」。
 * 为什么要这一层：
 * - client bundle 不能 fetch、不能读文件（AGENTS §4），面板要看实时队列/账号/批次只能经宿主；
 * - 宿主给第三方插件唯一受支持的通道是 \`ctx.connection.rpc.handle(频道, handler)\`，
 *   不能复用 /api（DSH Gateway 已占用，rpc.intercept 会抛错，见 docs/adr/0004）；
 * - 边界在这一层：daemon HTTP 调用、字段白名单、写操作 confirm 全部留在 host，
 *   面板永远拿不到 cookie / token，也拼不出白名单之外的请求。
 * handler 永不抛错：成功 \`{ok:true,value}\`，失败 \`{ok:false,error:{code,message,details?}}\`。
 * 端点白名单与 payload 形状见 docs/adr/0004-client-host-rpc.md（client 侧按同一份契约调用）。
 *
 * @module @bigfish/plugin-ops/rpc
 */
import { listCategoryTemplates } from './category-templates.js'
import { startDaemon, stopDaemon } from './daemon-control.js'
import {
  ID_RE,
  ACCOUNT_ID_RE,
  isRecord,
  failEnvelope,
  needsConfirm,
  errorEnvelope,
  readRequiredString,
  readIntegerValue,
  readTaskFilter,
  readItemsFilter,
  readEventFilter,
  readReferenceInput,
  readMarketBriefInput,
  readItemId,
  readLinkInput,
  readSellerCollectInput,
  readSettingsPatch,
} from './rpc-schema.js'
import {
  readSettingsEndpoint,
  writeSettingsEndpoint,
  retryTaskEndpoint,
  taskActionEndpoint,
  resetCircuitEndpoint,
  getBatchEndpoint,
  browserStatusEndpoint,
  importAccountEndpoint,
  loginAccountEndpoint,
  verifyAccountEndpoint,
  activateAccountEndpoint,
  logoutAccountEndpoint,
  enqueueBatchEndpoint,
} from './rpc-endpoints.js'

/**
 * 自定义 rpc 频道。不能用 '/api'：DSH Gateway 已把它注册成 interceptor，
 * 再 rpc.intercept('/api') 会直接抛「channel already has an interceptor」。
 */
export const RPC_CHANNEL = '/bigfish'


/** 默认端点表；handler 只做「白名单字段 → 形状校验 → daemon 调用」，业务校验留给 daemon。 */
function createDefaultHandlers(options) {
  const client = options.client
  const settingsStore = options.settingsStore
  return {
    health: () => client.health(),
    status: () => client.status(),
    // 托管浏览器状态：只读，不挂 confirm（面板进账号 tab 就能看到窗口在不在）。
    'browser.status': () => browserStatusEndpoint(client),
    accounts: () => client.listAccounts(),
    // 快照过滤必须透传：daemon 的 GET /items 一直支持 state/accountId/limit，
    // 但以前这里固定调 client.listItems()，面板拿不到「只属于当前账号」的商品。
    'items.list': (body) => client.listItems(readItemsFilter(body)),
    // 面板「文案」tab 的品类模板：纯常量、不碰 daemon，也不写任何状态。
    'copy.templates': () => listCategoryTemplates(),
    'tasks.list': (body) => client.listTasks(readTaskFilter(body)),
    // 面板工作流树：只读增量拉取，since 游标由客户端持有（daemon 不记面板状态）。
    'events.list': (body) => client.listEvents(readEventFilter(body)),
    'tasks.retry': (body) => retryTaskEndpoint(client, readRequiredString(body, 'id', ID_RE)),
    // ack/fail/release 只流转本地队列（不触达闲鱼），但它们是「人在收尾」的动作：
    // 面板以前完全没有入口，只能让用户去敲 xy_task_action——侧边栏里读得到失败、却处理不了。
    'tasks.action': (body) => taskActionEndpoint(client, body),
    // 熔断复位：daemon 一直有这个端点（POST /circuits/reset），但 rpc 没接，
    // 于是「账号被熔断」只能等 10 分钟冷却，面板还写着「手动重置待 rpc 补」。
    'circuits.reset': (body) => resetCircuitEndpoint(client, readRequiredString(body, 'accountId', ACCOUNT_ID_RE)),
    'batches.get': (body) => getBatchEndpoint(client, readRequiredString(body, 'id', ID_RE)),
    'reference.collect': (body) => client.collectReferences(readReferenceInput(body)),
    // 市场简报：只读统计（已入库的他人商品），面板/工具用来定结构与定价。
    'market.brief': (body) => client.marketBrief(readMarketBriefInput(body)),
    // 采集模块：先解析链接（只读），再决定采谁 —— 面板两步走，用户能看清要采的是哪家店。
    'reference.parseLink': (body) => client.resolveLink(readLinkInput(body)),
    // 会写本地库：在 WRITE_ENDPOINTS 里，等 confirm:true。
    'seller.collect': (body) => client.collectSeller(readSellerCollectInput(body)),
    'sellers.list': () => client.listSellers(),
    'seller.items': (body) => client.listSellerItems(
      readItemId(body.sellerId),
      body.limit === undefined ? undefined : readIntegerValue(body.limit, 'limit', 1, 500),
    ),
    'settings.get': () => readSettingsEndpoint(settingsStore, client),
    'settings.put': (body) => writeSettingsEndpoint(settingsStore, client, readSettingsPatch(body.patch)),
    'accounts.import': (body) => importAccountEndpoint(client, body),
    'accounts.login': (body) => loginAccountEndpoint(client, body),
    // 只读探测（不写闲鱼、不写磁盘外的状态）：不挂 confirm，面板进 tab 可自动调用。
    'accounts.verify': (body) => verifyAccountEndpoint(client, body),
    // 切换当前账号只改本地设置（不触达闲鱼），因此不进 WRITE_ENDPOINTS；退出登录要 confirm。
    'accounts.activate': (body) => activateAccountEndpoint(client, body),
    'accounts.logout': (body) => logoutAccountEndpoint(client, body),
    'batch.enqueue': (body) => enqueueBatchEndpoint(client, body),
    // 面板「进程管理」按钮：start 让宿主拉起 daemon（跳过冷却，人点了就要试），
    // stop 是写操作（会打断在飞任务），因此挂在 WRITE_ENDPOINTS 后面等 confirm。
    'daemon.start': () => startDaemon(options.supervisor),
    'daemon.stop': () => stopDaemon(client),
  }
}

/** endpoints 选项：给嵌入方/测试覆盖或追加端点；只能传函数。 */
function readOverrides(raw) {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) throw new TypeError('createRpcBridge: endpoints 必须是对象')
  const overrides = {}
  for (const [name, handler] of Object.entries(raw)) {
    if (typeof handler !== 'function') throw new TypeError('createRpcBridge: endpoints.' + name + ' 必须是函数')
    overrides[name] = handler
  }
  return overrides
}

/**
 * 建 rpc 桥。
 *
 * @param {{client: object, settingsStore?: {read?: Function, get?: Function, write?: Function, update?: Function}, supervisor?: {ensure(reason?: string, options?: {force?: boolean}): Promise<object>}, endpoints?: Record<string, Function>}} options
 *   client 是 createDaemonClient 的返回值；settingsStore 可选（有它就不走 daemon HTTP）；
 *   supervisor 提供「启动 daemon」能力（面板按钮）；endpoints 覆盖默认表（测试/嵌入）。
 * @returns {{handle: (endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<{ok: boolean, value?: unknown, error?: {code: string, message: string, details?: object}}>, endpoints: readonly string[], channel: string}}
 */
export function createRpcBridge(options = {}) {
  if (!isRecord(options) || options.client === undefined || options.client === null || typeof options.client !== 'object') {
    throw new TypeError('createRpcBridge 需要 daemon 客户端（client）')
  }
  const handlers = {
    ...createDefaultHandlers({ client: options.client, settingsStore: options.settingsStore, supervisor: options.supervisor }),
    ...readOverrides(options.endpoints),
  }
  const endpoints = Object.freeze(Object.keys(handlers))

  async function handle(endpoint, payload, signal) {
    try {
      const handler = typeof endpoint === 'string' && Object.prototype.hasOwnProperty.call(handlers, endpoint) ? handlers[endpoint] : undefined
      if (handler === undefined) return failEnvelope('UNSUPPORTED', '不支持的 rpc endpoint：' + String(endpoint).slice(0, 80))
      const body = payload === undefined || payload === null ? {} : payload
      if (!isRecord(body)) return failEnvelope('VALIDATION', 'rpc payload 必须是对象')
      // 门禁按「这次调用到底写不写外部系统」判，而不是按端点名：
      // batch.enqueue 里 probe 是纯读，不该让它也点两次（见 rpc-schema.js 的 needsConfirm）。
      if (needsConfirm(endpoint, body) && body.confirm !== true) return failEnvelope('VALIDATION', '需要 confirm:true')
      return { ok: true, value: await handler(body, { signal }) }
    } catch (error) {
      return errorEnvelope(error)
    }
  }

  return { handle, endpoints, channel: RPC_CHANNEL }
}

