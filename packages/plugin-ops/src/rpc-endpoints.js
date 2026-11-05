/**
 * rpc 端点实现：输入是已按白名单校验过的 payload，输出直接交给 daemon 客户端（或本地设置/进程管理）。
 * 只做「拼请求 + 形状收敛」，业务校验留给 daemon；端点表与 confirm 门禁在 rpc.js。
 * 从 rpc.js 拆出（2026-10-24，守 AGENTS §3「文件 ≤400 行」）。
 *
 * @module @bigfish/plugin-ops/rpc-endpoints
 */
import {
  ACCOUNT_ID_RE,
  BATCH_ID_RE,
  LOGIN_TIMEOUT_MAX_MS,
  LOGIN_REQUEST_MARGIN_MS,
  IMPORT_TIMEOUT_MS,
  VERIFY_REQUEST_TIMEOUT_MS,
  isRecord,
  bad,
  readRequiredString,
  readOptionalString,
  readOptionalPort,
  readIntegerValue,
  readEnqueueItems,
} from './rpc-schema.js'

/** 串行入队：单账号写串行（AGENTS §1.3），并发 enqueue 会让去重与 availableAt 交错。 */
async function enqueueSequentially(client, items, batchId) {
  const results = []
  for (const item of items) {
    results.push(await client.enqueue(batchId === undefined ? item : { ...item, batchId }))
  }
  return results
}

function extractTask(result) {
  return isRecord(result) && isRecord(result.task) ? result.task : result
}

function extractCreated(result) {
  return isRecord(result) && typeof result.created === 'boolean' ? result.created : null
}

function summarizeEnqueue(batchId, results) {
  return {
    batchId: batchId === undefined ? null : batchId,
    tasks: results.map(extractTask),
    created: results.map(extractCreated),
  }
}

function storeMethod(settingsStore, primary, fallback) {
  if (settingsStore === undefined || settingsStore === null) return undefined
  for (const name of [primary, fallback]) {
    if (typeof settingsStore[name] === 'function') return settingsStore[name].bind(settingsStore)
  }
  return undefined
}

export function readSettingsEndpoint(settingsStore, client) {
  const read = storeMethod(settingsStore, 'read', 'get')
  if (read !== undefined) return read()
  // daemon 侧 GET /settings（lead 负责接线）；客户端还没加同名方法时走通用 request。
  return client.request('/settings')
}

export function writeSettingsEndpoint(settingsStore, client, patch) {
  const write = storeMethod(settingsStore, 'write', 'update')
  if (write !== undefined) return write(patch)
  return client.request('/settings', { method: 'PUT', body: patch })
}

export function retryTaskEndpoint(client, id) {
  if (typeof client.retryTask === 'function') return client.retryTask(id)
  return client.request('/tasks/' + encodeURIComponent(id) + '/retry', { method: 'POST' })
}

/**
 * 人工收尾（ack / fail / release）。
 *
 * owner 的坑：daemon 的 worker 用 `daemon-<pid>` 当租约持有者（runtime.ts），重启就变；
 * 面板猜不到。所以不传 owner 时先读一次任务拿真实 leaseOwner——读不到才交给 daemon 报冲突。
 * 这条逻辑与工具层 xy_task_action 一致，否则「面板能收尾、工具不能」会再次分裂。
 */
export async function taskActionEndpoint(client, body) {
  const id = readRequiredString(body, 'id', /^[A-Za-z0-9._:-]{1,128}$/)
  const action = readRequiredString(body, 'action', /^(ack|fail|release)$/)
  let owner = typeof body.owner === 'string' && body.owner !== '' ? body.owner : undefined
  if (owner === undefined && typeof client.getTask === 'function') {
    const current = await client.getTask(id).catch(() => undefined)
    if (isRecord(current) && typeof current.leaseOwner === 'string' && current.leaseOwner !== '') owner = current.leaseOwner
  }
  const payload = {
    ...(owner === undefined ? {} : { owner }),
    ...(typeof body.error === 'string' ? { error: body.error } : {}),
    ...(body.nonRetryable === true ? { nonRetryable: true } : {}),
  }
  return client.taskAction(id, action, payload)
}

