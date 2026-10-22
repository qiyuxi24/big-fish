/**
 * 可持久化运营设置：文案风格、默认类目/地址、包邮方式、发布节流与批量上限、生图服务。
 *
 * 为什么不用 zod：仓库运行时零第三方依赖（ADR 0002），这里手写窄化并复用 XianyuError，
 * 让 daemon 路由、插件工具与面板共用同一套默认值与校验语义，避免三处各写一份常量。
 * @module @bigfish/core/settings
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { XianyuError, fail } from './errors.ts'

/** 文案风格，与 plugin-ops 的 COPY_STYLES 同 id（插件侧是纯 JS，只能靠测试对齐）。 */
export type CopyStyle = 'plain' | 'warm' | 'professional' | 'urgent' | 'story'

/** 包邮方式：free=卖家包邮，none=不包邮。 */
export type ShippingMode = 'free' | 'none'

/** 生图服务设置；默认关闭，endpointUrl/model 为空表示还没配。 */
export interface ImageProviderSettings {
  endpointUrl: string
  model: string
  enabled: boolean
}

/** 落盘设置全集；任何字段缺失时由 DEFAULT_SETTINGS 补齐。 */
export interface Settings {
  copyStyle: CopyStyle
  /** 默认类目文案（网页端发布页的可选项文案，合法集合由 channel-cdp 的类目矩阵决定）。 */
  defaultCategory: string
  /** 默认收货地址文案（发布页「所在地」输入）。 */
  defaultAddress: string
  shipping: ShippingMode
  /** 同一账号两次发布的间隔下限（毫秒），夹在 [30000, 3600000]。 */
  publishMinIntervalMs: number
  /** 单批最多草稿数，夹在 [1, 20]。 */
  maxBatchItems: number
  imageProvider: ImageProviderSettings
}

/**
 * 局部更新：字段都可缺省。imageProvider 允许只带要改的子字段，
 * 所以不直接复用 Partial<Settings>（那会要求整块对象齐全，没法做深合并）。
 */
export type SettingsPatch = Partial<Omit<Settings, 'imageProvider'>> & {
  imageProvider?: Partial<ImageProviderSettings>
}

/** 文案风格白名单；顺序即面板 chip 顺序。 */
export const COPY_STYLES: readonly CopyStyle[] = ['plain', 'warm', 'professional', 'urgent', 'story']

/** 包邮方式白名单。 */
export const SHIPPING_MODES: readonly ShippingMode[] = ['free', 'none']

/** 发布间隔允许范围（毫秒）。低于 30s 对平台不礼貌，高于 1h 等于没设置。 */
export const PUBLISH_MIN_INTERVAL_RANGE = { min: 30_000, max: 3_600_000 } as const

/** 单批上限允许范围；20 是网页端批量填表的实操上限（界面一次只排一页）。 */
export const MAX_BATCH_ITEMS_RANGE = { min: 1, max: 20 } as const

/** 未配置时的默认值：朴素文案、不指定类目/地址、包邮、3 分钟间隔、每批 20 条、不启用生图。 */
export const DEFAULT_SETTINGS: Settings = {
  copyStyle: 'plain',
  defaultCategory: '',
  defaultAddress: '',
  shipping: 'free',
  publishMinIntervalMs: 180_000,
  maxBatchItems: 20,
  imageProvider: { endpointUrl: '', model: '', enabled: false },
}

/**
 * 窄化一个未知值成设置补丁：未知字段忽略（向前兼容新面板），类型错抛 VALIDATION。
 * 数值字段按范围**夹取**而不是报错——设置面板拖到边界外不应该让整个保存失败。
 */
export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (!isRecord(value)) fail('VALIDATION', 'settings 必须是对象')
  const patch: SettingsPatch = {}
  for (const [key, raw] of Object.entries(value)) {
    // 显式 undefined 视作「没改」，让 { ...current, field: undefined } 这种写法继续可用。
    if (raw === undefined) continue
    if (key === 'copyStyle') patch.copyStyle = parseEnum('settings.copyStyle', raw, COPY_STYLES)
    else if (key === 'shipping') patch.shipping = parseEnum('settings.shipping', raw, SHIPPING_MODES)
    else if (key === 'defaultCategory') patch.defaultCategory = parseText('settings.defaultCategory', raw)
    else if (key === 'defaultAddress') patch.defaultAddress = parseText('settings.defaultAddress', raw)
    else if (key === 'publishMinIntervalMs') {
      patch.publishMinIntervalMs = clampInteger('settings.publishMinIntervalMs', raw, PUBLISH_MIN_INTERVAL_RANGE)
    } else if (key === 'maxBatchItems') {
      patch.maxBatchItems = clampInteger('settings.maxBatchItems', raw, MAX_BATCH_ITEMS_RANGE)
    } else if (key === 'imageProvider') patch.imageProvider = parseImageProvider(raw)
  }
  return patch
}

