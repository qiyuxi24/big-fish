# 组件拆解与整合（P1.0）

> **状态更新（P1.1 完成后）**：本文 §5 里列为「留给 P1.1」的项，执行器已经落地（`probe/polish` 接 mtop 真实通道，
> `publish/deliver/reply` 显式 UNSUPPORTED）；发布字段完整映射与登录态导入 UI 顺延到 P1.2。当前实现形态以
> [architecture.md](architecture.md) 为准，本文保留拆解决策与接口契约。
>
> 目标：把调研过的小仓库**按功能拆开**，只把能合规复用、零依赖、可离线测试的部分整合进
> `packages/`，其余只留"思路记录"。本文是拆解结果 + 本期接口契约，实现见三个 channel 包。
> 依据：`research/notes/{A-cores,B-im,C-scraping}.md`、`docs/xianyu-4q-research.md`。

## 0. 实施状态（P1.0 已完成）

三个 channel 包已按 §4 契约落地。**当前全量口径**（以 [STATUS.md](STATUS.md) 为准）：`node scripts/test-all.mjs` = **779 tests / 779 pass（31 suites / 79 个测试文件）**，6 个 TS 包 tsc 0 错误（`plugin-ops` / `ops-bundle` 是纯 ESM JS，无 tsconfig，**不在类型检查覆盖内**）；当前形态以 [architecture.md](architecture.md) 与 [STATUS.md](STATUS.md) 为准。

| 包 | 条数 | 关键实现 | 偏差（已在包 README 记录） |
| --- | --- | --- | --- |
| `channel-mtop` | 29 | 12 个信封参数、毫秒 `t`、`body=data=<编码紧凑 JSON>`、fixture 回放 | `callMtop` 是纯函数、不回写 Set-Cookie；`deviceId` 预留未用 |
| `channel-cdp` | 33 | 连接/页面/启动/attach/步骤状态机；`captureJson` 等 `loadingFinished` 再取 body | 契约外加了**可选**注入点（webSocketFactory/fetchImpl/spawnImpl/env/pollMs），不传时行为一致 |
| `channel-guanjia` | 62 | MIT 移植：签名、20 方法、16 个平台码映射 | 平台原码放 `error.details.platformCode`（不改 core 契约）；`call` 未加 AbortSignal |

另外 `packages/core/src/risk.ts` 补了 `SIGN|签名` 关键词：mtop 的 `FAIL_SYS_API_SIGN_ERROR` 用下划线包住 `sign`，`\bsign\b` 匹配不到（原来会误分类成 UNKNOWN）。

## 1. 许可证闸门（先看这张表再决定能不能抄）

| 仓库 | 许可 | 能不能复制代码 |
| --- | --- | --- |
| fancyboi999/goofish-cli | **Apache-2.0** | ✅ 可移植（保留 NOTICE/版权声明，改动处注明） |
| thefreelight/xian-guanjia | **MIT** | ✅ 可移植（保留版权与许可声明） |
| dameng2026/xianyu-pilot-pro | Apache-2.0（但 130MB 商业版，含反检测浏览器） | ⚠️ 只取协议事实（backend 发布接口、x5sec 缓存），不移植代码 |
| xiaolu-ai26/XY-Agent、superboyyy/xianyu_spider、avehub/ai-goofish、fancyboi 之外的无 LICENSE 仓 | 无 LICENSE | ❌ 只借鉴流程，不复制 |
| MediaCrawler | NON-COMMERCIAL | ❌ 不复制 |
| XianyuAutoAgent(GPL-3.0)、xianyu-auto-reply(AGPL-3.0)、xianyu-super-butler(AGPL-3.0) | 传染 | ❌ 只借鉴思路 |

本仓是**闭源分发意向**，所以只允许 Apache-2.0 / MIT 的代码进入 `packages/`；
每个移植文件头写一句来源（仓库 + 文件 + 许可），改动处标 `// ported from ...`。

## 2. 小仓库 → 功能 → 归属

### 2.1 goofish-cli（Apache-2.0，867 行 Python，最值得整合）

