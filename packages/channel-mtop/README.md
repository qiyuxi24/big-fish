# @bigfish/channel-mtop

mtop 只读通道：签名、信封、ret 分类、cookie 归一。零第三方依赖，只用 node:crypto 与全局 fetch 类型。

契约：`docs/component-decomposition.md` §4.1。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/constants.ts` | `APP_KEY`、`MTOP_HOST`、默认版本/超时/UA、`defaultHeaders()` |
| `src/sign.ts` | `h5Token()` 取 `_m_h5_tk` 前段；`signMtop()` 算 md5 签名 |
| `src/request.ts` | `buildMtopRequest()` 拼 URL/12 个信封参数/Cookie/form body |
| `src/response.ts` | `parseSetCookie()` 剥属性；`parseMtopResponse()` 按 ret 分类 |
| `src/call.ts` | `callMtop()` 超时 + signal + HTTP 状态映射，只发一次请求 |

## 用法

```ts
import { callMtop, parseSetCookie } from '@bigfish/channel-mtop'

const transport = { request: (req: MtopHttpRequest) => fetch(req.url, req) }

const data = await callMtop(transport, {
  api: 'mtop.taobao.idle.pc.detail',
  version: '1.0',
  data: { itemId: '123' },
  session: { cookies: { _m_h5_tk: 'token_1700000000000' } },
})
```

## 约定与边界

- 签名必须用**毫秒** `t`：先截断到秒再乘 1000 会得到另一个签名，平台返回签名错误。
- `data` 为对象时按紧凑 JSON（无空格）参与签名；字符串则原样使用。
- `callMtop` 是纯函数，**不**把响应的 `Set-Cookie` 回写到 `session`；调用方需要时用 `parseSetCookie` 自行合并（`_m_h5_tk` 过期时尤其重要）。
- 失败一律抛 `@bigfish/core` 的 `XianyuError`（`RISK_CONTROL`/`AUTH_EXPIRED`/`NETWORK` 等稳定 code），错误消息不含 cookie/token 明文。
- 本包**不**发真实网络：`MtopTransport` 由调用方注入，测试用 fixture 回放。
