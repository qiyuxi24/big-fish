/**
 * 面板「进程管理」的 host 侧实现：启动（交给 supervisor）与停止（走 daemon 的 POST /shutdown）。
 * 单独成文件：rpc.js 只保留端点表与字段校验，进程控制有副作用（spawn / 轮询），分开放更好测。
 * @module @bigfish/plugin-ops/daemon-control
 */

/** 停止 daemon 后的存活探测：250ms 一次、最多 10 秒。 */
const STOP_POLL_INTERVAL_MS = 250
const STOP_POLL_TIMEOUT_MS = 10_000
const STOP_HEALTH_TIMEOUT_MS = 800

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 options 取 supervisor；没注入时给明确 UNSUPPORTED，而不是笼统的 INTERNAL。 */
export function requireSupervisor(supervisor) {
  if (supervisor === undefined || supervisor === null || typeof supervisor.ensure !== 'function') {
    const error = new Error('宿主没有注入 daemon 管理能力（没有可用的 supervisor）')
    error.code = 'UNSUPPORTED'
    throw error
  }
  return supervisor
}

/** 面板点「启动」：force 跳过冷却（人点了就要真试一次，不受 30 秒窗口限制）。 */
export function startDaemon(supervisor) {
  return requireSupervisor(supervisor).ensure('panel', { force: true })
}

/** 温和的 250ms 等待；不用 timers/promises，保持零依赖且便于测试注入。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 面板点「停止」：POST /shutdown → 轮询 /health 直到不可达。
 * 先探测一次：daemon 本来就停了就返回幂等成功，避免用户以为按钮坏了。
 *
 * @param {{request: (path: string, init?: object) => Promise<unknown>}} client - daemon 客户端。
 * @returns {Promise<{stopped: true, alreadyStopped: boolean}>} 停止结果。
 */
export async function stopDaemon(client) {
  try {
    await client.request('/health', { auth: false, timeoutMs: STOP_HEALTH_TIMEOUT_MS })
  } catch (error) {
    return { stopped: true, alreadyStopped: true }
  }
  try {
    await client.request('/shutdown', { method: 'POST', body: {}, timeoutMs: 5_000 })
  } catch (error) {
    // 202 发出后 daemon 会立刻关 listener，连接被断开属于预期；只有非网络错误才算失败。
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'UNKNOWN'
    if (code !== 'NETWORK') throw error
  }
  const deadline = Date.now() + STOP_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      await client.request('/health', { auth: false, timeoutMs: STOP_HEALTH_TIMEOUT_MS })
    } catch (error) {
      return { stopped: true, alreadyStopped: false }
    }
    await sleep(STOP_POLL_INTERVAL_MS)
  }
  const error = new Error('daemon 收到关停请求后 ' + String(STOP_POLL_TIMEOUT_MS) + ' 毫秒内没有退出，去数据目录看 daemon.log')
  error.code = 'INTERNAL'
  throw error
}
