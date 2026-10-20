# 架构（P1.1）

> 设计意图与性能预算见 [xianyu-ops-agent-design.md](xianyu-ops-agent-design.md)；组件拆解过程见 [component-decomposition.md](component-decomposition.md)。本文件只描述**当前已实现**的形态，未实现部分集中在 §11。

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
│  runtime.ts  装配：store → queue → items → credentials →     │
│               limiter → circuit → operations → executors →   │
│               worker → server                                │
│  server.ts   HTTP 路由、鉴权、ApiResult 信封、redact          │
│  worker.ts   租约轮询、按账号串行、失败分类与熔断            │
│  executors.ts 六个操作的能力矩阵：校验→熔断→限流→凭据→通道   │
│  operations.ts mtop 传输与读接口（probe/polish）             │
│  core        队列/商品/策略/限流/熔断/凭据/脱敏/配置         │
└──────────────────────────────────────────────────────────────┘
```

关键点：**daemon 不调 LLM**，也不 import 任何 DSH 代码；插件不 import `@bigfish/core` 的实现，两者只靠 HTTP 契约耦合。

## 2. 七个包

| 包 | 语言 | 依赖 | 职责 |
| --- | --- | --- | --- |
| `packages/core` | TS | 无 | 领域类型与契约、错误、ret 风控分类、队列/存储、商品仓储、发布前策略校验、限流熔断、凭据、配置、脱敏日志 |
| `packages/daemon` | TS | core、channel-mtop | HTTP 控制面 + CLI + 运行时装配 + worker + 执行器 + DaemonClient |
| `packages/plugin-ops` | JS(ESM) | 无（含自带 HTTP client） | 7 个 `xy_*` 工具 + 写操作审批门禁 + 侧边栏面板 |
| `packages/ops-bundle` | JS | plugin-ops | 只声明 `dsh.bundle.patch`，把插件塞进 profile |
| `packages/channel-mtop` | TS | core | mtop 通道：签名、信封、cookie 归一、ret 分类、读接口与发布接口的 data 构造（**纯函数，无状态**） |
| `packages/channel-cdp` | TS | core | CDP 会话：启动/attach 真 Chrome、页面操作、拦截 XHR JSON、发布步骤状态机、cookie 读取与登录态校验 |
| `packages/channel-guanjia` | TS | core | 闲管家开放平台客户端（MIT 移植的签名与 20 个接口） |

依赖方向单向：`core ← daemon`、`core ← plugin-ops`、`core ← channel-*`；`daemon` 与 `plugin-ops` 互不 import，三个 channel 包之间也互不 import。

## 3. 一次写操作的完整路径（以 probe 为例，P1.1 已通）

1. 模型调用 `xy_task_enqueue({kind:"probe", dedupeKey:"probe:<accountId>:<itemId>", payload:{accountId, itemId}})`。
2. 门禁 `tools/pre-execute`：`probe` 是读类，不放行审批；`publish/deliver/polish` 才返回 `{kind:"ask"}` 等用户确认。
3. 插件 client 读 `<dataDir>/daemon.token`，`POST /tasks` 带 `Authorization: Bearer`。
4. daemon 鉴权 → 校验 body（≤1 MiB）→ `queue.enqueue()`：`dedupeKey` 已存在则返回既有记录（幂等）。
5. worker 轮询（默认 1s）→ `queue.lease()` 领任务（`availableAt <= now` 或租约过期）→ `attempts += 1`。
6. 执行器：`spend`（read 桶）→ `requireSession`（AES-256-GCM 解凭据）→ `checkCircuit`（账号熔断中直接拒绝）→ `port.fetchItemDetail`（mtop 详情）→ `items.upsert`。
7. 成功 `queue.ack()`；可重试失败按 `min(60*2^(attempts-1),1800)s` 重排，不可重试 `failed`，attempts 用尽 `needs_review`；`RISK_CONTROL` 额外把账号写进熔断器并带 `retryAfterMs`。
8. 插件 `xy_tasks_list` / `xy_items_list` 读回状态与商品。

## 4. 运行时装配（`packages/daemon/src/runtime.ts`）

`startDaemonRuntime({config, transport?, ports?, now?, logger?, owner?, autoStartWorker?, version?})` 的装配顺序是固定的，且**同一个 SQLite 库同时喂队列与商品仓储**：

```
openStore({path: config.dbPath})
  → createTaskQueue({store})
  → createItemRepository({store})
  → CredentialStore({dir: config.credentialsDir})
  → new RateLimiter()
  → new CircuitBreaker({path: config.circuitPath})
  → createOperationPort({transport ?? createFetchTransport()}) + ports 覆盖（测试注入假通道）
  → createExecutors({ports, now})
  → startWorker({queue, executors, leaseTtlMs, pollIntervalMs})
  → startDaemon({config, queue, items, circuits, accounts: () => accounts, worker: () => worker.stats()})
