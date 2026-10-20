/**
 * mtop 信封常量与默认请求头。
 *
 * APP_KEY / MTOP_HOST / 默认头取自 fancyboi999/goofish-cli（Apache-2.0）的
 * core/mtop.py 与网页端抓包；这里只保留只读通道用得到的部分。
 * @module @bigfish/channel-mtop/constants
 */

/** 闲鱼网页端 mtop 应用 key（抓包值，不是密钥）。 */
export const APP_KEY = '34839810'

/** mtop 网关地址，末尾不带斜杠。 */
export const MTOP_HOST = 'https://h5api.m.goofish.com'

/** 默认接口版本。 */
export const DEFAULT_VERSION = '1.0'

/** 默认推荐位参数；不同业务接口可覆盖。 */
export const DEFAULT_SPM_CNT = 'a21ybx.home.0.0'

/** 调用方没传 signal 时，callMtop 给单次请求设置的超时（毫秒），避免 IO 无限挂起。 */
export const DEFAULT_TIMEOUT_MS = 30_000

/** 网页端 UA；风控会交叉校验 UA 与 sec-ch-* 是否自洽。 */
export const MTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

/**
 * 默认请求头（键统一小写，方便与 fetch Headers 归一）。
 * 每次返回新对象：调用方可能按接口改写头，不能污染共享常量。
 */
export function defaultHeaders(): Record<string, string> {
  return {
    accept: 'application/json',
    'accept-language': 'en,zh-CN;q=0.9,zh;q=0.8,zh-TW;q=0.7,ja;q=0.6',
    'cache-control': 'no-cache',
    'content-type': 'application/x-www-form-urlencoded',
    origin: 'https://www.goofish.com',
    pragma: 'no-cache',
    priority: 'u=1, i',
    referer: 'https://www.goofish.com/',
    'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': MTOP_USER_AGENT,
  }
}