| 功能（源文件） | 归属 | 动作 |
| --- | --- | --- |
| mtop 调用模板：URL/`t` 毫秒/params/data/sign（`core/mtop.py`） | `packages/channel-mtop` | **移植**（Node crypto + 结构化参数） |
| `ret` 分类：风控 / 登录态 / 签名 / 未找到（`_RISK_KEYWORDS` / `_AUTH_KEYWORDS`） | `packages/core/src/risk.ts` | 移植关键词表，映射到 `ErrorCode` |
| 限流：按账号 + 桶、60s 窗口、失败不退预算（`core/limiter.py`） | `core`（已有 `limiter.ts`） | 已实现，补"失败不退预算"用例 |
| 熔断：原子持久化 + 冷却 10 分钟（`core/guard.py`） | `core`（已有 `circuit.ts`） | 已实现，对齐 `circuit.json` 语义 |
| 浏览器 cookie 直读（`core/browser_cookie.py`） | **不移植** | Node 端读 Chrome `Cookies` 库要 DPAPI/AES，需原生模块或 `browser_cookie3` 等价物；改为 **CDP 导出 cookie**（`Network.getAllCookies`），见 2.2 |
| 发布流程 / 图片上传（`commands/item/publish.py`） | `packages/channel-mtop`（P1.1） | 只先落 **请求构造 + 字段校验**，真实调用留到 P1.2 |
| 风控红线文档（`skills/goofish-risk-guard/references/*.md`） | `packages/core/src/policy.ts`（`checkListing`） | 已提炼成发布前策略校验，进 daemon 执行器前置检查，见 [architecture.md](architecture.md) §6；原计划的独立 `docs/risk-control.md` 从未创建，别再引用 |

### 2.2 xian-guanjia（MIT，官方闲管家开放平台客户端）

| 功能（`scripts/xian_guanjia.py`） | 归属 | 动作 |
| --- | --- | --- |
| 签名 `md5(appId,appSecret,md5(body),ts,mchId,mchSecret)` + 4 个头 | `packages/channel-guanjia` | **移植**（Node crypto，`timestamp` 秒） |
| 20+ 接口封装（product / order / logistics / mch） | `packages/channel-guanjia` | 移植方法表 + 类型化参数校验；真实 HTTP 走可注入 transport |
| `code === 0` 成功、错误码表 | `packages/channel-guanjia` | 映射到 `XianyuError`，未知码保持 `UNKNOWN` 且带原码 |

### 2.3 XY-Agent（无 LICENSE）/ ai-goofish（无 LICENSE）/ xianyu_spider（无 LICENSE）

| 功能 | 归属 | 动作 |
| --- | --- | --- |
| 网页发布六步 + 成功判定（URL 含 `/item` 或「发布成功」） | `packages/channel-cdp` | **只借鉴流程**，自己写步骤状态机 |
| `page.expect_response` 直接吃 mtop XHR JSON（免签名读） | `packages/channel-cdp` | 借鉴思路，实现 `captureJsonResponses` |
| DrissionPage 接管真 Chrome（`--remote-debugging-port`） | `packages/channel-cdp` | 自己用 CDP 实现 |
| 纯 httpx mtop 直连 + `Set-Cookie` 域重写坑 | `packages/channel-mtop` | 借鉴坑位，自己实现 `parseSetCookie` |
| 类目上限（部分类目网页版不支持发布） | daemon 前置检查 | 记录为能力边界，不改代码 |

### 2.4 浏览器扩展两仓

采集插件与自动回复插件证明"MV3 能在 goofish.com 页面里读写"。本仓**不做扩展**：
CDP 接管真 Chrome 已覆盖同样能力，且扩展要用户长期装一个可疑扩展，体验更差。仅保留结论。

### 2.5 商业软件三包（易语言/ACF/PyQt6+阿奇索）

只借鉴四点：规则外置（Excel/JSON 规则表）、订单-商品映射表、每店铺凭据模型、凭证定期重取。
不借鉴：自建浏览器内核分发、VMProtect 加密、借第三方 SaaS 会话、搬运同行爆款。