```

失败回收：`openStore` 之后任一环节失败都要关 store；daemon 启动失败先停 worker。`accounts` 是启动时 `credentials.list()` 的快照，`refreshAccounts()` 重新拉取（插件 `/status` 读到的就是它）。

## 5. worker 语义（`packages/daemon/src/worker.ts`）

- 单轮 `tick()` 按 `concurrency`（默认 1）领租约；**同一 `payload.accountId` 串行**，冲突任务立即 `release` 并记 `skipped`。
- `stop()` 幂等：停止领取，并 abort 在飞任务的 `AbortSignal`；被 abort 的任务 `release` 而不是 `fail`。
- 日志一任务一行：`taskId/kind/state/durationMs`。
- 错误分类：不可重试集合 = `VALIDATION | AUTH_EXPIRED | UNSUPPORTED | INTERNAL | UNAUTHORIZED | UNKNOWN`；`RISK_CONTROL` 额外 `circuits.trip(accountId, message)` 并把 `retryAfterMs` 传回队列。
- 没有租约续约：超过 `leaseTtlMs`（默认 60s）的长任务可能被第二个 worker 重复领取，**执行器必须幂等**（发布用 `uniqueCode` 防重，见 AGENTS §1）。

## 6. 执行器能力矩阵（`packages/daemon/src/executors.ts`）

统一顺序：校验载荷 → `checkCircuit` → `spend` 限流桶 → `requireSession` 取凭据 → 调 `OperationPort`。错误统一是 `XianyuError`，`code` 决定 worker 的处置。

| kind | 限流桶 | 通道 | P1.1 状态 |
| --- | --- | --- | --- |
| `probe` | read | mtop 详情 | ✅ 已通，成功后 `items.upsert` |
| `polish` | write | mtop 擦亮 2.0 | ✅ 已通 |
| `publish` | write | CDP/mtop 发布 | ⛔ `UNSUPPORTED`（P1.2）；执行器已做策略校验与落库占位 |
| `deliver` | write | IM/闲管家 | ⛔ `UNSUPPORTED`（P2） |
| `reply` | write | IM | ⛔ `UNSUPPORTED`（P2） |

`publish` 入口先跑 `checkListing`（`packages/core/src/policy.ts`：标题/描述长度、价格区间、违禁词 38 条、违禁类目 20 条、首图方形、图片数量），`error` 级问题直接 `VALIDATION` + `details.issues`，不消耗通道预算。**刻意的 `UNSUPPORTED` 不是 bug**：宁可失败也不留「假成功」的已发布假象。

## 7. IPC 契约

- 传输：`http://127.0.0.1:<port>`，默认 47001；只允许回环地址（`127.0.0.1` / `localhost` / `::1`）。
- 鉴权：除 `GET /health` 外全部要求 `Authorization: Bearer <token>`；token 文件默认 `<dataDir>/daemon.token`，不存在则生成 32 字节 hex、权限 0600；比较用 `timingSafeEqual`。鉴权先于路由匹配。
- 信封：成功 `{ok:true,data}`；失败 `{ok:false,error:{code,message,retryable,details?}}`。**业务错误不借用 HTTP 状态码**（只有 400/401/404/405/409/413 这类协议层状态）。
- 错误码：`AUTH_EXPIRED | RISK_CONTROL | RATE_LIMITED | VALIDATION | NETWORK | BUS_STATE | UNAUTHORIZED | NOT_FOUND | CONFLICT | INTERNAL | UNSUPPORTED`（`packages/core/src/errors.ts`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 免鉴权：`{version,pid,uptimeMs}` |
| GET | `/status` | 队列五态计数、`accounts`、`circuits`（账号→原因）、`worker` 计数 |
| GET | `/tasks?state&kind&limit` | 列表（缺省 50、上限 500） |
| GET | `/tasks/:id` | 单条 |
| POST | `/tasks` | 入队，201；幂等键去重 |
| POST | `/tasks/:id/ack` | 完成（需 owner 匹配） |
| POST | `/tasks/:id/fail` | 失败：`{error, nonRetryable?, retryAfterMs?}` |
| POST | `/tasks/:id/release` | 立即退回队列 |
| GET | `/items?state&accountId&limit` | 本地商品快照；`state ∈ online/offline/unknown` |
| POST | `/circuits/reset` | `{accountId}` → `{accountId, reset:boolean}`（未注入熔断器时 `reset:false`） |

