/**
 * mtop 请求构造：URL / 查询参数 / 请求头 / 表单 body。
 *
 * 移植自 fancyboi999/goofish-cli（Apache-2.0）的 core/mtop.py：URL 形如
 * {MTOP_HOST}/h5/{api}/{version}/，t 用真实毫秒，body 是 form 字段 data=<紧凑 JSON>。
 * @module @bigfish/channel-mtop/request
 */
import { fail } from '@bigfish/core'
import { APP_KEY, DEFAULT_SPM_CNT, DEFAULT_VERSION, MTOP_HOST, defaultHeaders } from './constants.ts'
import { h5Token, signMtop } from './sign.ts'
import type { MtopCallOptions, MtopHttpRequest, MtopSession } from './types.ts'

/** 接口名/版本只允许 URL path 安全字符，避免拼出别的路径。 */
const API_PATTERN = /^[A-Za-z0-9._-]{1,120}$/
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/

/** 对象按紧凑 JSON 序列化；字符串视为调用方已序列化，不做二次包装。 */
function serializeData(data: unknown): string {
  if (typeof data === 'string') return data
  let text: string | undefined
  try {
    text = JSON.stringify(data)
  } catch (error) {
    return fail('VALIDATION', 'mtop data 无法序列化为 JSON', { cause: error })
  }
  if (text === undefined) {
    return fail('VALIDATION', 'mtop data 不支持序列化为 JSON（undefined/function/symbol）')
  }
  return text
}

/** cookie 表 → Cookie 请求头；空表返回空串，调用方不再设置该头。 */
function cookieHeader(cookies: Record<string, string>): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(cookies)) {
    if (name.length > 0 && typeof value === 'string') parts.push(name + '=' + value)
  }
  return parts.join('; ')
}

/** 组装 mtop 通用查询参数；extraParams 最后合并，同名覆盖。 */
function buildParams(
  api: string,
  version: string,
  t: number,
  sign: string,
  spmCnt: string,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const params: Record<string, string> = {
    jsv: '2.7.2',
    appKey: APP_KEY,
    t: String(t),
    sign,
    v: version,
    type: 'originaljson',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: '20000',
    api,
    sessionOption: 'AutoLoginOnly',
    spm_cnt: spmCnt,
  }
  if (extra === undefined) return params
  for (const [key, value] of Object.entries(extra)) {
    if (key.length === 0) return fail('VALIDATION', 'mtop extraParams 不允许空参数名')
    if (typeof value !== 'string') return fail('VALIDATION', 'mtop extraParams.' + key + ' 必须是字符串')
    params[key] = value
  }
  return params
}

/** 运行时防御：session / cookies 来自外部输入，可能是脏数据。 */
function requireSession(session: MtopSession): MtopSession {
  if (session === null || typeof session !== 'object') {
    fail('VALIDATION', 'mtop session 缺失')
  }
  const cookies = (session as { cookies?: unknown }).cookies
  if (cookies === null || typeof cookies !== 'object' || Array.isArray(cookies)) {
    fail('VALIDATION', 'mtop session.cookies 必须是 name→value 对象')
  }
  return session
}

/** 只构造请求，不发网络；签名 token 从 session.cookies 的 _m_h5_tk 取。 */
export function buildMtopRequest(opts: MtopCallOptions): MtopHttpRequest {
  if (opts === null || typeof opts !== 'object') fail('VALIDATION', 'mtop 调用参数必须是对象')
  const api = opts.api
  if (typeof api !== 'string' || !API_PATTERN.test(api)) {
    fail('VALIDATION', 'mtop api 非法（只允许字母数字与 . _ -）：' + String(api))
  }
  const version = opts.version ?? DEFAULT_VERSION
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    fail('VALIDATION', 'mtop version 非法：' + String(version))
  }
  const spmCnt = opts.spmCnt ?? DEFAULT_SPM_CNT
  if (typeof spmCnt !== 'string' || spmCnt.length === 0) {
    fail('VALIDATION', 'mtop spmCnt 必须是非空字符串')
  }
  const session = requireSession(opts.session)
  const t = opts.t ?? Date.now()
  if (!Number.isSafeInteger(t) || t <= 0) {
    fail('VALIDATION', 'mtop t 必须是正整数毫秒时间戳，收到：' + String(t))
  }
  const data = serializeData(opts.data)
  const token = h5Token(session.cookies)
  const sign = signMtop(token, t, data)
  const params = buildParams(api, version, t, sign, spmCnt, opts.extraParams)
  const url = MTOP_HOST + '/h5/' + api + '/' + version + '/?' + new URLSearchParams(params).toString()
  const headers = defaultHeaders()
  const cookie = cookieHeader(session.cookies)
  if (cookie.length > 0) headers.cookie = cookie
  const body = 'data=' + encodeURIComponent(data)
  return {
    url,
    method: 'POST',
    headers,
    body,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  }
}