## 3. 目标包边界（P1.0 新增）

```
packages/
  core/            已有：契约/错误/队列/限流/熔断/凭据/日志/配置   ← 增量：risk.ts
  channel-mtop/    mtop 只读通道：签名、信封、ret 分类、cookie 归一
  channel-cdp/     CDP 会话：连 Chrome、页面操作、响应拦截、步骤状态机
  channel-guanjia/ 闲管家开放平台客户端（MIT 移植）
  daemon/          已有：IPC 控制面                               ← P1.1 接执行器
  plugin-ops/      已有：14 个工具 + 侧边栏面板（6 个模块 tab）
  ops-bundle/      已有：bundle 组合
```

依赖方向：`core ← channel-*`、`core ← daemon`；**channel 包之间互不 import**，也都不 import daemon/plugin。
三个 channel 包都零第三方依赖、无构建（TS 直跑，Node 24 类型擦除）、**测试不发真实网络**。

## 4. 本期接口契约（三个包按此实现，互相不耦合）

### 4.1 `@bigfish/channel-mtop`

```ts
export const APP_KEY = '34839810'
export const MTOP_HOST = 'https://h5api.m.goofish.com'

/** 允许注入的传输层：真实实现用 fetch，测试用假实现。 */
export interface MtopTransport {
  request(req: MtopHttpRequest): Promise<MtopHttpResponse>
}
export interface MtopHttpRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}
export interface MtopHttpResponse {
  status: number
  headers: Record<string, string>
  text: string
}

export interface MtopSession {
  /** cookie 表：name → value */
  cookies: Record<string, string>
  /** 设备 id；缺省时用 accountId 派生（见下） */
  deviceId?: string
}

export interface MtopCallOptions {
  api: string                  // 如 'mtop.taobao.idle.pc.detail'
  version?: string             // 默认 '1.0'
  data: unknown                // 对象或字符串；对象按紧凑 JSON 序列化
  session: MtopSession
  t?: number                   // 毫秒；默认 Date.now()
  spmCnt?: string              // 默认 'a21ybx.home.0.0'
  extraParams?: Record<string, string>
  signal?: AbortSignal
}

/** 由 cookie 取 _m_h5_tk 的 '_' 前段；缺失抛 XianyuError(AUTH_EXPIRED)。 */
export function h5Token(cookies: Record<string, string>): string

/** md5(token + '&' + t + '&' + APP_KEY + '&' + data)，小写 hex。 */
export function signMtop(token: string, t: number, data: string): string

/** 只构造请求，不发网络。 */
export function buildMtopRequest(opts: MtopCallOptions): MtopHttpRequest

/** 解析 Set-Cookie 数组；返回 name→value（跨域同名后者覆盖前者）。 */
export function parseSetCookie(headers: readonly string[]): Record<string, string>

/** ret 分类：成功返回 data，失败抛 XianyuError（code 见 core/errors.ts）。 */
export function parseMtopResponse(api: string, raw: unknown): unknown

/** 构造 + 发送 + 解析；失败抛 XianyuError。 */
export function callMtop(transport: MtopTransport, opts: MtopCallOptions): Promise<unknown>
```

**必须覆盖的测试**（fixture 全在包内，不发网络）：
1. `signMtop` 与已知向量一致（token=`abc`、t=1700000000000、data=`{"a":1}`），并断言**不是**秒级截断的 t。
2. `buildMtopRequest`：url、7 个通用参数、`data` 紧凑 JSON、headers 含 origin/referer/UA、`t` 为调用方给的毫秒。
3. `h5Token`：`_m_h5_tk` 形如 `<token>_<ts>` 取前段；缺失 → `AUTH_EXPIRED`。
4. `parseMtopResponse`：SUCCESS / RGV587 / 哎哟喂 / FAIL_SYS_TOKEN_EXOIRED / FAIL_SYS_SESSION_EXPIRED / FAIL_SYS_ILLEGAL_ACCESS / sign 错误 / 不存在 → 对应 `ErrorCode`；未知 ret → `UNKNOWN` 且 message 含原 ret。
5. `parseSetCookie`：`Domain=.goofish.com; Path=/; HttpOnly` 等属性被剥掉，只留 name/value。
6. `callMtop` 走假 transport：断言请求被发一次、body 是 `data=<紧凑json>`、网络异常 → `NETWORK`（retryable）。

