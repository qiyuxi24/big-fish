/**
 * daemon 侧的设置存储：把 core 的读写函数包成一个「串行化」的小接口。
 *
 * 为什么放 daemon 而不是 core：core 只提供「读写某个路径」的纯函数；
 * 路径由 daemon 的数据目录决定，并发 PUT 的读-改-写竞态也必须在这里收口。
 * @module @bigfish/daemon/settings
 */
import { mergeSettings, parseSettingsPatch, readSettingsFile, writeSettingsFile } from '@bigfish/core'
import type { Settings } from '@bigfish/core'

/** 设置存储能力；路由只依赖这两个方法，测试可注入假实现。 */
export interface SettingsStore {
  /** 读当前设置；文件不存在时返回默认值副本。 */
  get(): Promise<Settings>
  /** 按补丁更新并落盘，返回更新后的完整设置。校验失败抛 VALIDATION。 */
  update(patch: unknown): Promise<Settings>
}

/**
 * 建设置存储。所有读写走同一条 Promise 链：两次并发 PUT 不会互相覆盖
 * （各自读到的都是前一次写完的结果），代价是设置保存被串行化——它本来就低频。
 */
export function createSettingsStore(path: string): SettingsStore {
  let tail: Promise<unknown> = Promise.resolve()
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task)
    // tail 只用来排队，失败已经由 next 交给调用方；这里吞掉避免 unhandled rejection。
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  return {
    get: () => serially(() => readSettingsFile(path)),
    update: (patch) =>
      serially(async () => {
        const current = await readSettingsFile(path)
        const next = mergeSettings(current, parseSettingsPatch(patch))
        await writeSettingsFile(path, next)
        return next
      }),
  }
}
