/**
 * 闲鱼链接 → 商品 id / 商家 id 的纯函数解析（零 IO、零网络）。
 *
 * 为什么要单独一层：链接可能来自网页地址栏、App 分享文案（带「【闲鱼】」前缀与说明文字）、
 * 甚至整段聊天记录。把「从文本里认出那是哪件商品/哪家店」收口到一处，面板、daemon 与
 * 工具都调同一份实现，避免各自写正则漂移。
 *
 * 平台事实（docs/p1.3-plan.md §2.1）：
 * - 商品：`https://www.goofish.com/item?id=<itemId>&categoryId=<cat>`
 * - 商家：`https://www.goofish.com/personal?userId=<sellerId>`（userId 就是商家唯一 ID）
 * - 短链 `m.tb.cn` / `e.tb.cn` 需要浏览器跳转才能展开，本模块**不做网络请求**，直接拒绝。
 * @module @bigfish/channel-mtop/link
 */
import { fail } from '@bigfish/core'

/** 解析结果：只有两种入口，不做「猜一个 id」。 */
export type XianyuLinkTarget =
  | { kind: 'item'; itemId: string; categoryId?: string }
  | { kind: 'seller'; sellerId: string }

/** 平台 id 都是纯数字（长度上限按 20 位给足够余量）。 */
const ID_PATTERN = /^\d{1,20}$/
/** 从分享文案里抠第一个 URL；中文标点与常见包裹符号都不属于 URL。 */
const URL_PATTERN = /https?:\/\/[^\s"'<>，。；、）)】\]]+/i
/** 需要浏览器跳转才能展开的短链域名。 */
const SHORT_LINK_HOSTS = new Set(['m.tb.cn', 'e.tb.cn', 'tb.cn'])
/** 只接受闲鱼自家域名：避免把任意链接的 ?id= 当成商品 id。 */
const TRUSTED_HOST_SUFFIXES = ['goofish.com', 'taobao.com']

function isTrustedHost(host: string): boolean {
  return TRUSTED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith('.' + suffix))
}

/** 优先 userId（商家主页），其次 id（商品）；两个都有时以商家为准。 */
function readId(url: URL, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = url.searchParams.get(name)
    if (raw === null) continue
    const value = raw.trim()
    if (ID_PATTERN.test(value)) return value
  }
  return undefined
}

/**
 * 从链接或分享文案里解析出商品 / 商家。
 *
 * 只认两类 query：`userId`（商家）与 `id`（商品）。纯数字输入会明确报错——
 * 数字本身无法区分「商品」与「商家」，让调用方分别传 itemId / sellerId 比猜错安全。
 */
export function parseXianyuLink(input: unknown): XianyuLinkTarget {
  if (typeof input !== 'string') fail('VALIDATION', '链接必须是字符串')
  const text = input.trim()
  if (text.length === 0) fail('VALIDATION', '链接不能为空')

  const matched = URL_PATTERN.exec(text)
  if (matched === null) {
    if (ID_PATTERN.test(text)) {
      fail('VALIDATION', '纯数字无法判断是商品还是商家：商品链接形如 …/item?id=<itemId>，商家链接形如 …/personal?userId=<sellerId>')
    }
    fail('VALIDATION', '没有在输入里找到链接：' + text.slice(0, 60))
  }
  const raw = matched[0]

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('VALIDATION', '链接格式非法：' + raw.slice(0, 60))
  }
  const host = url.hostname.toLowerCase()
  if (SHORT_LINK_HOSTS.has(host)) {
    fail('UNSUPPORTED', '短链 ' + host + ' 需要在浏览器打开后再粘贴展开后的完整链接（本模块不联网跳转）')
  }
  if (!isTrustedHost(host)) {
    fail('VALIDATION', '不是闲鱼/淘宝域名的链接：' + host.slice(0, 60))
  }

  const sellerId = readId(url, ['userId', 'sellerId'])
  if (sellerId !== undefined) return { kind: 'seller', sellerId }
  const itemId = readId(url, ['id', 'itemId'])
  if (itemId !== undefined) {
    const categoryId = readId(url, ['categoryId'])
    return { kind: 'item', itemId, ...(categoryId === undefined ? {} : { categoryId }) }
  }
  fail('VALIDATION', '链接里没有 userId（商家）也没有 id（商品）：' + raw.slice(0, 80))
}
