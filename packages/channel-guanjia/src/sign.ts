/**
 * 闲管家签名算法。
 *
 * 移植自 xian-guanjia（MIT License, Copyright (c) 2025 thefreelight），
 * 原实现：research/repos/xian-guanjia/scripts/xian_guanjia.py:34-59。
 * 算法：sign = md5(`${appId},${appSecret},md5(body),${timestamp},${mchId},${mchSecret}`)
 * 其中 timestamp 为秒，body 为紧凑 JSON 字符串（空请求体用 "{}"）。
 * @module @bigfish/channel-guanjia
 */

import { createHash } from 'node:crypto'
import { XianyuError } from '@bigfish/core'
import type { GuanJiaCredentials, GuanJiaSignature } from './types.ts'

export function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

/**
 * 序列化请求体。签名与发送必须用同一份字节：
 * 原 Python 实现用 requests 的 json= 参数发送（会重新加空格），
 * 与参与签名的紧凑串不一致 —— 平台强校验会因此判定签名错误。
 */
export function canonicalJson(body: unknown): string {
  if (body === undefined || body === null) return '{}'
  const text = JSON.stringify(body)
  if (text === undefined) {
    throw new XianyuError({ code: 'VALIDATION', message: '闲管家请求体无法序列化为 JSON' })
  }
  return text
}

/** 校验凭据齐全；报错只提字段名，绝不回显密钥内容。 */
export function assertCredentials(credentials: GuanJiaCredentials): GuanJiaCredentials {
  for (const field of ['appId', 'appSecret', 'mchId', 'mchSecret'] as const) {
    const value: unknown = credentials[field]
    if (typeof value !== 'string' || value.length === 0) {
      throw new XianyuError({ code: 'VALIDATION', message: `闲管家凭据缺少字段：${field}` })
    }
  }
  return credentials
}

/** 计算签名；timestampSeconds 必须是整数秒。 */
export function computeSign(
  credentials: GuanJiaCredentials,
  bodyText: string,
  timestampSeconds: number
): string {
  const parts = [
    credentials.appId,
    credentials.appSecret,
    md5Hex(bodyText),
    String(timestampSeconds),
    credentials.mchId,
    credentials.mchSecret
  ]
  return md5Hex(parts.join(','))
}

/** 平台要求的四个鉴权头 + Content-Type。 */
export function signedHeaders(
  credentials: GuanJiaCredentials,
  timestampSeconds: number,
  sign: string
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-App-Id': credentials.appId,
    'X-Mch-Id': credentials.mchId,
    'X-Timestamp': String(timestampSeconds),
    'X-Sign': sign
  }
}

/** 组装完整签名（供客户端 sign() 与内部调用共用，避免两次序列化产生分歧）。 */
export function signRequest(
  credentials: GuanJiaCredentials,
  bodyText: string,
  timestampSeconds: number
): GuanJiaSignature {
  const sign = computeSign(credentials, bodyText, timestampSeconds)
  return {
    timestamp: timestampSeconds,
    sign,
    headers: signedHeaders(credentials, timestampSeconds, sign)
  }
}
