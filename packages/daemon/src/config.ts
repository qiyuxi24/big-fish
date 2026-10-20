/**
 * daemon 侧的配置出口：复用 @bigfish/core 的 loadDaemonConfig，另加回环地址白名单。
 *
 * 为什么单独留一个文件：server 启动前必须确认绑定的 host 是回环地址（控制面不出本机），
 * 这个判断 CLI、server 与嵌入方都要用，放在配置模块免得各写一份字面量。
 * @module @bigfish/daemon/config
 */
export {
  DEFAULT_HOST,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PORT,
  defaultDataRoot,
  loadDaemonConfig,
} from '@bigfish/core'
export type { DaemonConfig, EnvLike, LogLevel } from '@bigfish/core'

/** 允许绑定的回环地址白名单；不做解析，只做白名单（含 localhost 与 IPv6 回环）。 */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1']

/** 是否回环地址。 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host)
}