### 4.2 `@bigfish/channel-cdp`

从 `scripts/lib/cdp.mjs` 提升为 TS 包（脚本继续可用，改为 import 包）。

```ts
export interface ChromeTarget { browserWsUrl: string; close(): Promise<void> }

export function resolveChromePath(env?: Record<string, string | undefined>): string
export function launchChrome(opts?: {
  userDataDir?: string
  port?: number
  headless?: boolean
  timeoutMs?: number
  execPath?: string
}): Promise<{ target: ChromeTarget; port: number; close(): Promise<void> }>

/** 附加到已开的 Chrome（--remote-debugging-port=9222，用户自己的登录态）。 */
export function attachChrome(port?: number): Promise<ChromeTarget>

export class CdpConnection {
  static connect(wsUrl: string, opts?: { timeoutMs?: number }): Promise<CdpConnection>
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(event: string, listener: (params: unknown) => void): () => void
  close(): Promise<void>
}

export class CdpPage {
  static open(conn: CdpConnection, url: string, opts?: { settleMs?: number }): Promise<CdpPage>
  navigate(url: string): Promise<void>
  evaluate<T = unknown>(expression: string): Promise<T>
  waitFor(expression: string, opts?: { timeoutMs?: number; intervalMs?: number; label?: string }): Promise<void>
  /** 等某个 URL 片段的 JSON 响应（免签名读 mtop）。 */
  captureJson(opts: { urlContains: string; timeoutMs?: number }): Promise<unknown>
  screenshot(filePath: string): Promise<void>
  close(): Promise<void>
}

/** 发布步骤状态机：步骤 = 名称 + 动作；失败不重试（写操作必须人工介入）。 */
export interface PublishStep {
  name: string
  run(page: CdpPage, ctx: PublishContext): Promise<void>
}
export interface PublishContext {
  log(step: string, message: string): void
  now(): number
  signal?: AbortSignal
}
export function runPublishSteps(page: CdpPage, steps: PublishStep[], ctx: PublishContext): Promise<{ ok: true } | { ok: false; step: string; error: string }>
```

**必须覆盖的测试**：
1. `launch/attach` 的 URL 拼装与端口参数（用注入的 fake fetch 打 `/json/version`），不真起 Chrome。
2. `CdpConnection`：fake WebSocket（EventEmitter 风格）→ `send` 收到匹配 id 的结果；错误响应转 `XianyuError`；超时（假时钟/短超时）→ `NETWORK`。
3. `CdpPage.captureJson`：假连接下先回 `Network.enable`、再回一次 `Network.responseReceived` + `getResponseBody` → 返回解析后的 JSON；URL 不匹配的超时。
4. `runPublishSteps`：全部成功返回 `{ok:true}`；第 2 步抛错返回 `{ok:false, step:'...'}` 且**第 3 步不执行**；ctx.log 被调用。
5. 包内**不 import** playwright/puppeteer；`grep` 断言源码无 `child_process` 以外的重依赖（launchChrome 允许 spawn）。

### 4.3 `@bigfish/channel-guanjia`