/** 把补丁合并到基线上；imageProvider 逐字段深合并，返回全新对象（不改 base）。 */
export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  return {
    copyStyle: patch.copyStyle ?? base.copyStyle,
    defaultCategory: patch.defaultCategory ?? base.defaultCategory,
    defaultAddress: patch.defaultAddress ?? base.defaultAddress,
    shipping: patch.shipping ?? base.shipping,
    publishMinIntervalMs: patch.publishMinIntervalMs ?? base.publishMinIntervalMs,
    maxBatchItems: patch.maxBatchItems ?? base.maxBatchItems,
    imageProvider: { ...base.imageProvider, ...(patch.imageProvider ?? {}) },
  }
}

/**
 * 读取设置文件；文件不存在返回默认值的副本（首次运行不该报错）。
 * 文件存在但内容非法时抛 STORAGE：说明文件被手改坏了，静默回落默认值会掩盖问题。
 */
export async function readSettingsFile(path: string): Promise<Settings> {
  const target = assertPath(path)
  let text: string
  try {
    text = await readFile(target, 'utf8')
  } catch (error) {
    if (isFsErrorCode(error, 'ENOENT')) return mergeSettings(DEFAULT_SETTINGS, {})
    throw new XianyuError({ code: 'STORAGE', message: 'settings 读取失败: ' + target, cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new XianyuError({ code: 'STORAGE', message: 'settings 文件不是合法 JSON: ' + target, cause: error })
  }
  try {
    return mergeSettings(DEFAULT_SETTINGS, parseSettingsPatch(parsed))
  } catch (error) {
    throw new XianyuError({ code: 'STORAGE', message: 'settings 文件内容非法: ' + target, cause: error })
  }
}

/**
 * 原子写设置：先写同目录唯一临时文件再 rename，进程中途被杀时不会留下半个 JSON。
 * 写入前先窄化一遍（夹取数值、丢掉未知字段），保证落盘内容一定能被读回。
 */
export async function writeSettingsFile(path: string, settings: Settings): Promise<void> {
  const target = assertPath(path)
  const normalized = mergeSettings(DEFAULT_SETTINGS, parseSettingsPatch(settings))
  const body = JSON.stringify(normalized, null, 2) + '\n'
  // 唯一临时名：并发保存时各自 rename，不会互相踩坏内容。
  const tmp = target + '.' + String(process.pid) + '.' + randomUUID() + '.tmp'
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, target)
  } catch (error) {
    try {
      await rm(tmp, { force: true })
    } catch {
      // 清理临时文件失败不能掩盖真正的写入错误。
    }
    throw new XianyuError({ code: 'STORAGE', message: 'settings 写入失败: ' + target, cause: error })
  }
}

function parseImageProvider(raw: unknown): Partial<ImageProviderSettings> {
  if (!isRecord(raw)) fail('VALIDATION', 'settings.imageProvider 必须是对象')
  const patch: Partial<ImageProviderSettings> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (key === 'endpointUrl') patch.endpointUrl = parseText('settings.imageProvider.endpointUrl', value)
    else if (key === 'model') patch.model = parseText('settings.imageProvider.model', value)
    else if (key === 'enabled') {
      if (typeof value !== 'boolean') fail('VALIDATION', 'settings.imageProvider.enabled 必须是布尔值')
      patch.enabled = value
    }
  }
  return patch
}

function parseText(label: string, raw: unknown): string {
  if (typeof raw !== 'string') fail('VALIDATION', label + ' 必须是字符串')
  return raw.trim()
}

function parseEnum<T extends string>(label: string, raw: unknown, allowed: readonly T[]): T {
  if (typeof raw !== 'string') fail('VALIDATION', label + ' 必须是字符串')
  const trimmed = raw.trim()
  if (!(allowed as readonly string[]).includes(trimmed)) {
    fail('VALIDATION', label + ' 必须是 ' + allowed.join('|') + ' 之一，实际为 "' + trimmed + '"')
  }
  return trimmed as T
}

function clampInteger(label: string, raw: unknown, range: { min: number; max: number }): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    fail('VALIDATION', label + ' 必须是整数')
  }
  return Math.min(range.max, Math.max(range.min, raw))
}

function assertPath(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') fail('VALIDATION', 'settings 路径不能为空')
  return resolve(path.trim())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFsErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
