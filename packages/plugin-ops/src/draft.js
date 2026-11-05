/**
 * 发布草稿的本地校验与命令拼装。
 *
 * 为什么插件侧还要校验一遍：草稿文件路径和字段来自模型/用户，属于不可信输入；
 * 在本地先挡住能判定的错误，比让 daemon 的 CDP 步骤机走到一半再炸要好排查。
 * 字段语义与 packages/daemon/src/cdp-publish.ts 的 parsePublishDraftFile 保持一致，
 * 但插件与 daemon 互不 import（AGENTS.md §2），所以这里是同构的独立实现。
 *
 * @module @bigfish/plugin-ops/draft
 */
import { readFile } from 'node:fs/promises'
import { DaemonError } from './client.js'

const SHIPPING_VALUES = new Set(['free', 'none'])

function invalid(message) {
  return new DaemonError('VALIDATION', message)
}

function optionalString(record, key, label) {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid('草稿的 ' + label + ' 必须是字符串')
  return value
}

function readImages(record) {
  const value = record.images
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('草稿的 images 必须是非空数组（本机图片的绝对路径）')
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item === '') throw invalid('草稿的 images[' + String(index) + '] 必须是非空字符串')
    // daemon 只接受绝对路径：POSIX 以 / 开头，Windows 是盘符 + 分隔符。
    if (!item.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(item)) {
      throw invalid('草稿的 images[' + String(index) + '] 必须是绝对路径：' + item)
    }
    return item
  })
}

function readPriceCents(record) {
  const value = record.priceCents
  // 金额一律整数分；浮点价格会让后续 mtop 字段出现小数误差。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid('草稿的 priceCents 必须是正整数（单位：分）')
  }
  return value
}

/** 校验已 JSON.parse 的草稿对象，返回规范化后的草稿（未知字段丢弃）。 */
export function validatePublishDraft(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('草稿必须是 JSON 对象')
  }
  const record = raw
  const desc = record.desc
  if (typeof desc !== 'string' || desc.trim() === '') throw invalid('草稿的 desc 必须是非空字符串')
  const title = optionalString(record, 'title', 'title') ?? ''
  const priceCents = readPriceCents(record)
  const images = readImages(record)
  const quantity = record.quantity
  if (quantity !== undefined && (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0)) {
    throw invalid('草稿的 quantity 若填写必须是正整数')
  }
  const shipping = optionalString(record, 'shipping', 'shipping')
  if (shipping !== undefined && !SHIPPING_VALUES.has(shipping)) {
    throw invalid("草稿的 shipping 只能是 'free' 或 'none'")
  }
  const pricingMode = optionalString(record, 'pricingMode', 'pricingMode')
  const address = optionalString(record, 'address', 'address')
  // 分类是闲鱼网页端的硬限制来源：类目选错会被判「网页版暂不支持发布此分类」。
  // 这里只校验类型，真正的可选性由发布页当前版本决定（见 docs/architecture.md §13.5）。
  const category = optionalString(record, 'category', 'category')
  return { title, desc, priceCents, images, quantity, shipping, pricingMode, address, category }
}

/** 读文件 + 解析 + 校验；readFileImpl 可注入，测试不需要真的落盘。 */
export async function loadPublishDraft(path, readFileImpl = readFile) {
  let text
  try {
    text = await readFileImpl(path, 'utf8')
  } catch (cause) {
    // 实测最常见的失败原因是传了相对路径：插件进程的 cwd 不是仓库根目录，
    // 原先只说「检查路径是否存在」会让人反复确认文件明明在那儿。
    const hint = /^([A-Za-z]:[\\/]|\/)/.test(path)
      ? '检查路径是否存在、是否有读权限'
      : '这条是相对路径，插件进程的工作目录不是仓库根目录——请改传绝对路径'
    throw new DaemonError('VALIDATION', '读不到草稿文件：' + path + '（' + hint + '）', { cause })
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    throw new DaemonError('VALIDATION', '草稿文件不是合法 JSON：' + path, { cause })
  }
  return validatePublishDraft(raw)
}

/** 给模型/人看的一行行摘要（价格只在展示时除以 100，不参与计算）。 */
export function describeDraft(draft) {
  const lines = [
    '标题：' + (draft.title === '' ? '（空，入队发布前必须补）' : draft.title),
    '价格：¥' + (draft.priceCents / 100).toFixed(2) + '（' + String(draft.priceCents) + ' 分）',
    '图片：' + String(draft.images.length) + ' 张',
    '描述：' + String(draft.desc.length) + ' 字',
  ]
  if (draft.category !== undefined) lines.push('分类：' + draft.category + '（发布时会按下拉选项实际点选）')
  if (draft.quantity !== undefined) lines.push('数量：' + String(draft.quantity) + ' 件（CDP 步骤机尚未接入数量）')
  if (draft.shipping !== undefined) lines.push('运费：' + (draft.shipping === 'free' ? '包邮' : '不包邮'))
  return lines
}

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    // 32 位乘法必须用 Math.imul，直接 * 会超过 2^53 丢精度。
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 按草稿内容生成发布幂等键：同一份草稿重复入队只会留一条任务。
 *
 * accountId 必须进 canonical：daemon 的 `dedupe_key` 是**全局唯一**的
 * （`packages/core/src/store.ts:38`），不带账号时「A 号发过这个商品」会把
 * 「B 号也想发同样的商品」判成重复而静默丢弃——多账号场景下这是数据丢失。
 *
 * @param {object} draft - validatePublishDraft 的结果。
 * @param {string} [accountId] - 发布用的账号 id；缺省时按 null 参与哈希（向后兼容旧键）。
 */
export function draftDedupeKey(draft, accountId) {
  const canonical = JSON.stringify([
    accountId ?? null,
    draft.title,
    draft.desc,
    draft.priceCents,
    draft.images,
    draft.quantity ?? null,
    draft.shipping ?? null,
    draft.pricingMode ?? null,
    draft.address ?? null,
    draft.category ?? null,
  ])
  return 'publish:' + fnv1a(canonical)
}

function quoteCliArg(value) {
  // Windows 的 cmd/pwsh 只要路径含空格就必须整体加引号；不含空格时保持原样更好读。
  return /[\s"]/u.test(value) ? '"' + value.replaceAll('"', '\\"') + '"' : value
}

/** 拼 daemon 发布 CLI 命令；本函数只产文本，不执行任何东西。 */
export function buildPublishCommand(input) {
  const parts = ['pnpm daemon:publish', '--', '--draft', quoteCliArg(input.draftPath)]
  if (input.submit === true) parts.push('--submit')
  if (input.accountId !== undefined) parts.push('--account-id', quoteCliArg(input.accountId))
  if (input.chromePort !== undefined) parts.push('--chrome-port', String(input.chromePort))
  if (input.screenshotsDir !== undefined) parts.push('--screenshots', quoteCliArg(input.screenshotsDir))
  return parts.join(' ')
}