```ts
export interface GuanJiaCredentials { appId: string; appSecret: string; mchId: string; mchSecret: string }
export interface GuanJiaTransport {
  request(req: { url: string; method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{ status: number; text: string }>
}

export class GuanJiaClient {
  constructor(opts: { credentials: GuanJiaCredentials; baseUrl?: string; transport?: GuanJiaTransport; now?: () => number })
  /** timestamp（秒）+ sign；body 是紧凑 JSON；body 为空时用 "{}"。 */
  sign(body: unknown): { timestamp: number; sign: string; headers: Record<string, string> }
  call<T = unknown>(path: string, body?: unknown): Promise<T>
  // 商品
  shops(): Promise<unknown>
  categories(): Promise<unknown>
  attributes(categoryId: number): Promise<unknown>
  productList(params?: { page?: number; pageSize?: number; status?: number }): Promise<unknown>
  productDetail(productId: number): Promise<unknown>
  skus(productId: number): Promise<unknown>
  createProduct(data: Record<string, unknown>): Promise<unknown>
  createProductsBatch(products: Record<string, unknown>[]): Promise<unknown>
  publishProduct(productId: number): Promise<unknown>
  unpublishProduct(productId: number): Promise<unknown>
  updateProduct(productId: number, data: Record<string, unknown>): Promise<unknown>
  updateStock(productId: number, stock: number, skuId?: number): Promise<unknown>
  deleteProduct(productId: number): Promise<unknown>
  // 订单
  orderList(params?: { page?: number; pageSize?: number; status?: number }): Promise<unknown>
  orderDetail(orderId: number): Promise<unknown>
  orderCards(orderId: number): Promise<unknown>
  shipOrder(orderId: number, logisticsNo: string, logisticsCompany: string): Promise<unknown>
  updateOrderPrice(orderId: number, price: number): Promise<unknown>
  // 其他
  logisticsCompanies(): Promise<unknown>
  balance(): Promise<unknown>
}
```

**红线**：`placeOrder`（代下单/刷单）**不实现**，连方法都不留（AGENTS §1.6）。

**必须覆盖的测试**：
1. `sign` 与 Python 实现同向量（`appId=a, appSecret=b, body={"x":1}, ts=1700000000, mchId=c, mchSecret=d`）。
2. 头字段 `X-App-Id / X-Mch-Id / X-Timestamp / X-Sign` 齐全且 `Content-Type: application/json`。
3. 空 body 签名用 `{}`（跟 Python 一致）。
4. `call` 走假 transport：`code === 0` 返回 `data`；`code !== 0` → `XianyuError`（`code` 用 core 的 `ErrorCode`，原平台码放 `XianyuError.platformCode`；若 core 没有该字段则用 `cause` 承载，别私自改 core 公共契约——需要时在 PR 里说明）。
5. 网络异常/超时 → `NETWORK`；HTTP 非 200 → `NETWORK`。
6. 所有方法都打到正确的 path（用假 transport 记录 path）。

### 4.1–4.3 实现备注

- **mtop**：通用参数实际是 12 个（jsv/appKey/t/sign/v/type/accountSite/dataType/timeout/api/sessionOption/spm_cnt），`extraParams` 最后合并可覆盖同名项；`t` 必须毫秒，秒级截断会得到不同签名（已写进测试）。
- **cdp**：`captureJson` 先等 `Network.responseReceived` 认请求，再等同一 `requestId` 的 `Network.loadingFinished` 才 `getResponseBody`；等不到（长连接/中断）时按 `loadingGraceMs`（默认 1000ms）兜底读一次，避免死等。
- **guanjia**：参考实现的 Python `requests(json=...)` 会插空格，导致签名串与实际发送字节不一致（其 bug）；本包签名与发送共用同一紧凑字符串。

## 5. 本期不做（留给 P1.1/P1.2）

- 真实网络调用与真实闲鱼/闲管家联调（本仓禁止直连，见 AGENTS §5）。
- 发布字段的完整映射（`itemTextDTO` / `itemPriceDTO` / `imageInfoDOList` …）：P1.1 用抓包 fixture 做。
- 图片上传通道（`stream-upload.goofish.com`）。
- daemon 执行器接 channel（P1.1）、登录态导入 UI（P1.1）。
- mtop **写接口**（发布/擦亮/发货）默认关闭：通道层只提供构造与解析能力，开关在 daemon。

## 6. 验收

```sh
node scripts/test-all.mjs            # 779 tests / 779 pass（31 suites / 79 个测试文件；口径见 STATUS.md）
node scripts/typecheck.mjs           # 6 个 TS 包全通过；plugin-ops / ops-bundle 是纯 JS，不参与
```

每个包必须有 `README.md`（职责、导出、许可来源、测试范围）。