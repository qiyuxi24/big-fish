import { XianyuError } from '@bigfish/core'
import { GuanJiaClient } from '../src/client.ts'
import type {
  GuanJiaCredentials,
  GuanJiaTransport,
  GuanJiaTransportRequest,
  GuanJiaTransportResponse
} from '../src/types.ts'

/** 记录下来的请求，供断言 path / headers / body。 */
export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export type Responder = (
  request: CapturedRequest
) => GuanJiaTransportResponse | Promise<GuanJiaTransportResponse>

export interface FakeTransport {
  transport: GuanJiaTransport
  requests: CapturedRequest[]
}

export function createFakeTransport(responder: Responder): FakeTransport {
  const requests: CapturedRequest[] = []
  const transport: GuanJiaTransport = {
    async request(req: GuanJiaTransportRequest): Promise<GuanJiaTransportResponse> {
      const captured: CapturedRequest = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body
      }
      requests.push(captured)
      return responder(captured)
    }
  }
  return { transport, requests }
}

export const TEST_CREDENTIALS: GuanJiaCredentials = {
  appId: 'app',
  appSecret: 'sec',
  mchId: '1001',
  mchSecret: 'msec'
}

export const TEST_BASE_URL = 'https://open.goofish.pro'
export const TEST_NOW = 1724414553000

export function okReply(data: unknown = null): GuanJiaTransportResponse {
  return { status: 200, text: JSON.stringify({ code: 0, msg: 'ok', data }) }
}

export function envelopeReply(code: number, msg: string, data: unknown = null): GuanJiaTransportResponse {
  return { status: 200, text: JSON.stringify({ code, msg, data }) }
}

export function createClient(
  transport: GuanJiaTransport,
  now: () => number = () => TEST_NOW,
  baseUrl?: string
): GuanJiaClient {
  if (baseUrl === undefined) {
    return new GuanJiaClient({ credentials: TEST_CREDENTIALS, transport, now })
  }
  return new GuanJiaClient({ credentials: TEST_CREDENTIALS, transport, now, baseUrl })
}

/** 同步抛错场景：断言拿到的是 XianyuError。 */
export function captureError(run: () => unknown): XianyuError {
  try {
    run()
  } catch (error) {
    if (error instanceof XianyuError) return error
    throw error
  }
  throw new Error('unreachable: 期望抛出 XianyuError')
}

/** 异步失败场景：断言拿到的是 XianyuError。 */
export async function captureRejection(run: () => Promise<unknown>): Promise<XianyuError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof XianyuError) return error
    throw error
  }
  throw new Error('unreachable: 期望抛出 XianyuError')
}