/** 熔断复位：daemon 侧 POST /circuits/reset；客户端没有专用方法时走通用 request。 */
export function resetCircuitEndpoint(client, accountId) {
  if (typeof client.resetCircuit === 'function') return client.resetCircuit(accountId)
  return client.request('/circuits/reset', { method: 'POST', body: { accountId } })
}

export function getBatchEndpoint(client, id) {
  if (typeof client.getBatch === 'function') return client.getBatch(id)
  return client.request('/batches/' + encodeURIComponent(id))
}

/** 托管浏览器状态：纯只读探测，面板每 3 秒轮询一次也不会产生闲鱼请求。 */
export function browserStatusEndpoint(client) {
  if (typeof client.browserStatus === 'function') return client.browserStatus()
  return client.request('/browser')
}

export function importAccountEndpoint(client, body) {
  const input = {}
  const accountId = readOptionalString(body, 'accountId', 64)
  if (accountId !== undefined) {
    if (!ACCOUNT_ID_RE.test(accountId)) bad('accountId 格式非法：' + accountId.slice(0, 40))
    input.accountId = accountId
  }
  const port = readOptionalPort(body)
  if (port !== undefined) input.port = port
  if (typeof client.importAccount === 'function') return client.importAccount(input)
  return client.request('/accounts/import', { method: 'POST', body: input, timeoutMs: IMPORT_TIMEOUT_MS })
}

export function loginAccountEndpoint(client, body) {
  const input = {}
  const accountId = readOptionalString(body, 'accountId', 64)
  if (accountId !== undefined) {
    if (!ACCOUNT_ID_RE.test(accountId)) bad('accountId 格式非法：' + accountId.slice(0, 40))
    input.accountId = accountId
  }
  const port = readOptionalPort(body)
  if (port !== undefined) input.port = port
  if (body.timeoutMs !== undefined) input.timeoutMs = readIntegerValue(body.timeoutMs, 'timeoutMs', 1, LOGIN_TIMEOUT_MAX_MS)
  if (typeof client.loginAccount === 'function') return client.loginAccount(input)
  const timeoutMs = (input.timeoutMs === undefined ? LOGIN_TIMEOUT_MAX_MS : input.timeoutMs) + LOGIN_REQUEST_MARGIN_MS
  return client.request('/accounts/login', { method: 'POST', body: input, timeoutMs })
}

/**
 * 登录态校验：accountId 必填，daemon 返回 AccountSessionState
 * （online / checkedAt / refreshed / code+message），面板据此显示「在线 / 已过期 / 无法确认」。
 */
export function verifyAccountEndpoint(client, body) {
  const accountId = readRequiredString(body, 'accountId', ACCOUNT_ID_RE)
  if (typeof client.verifyAccount === 'function') return client.verifyAccount(accountId)
  const path = '/accounts/' + encodeURIComponent(accountId) + '/verify'
  return client.request(path, { method: 'POST', body: {}, timeoutMs: VERIFY_REQUEST_TIMEOUT_MS })
}

export function activateAccountEndpoint(client, body) {
  const accountId = readRequiredString(body, 'accountId', ACCOUNT_ID_RE)
  if (typeof client.activateAccount === 'function') return client.activateAccount(accountId)
  return client.request('/accounts/activate', { method: 'POST', body: { accountId } })
}

export function logoutAccountEndpoint(client, body) {
  const accountId = readRequiredString(body, 'accountId', ACCOUNT_ID_RE)
  if (typeof client.logoutAccount === 'function') return client.logoutAccount(accountId)
  return client.request('/accounts/' + encodeURIComponent(accountId) + '/logout', { method: 'POST', body: {} })
}

export function enqueueBatchEndpoint(client, body) {
  const batchId = readOptionalString(body, 'batchId', 64)
  if (batchId !== undefined && !BATCH_ID_RE.test(batchId)) bad('batchId 格式非法：' + batchId.slice(0, 40))
  const items = readEnqueueItems(body.items)
  return enqueueSequentially(client, items, batchId).then((results) => summarizeEnqueue(batchId, results))
}