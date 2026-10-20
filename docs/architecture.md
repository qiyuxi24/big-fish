# 架构（P0）

> 设计意图与性能预算见 [xianyu-ops-agent-design.md](xianyu-ops-agent-design.md)；本文件只描述**已实现**的 P0 形态。

## 1. 进程与包边界

```
┌──────────────── DSH 宿主进程（Electron / CLI）────────────────┐
│  agent（LLM）                                                │
│      │ 工具调用                                              │
│  @bigfish/plugin-ops  ← 由 @bigfish/ops-bundle 的 patch 装配 │
│      │ HTTP 127.0.0.1:47001 + Bearer token                    │
└──────┼───────────────────────────────────────────────────────┘
       │
┌──────▼──────────────── 独立 Node 进程 bigfish-daemon ────────┐
│  server.ts（http 路由、鉴权、ApiResult 信封、redact）        │
│  TaskQueue（node:sqlite，WAL）+ 执行器（P1 接通道）          │
│  core：redact / logger / limiter / circuit / credentials     │
└──────────────────────────────────────────────────────────────┘
```

关键点：**daemon 不调 LLM**，也不 import 任何 DSH 代码；插件不 import `@bigfish/core` 的实现，两者只靠 HTTP 契约耦合。

## 2. 四个包

| 包 | 语言 | 依赖 | 职责 |
| --- | --- | --- | --- |
| `packages/core` | TS | 无 | 领域类型与契约、错误、ret 风控分类、队列/存储、限流熔断、凭据、配置、脱敏日志 |
| `packages/daemon` | TS | core | HTTP 控制面 + CLI + DaemonClient；P1.1 承载执行器并调用 channel 包 |
| `packages/plugin-ops` | JS(ESM) | 无（含自带 HTTP client） | 7 个 `xy_*` 工具 + 写操作审批门禁 + 侧边栏面板 |
| `packages/ops-bundle` | JS | plugin-ops | 只声明 `dsh.bundle.patch`，把插件塞进 profile |
| `packages/channel-mtop` | TS | core | mtop 只读通道：签名、信封、cookie 归一、ret 分类（**纯函数，无状态**） |
| `packages/channel-cdp` | TS | core | CDP 会话：启动/attach 真 Chrome、页面操作、拦截 XHR JSON、发布步骤状态机 |
| `packages/channel-guanjia` | TS | core | 闲管家开放平台客户端（MIT 移植的签名与 20 个接口） |

依赖方向单向：`core ← daemon`、`core ← plugin-ops`、`core ← channel-*`；`daemon` 与 `plugin-ops` 互不 import，三个 channel 包之间也互不 import。

### 2.1 三个通道包（P1.0）

通道包只提供**能力**，不含业务编排：谁在什么节奏下调用它们由 daemon 执行器（P1.1）决定。

- `channel-mtop`：`signMtop / h5Token / buildMtopRequest / parseMtopResponse / parseSetCookie / callMtop`，传输层用可注入的 `MtopTransport`；不发请求、不存 cookie，调用方负责合并 `_m_h5_tk`。
- `channel-cdp`：`launchChrome / attachChrome / CdpConnection / CdpPage / runPublishSteps`；`captureJson` 免签名读 mtop 响应（先 `Network.loadingFinished` 再 `getResponseBody`），发布失败即停不重试。
- `channel-guanjia`：`GuanJiaClient` 20 个方法（商品/订单/物流/余额）；`code === 0` 成功，非 0 转 `XianyuError`；**不实现 placeOrder**（代下单红线）。

三者都零第三方依赖、无构建、测试全部假传输/假连接，不发真实网络（AGENTS §5）。

## 3. 一次写操作的路径（以发布为例）

1. 模型调用 `xy_task_enqueue({kind:"publish", dedupeKey:"publish:<draftId>", payload:{...}})`。
2. 门禁 `tools/pre-execute` 判定这是写操作 → 返回 `{kind:"ask"}`，等用户确认。
3. 插件 client 读 `<dataDir>/daemon.token`，`POST /tasks` 带 `Authorization: Bearer`。
4. daemon 鉴权 → 校验 body（≤1 MiB）→ `queue.enqueue()`：`dedupeKey` 已存在则返回既有记录（幂等，不重复建）。
5. 记录落 SQLite（`queued`），响应 `{ok:true,data:<TaskRecord>}`；插件渲染成模型可读文本。
6. P1：执行器 `lease()` 领任务 → 走通道（CDP/mtop）执行 → `ack` 或 `fail`（按退避重排/待审）。

## 4. IPC 契约