注意：**id 是 UUID，且 `redact` 会保护 UUID 不被长串规则误掩**（早期把 `taskId` 掩成 `[redacted]` 导致客户端回查 404，`packages/core/src/redact.ts` 已修，有单测）。

## 8. 任务状态机

```
queued ──lease──► leased ──ack──► done
  ▲                  │
  │                  ├──fail(可重试)──► queued（availableAt = now + min(60*2^(attempts-1),1800)s）
  │                  ├──fail(nonRetryable)──► failed
  │                  └──fail(attempts ≥ maxAttempts)──► needs_review
  └──租约过期（leaseUntil < now）被下一个 lease 回收
```

不变量：`dedupeKey` 唯一；`ack/fail/release` 必须传 owner 且与租约持有者一致；`needs_review` 只能人工处理，不自动重试；失败不退还限流预算。

## 9. 工具清单（7 个）

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `xy_ping` | 无 | 插件/daemon/鉴权三段自检 |
| `xy_daemon_health` | 无 | 只读健康（免鉴权） |
| `xy_status` | 无 | 队列、账号、熔断、worker 概览 |
| `xy_tasks_list` | `state? kind? limit?(1..200, 默认 20)` | 查任务 |
| `xy_task_enqueue` | `kind, dedupeKey, payload?, availableAt?, maxAttempts?(1..10)` | 入队（**写类**） |
| `xy_task_action` | `id, action(ack/fail/release), owner?, error?, nonRetryable?` | 任务流转 |
| `xy_items_list` | 无 | 商品列表 |

所有工具输出统一为 `{ text }` 对象（`additionalProperties:false`），文本里带 emoji 状态前缀；`DaemonError` 转成 `❌ [CODE] message`，不抛给模型当异常。

## 10. 写操作审批门禁

`tools/pre-execute` 钩子对 `xy_task_enqueue` 判定：`kind ∈ {publish, deliver, polish}` → `{kind:"ask", reason}`；`reply/probe` 与读类直接放行（参数不是对象时**保守**按写处理）。`xy_task_action` 不触发门禁（都是本地队列状态流转）。

## 11. 现在明确未实现（不要当 bug）

- **publish 未接通道**：`UNSUPPORTED`，等 P1.2（CDP 发布步骤：图片上传 → 类目属性 → 价格地址 → 提交）。
- **IM 与发货未实现**：`deliver/reply` 是 `UNSUPPORTED`；协议与规则已写进 [im-protocol.md](im-protocol.md)、[delivery-rules.md](delivery-rules.md)。
- **登录态导入没有入口**：凭据只能由代码 `credentials.save()` 写入，还没有二维码/浏览器 cookie 导入工具与 GUI。
- **没有打包**：Electron/headless 分发形态待用户决策。
- **没有真实联调**：所有测试都不发真实网络（AGENTS §5），首次真机验证需小号。

## 12. 测试与验证现状

| 层 | 数量 | 说明 |
| --- | --- | --- |
| 全仓 | 379 tests / 379 pass | `node scripts/test-all.mjs` |
| core | 112 | 队列、仓储、策略、限流熔断、凭据、脱敏、配置 |
| daemon | 69 | HTTP、CLI、客户端、执行器、worker、路由，含 5 条 `runtime.test.ts` 全链路集成（真 HTTP + 真 SQLite + 假 mtop transport） |
| channel-mtop / channel-cdp / channel-guanjia | 53 / 49 / 62 | 纯函数与假连接 |
| plugin-ops | 32 | 插件契约与门禁 |
| integration | 2 | 插件 client ↔ 真 daemon 的跨层端到端 |
| 类型检查 | 5 个 TS 包 0 错误 | 借 DSH checkout 的 `tsc --noEmit` |

集成测试覆盖的关键链路：入队 → worker 领租约 → 解凭据 → 假 mtop → `items.upsert` → ack → `/items` 与 `/status.worker` 可查；无凭据时**不调用通道**且直接 `failed`；`publish` 因 `UNSUPPORTED` 进 `failed`；`dedupeKey` 不产生第二个任务；close 后端口不可达。