- 传输：`http://127.0.0.1:<port>`，默认 47001；只允许回环地址（server 启动前校验：`127.0.0.1` / `localhost` / `::1`）。
- 鉴权：除 `GET /health` 外全部要求 `Authorization: Bearer <token>`；token 文件默认 `<dataDir>/daemon.token`，不存在则生成 32 字节 hex、权限 0600；比较用 `timingSafeEqual`。鉴权先于路由匹配（未授权访问未知路径也返回 401）。
- 信封：成功 `{ok:true,data}`；失败 `{ok:false,error:{code,message,retryable}}`。**业务错误不借用 HTTP 状态码。**
- 错误码：`AUTH_EXPIRED | RISK_CONTROL | RATE_LIMITED | VALIDATION | NETWORK | BUS_STATE | UNAUTHORIZED | NOT_FOUND | CONFLICT | INTERNAL`（`packages/core/src/errors.ts` 的 `ERROR_CODES`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 免鉴权：`{version,pid,uptimeMs}` |
| GET | `/status` | 队列五态计数、账号、熔断账号 |
| GET | `/tasks?state&kind&limit` | 列表（缺省 50、上限 500） |
| GET | `/tasks/:id` | 单条 |
| POST | `/tasks` | 入队，201；幂等键去重 |
| POST | `/tasks/:id/ack` | 完成（需 owner 匹配） |
| POST | `/tasks/:id/fail` | 失败：`{error, nonRetryable?}` |
| POST | `/tasks/:id/release` | 立即退回队列 |
| GET | `/items` | P0 固定空数组 |
| POST | `/circuits/reset` | P0 空实现（返回 200） |

## 5. 任务状态机

```
queued ──lease──► leased ──ack──► done
  ▲                  │
  │                  ├──fail(可重试)──► queued（availableAt = now + min(60*2^(attempts-1),1800)s）
  │                  ├──fail(nonRetryable)──► failed
  │                  └──fail(attempts ≥ maxAttempts)──► needs_review
  └──租约过期（leaseUntil < now）被下一个 lease 回收
```

不变量：`dedupeKey` 唯一（重复入队返回既有记录）；`ack/fail/release` 必须传 owner 且与租约持有者一致；`needs_review` 只能人工处理，不自动重试。

## 6. 工具清单（7 个）

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `xy_ping` | 无 | 插件/daemon/鉴权三段自检 |
| `xy_daemon_health` | 无 | 只读健康（免鉴权） |
| `xy_status` | 无 | 队列与熔断概览 |
| `xy_tasks_list` | `state? kind? limit?(1..200, 默认 20)` | 查任务 |
| `xy_task_enqueue` | `kind, dedupeKey, payload?, availableAt?, maxAttempts?(1..10)` | 入队（**写类**） |
| `xy_task_action` | `id, action(ack/fail/release), owner?, error?, nonRetryable?` | 任务流转 |
| `xy_items_list` | 无 | 商品列表（P0 空） |

所有工具输出统一为 `{ text }` 对象（`additionalProperties:false`），文本里带 emoji 状态前缀；`DaemonError` 转成 `❌ [CODE] message`，不抛给模型当异常。

## 7. 写操作审批门禁

`tools/pre-execute` 钩子对 `xy_task_enqueue` 判定：`kind ∈ {publish, deliver, polish}` → `{kind:"ask", reason}`；`reply/probe` 与参数非对象之外的读类直接放行（参数不是对象时**保守**按写处理）。`xy_task_action` 的 `ack/fail/release` 不触发门禁（都是本地队列状态流转，其中 fail 不会被自动重放）。

## 8. core 的横向能力

| 模块 | 出口 | P0 状态 |
| --- | --- | --- |
| `redact.ts` | `redactString / redact / SENSITIVE_KEYS` | 已用：daemon 出站响应与 logger 都脱敏 |
| `logger.ts` | `createLogger({level,name,sink,now})` | 单行 JSON，键序固定 |
| `limiter.ts` | `RateLimiter`（`write 1/60s`、`media 9/60s`、`read 30/60s`） | 已实现未接入执行器 |
| `circuit.ts` | `CircuitBreaker`（默认 10 分钟，原子写盘） | 同上 |
| `credentials.ts` | `CredentialStore`（AES-256-GCM，32 字节主密钥 0600） | 同上 |
| `config.ts` | `loadDaemonConfig(env, overrides)` | CLI 与测试共用 |
| `store.ts` / `queue.ts` | `openStore` / `createTaskQueue` | 已用于 daemon |

## 9. P0 明确未实现（不要当 bug）

- **没有执行器**：队列只落库，没有 worker 领任务去调通道；`lease/ack/fail/release` 目前只有 HTTP 与单测驱动。
- **通道实现已就绪但没接进 daemon**：mtop 签名/信封、CDP 会话与发布步骤机、闲管家客户端都在 `packages/channel-*`，但没有执行器调用它们；IM 长连接未写。
- **items 是空表**：`/items` 恒返回 `[]`，`xy_items_list` 返回「本地还没有商品记录」。
- **`/circuits/reset` 是空实现**。
- **没有打包**：Electron/headless 分发形态待用户决策。
