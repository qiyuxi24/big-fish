# 架构（P1.2）

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
│  executors.ts 五个操作的能力矩阵：校验→熔断→限流→凭据→通道   │
│  operations.ts mtop 传输与读接口（probe/polish）             │
│  core        队列/商品/策略/限流/熔断/凭据/脱敏/配置         │
└──────────────────────────────────────────────────────────────┘
```

关键点：**daemon 不调 LLM**，也不 import 任何 DSH 代码；插件不 import `@bigfish/core` 的实现，两者只靠 HTTP 契约耦合。

> **模块视角**（四个业务模块怎么切、各自数据流与「能不能正式用」的判定）见 [module-architecture.md](module-architecture.md)。本文是底层契约，那边是产品切分。

## 2. 八个包

| 包 | 语言 | 依赖 | 职责 |
| --- | --- | --- | --- |
| `packages/core` | TS | 无 | 领域类型与契约、错误、ret 风控分类、队列/存储、商品仓储、发布前策略校验、限流熔断、凭据、配置、脱敏日志 |
| `packages/daemon` | TS | core、channel-mtop、channel-cdp | HTTP 控制面 + CLI + 运行时装配 + worker + 执行器 + DaemonClient |
| `packages/plugin-ops` | JS(ESM) | 无（含自带 HTTP client） | 14 个 `xy_*` 工具 + 写操作审批门禁 + 侧边栏面板（面板内 6 个模块 tab：自动发布 / 账号 / 文案 / 采集 / 概览 / 诊断） |
| `packages/ops-bundle` | JS | plugin-ops | 只声明 `dsh.bundle.patch`，把插件塞进 profile |
| `packages/channel-mtop` | TS | core | mtop 通道：签名、信封、cookie 归一、ret 分类、读接口与发布接口的 data 构造（**纯函数，无状态**） |
| `packages/channel-cdp` | TS | core | CDP 会话：启动/attach 真 Chrome、页面操作、拦截 XHR JSON、发布步骤状态机、cookie 读取与登录态校验 |
| `packages/channel-guanjia` | TS | core | 闲管家开放平台客户端（MIT 移植的签名与 20 个接口） |
| `packages/channel-im` | TS | core | IM 协议事实层：帧解析、消息归一化、会话状态机（**已提交，未接 daemon**；无 websocket 长连/消息发送/鉴权握手） |

依赖方向单向：`core ← daemon`、`core ← channel-*`；`daemon` 与 `plugin-ops` 互不 import，四个 channel 包之间也互不 import（daemon 只按包名依赖 channel-mtop / channel-cdp 作为执行器通道）。

## 3. 一次写操作的完整路径（以 probe 为例，已通）

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

| kind | 限流桶 | 通道 | 状态 |
| --- | --- | --- | --- |
| `probe` | read | mtop 详情 | ✅ 已通，成功后 `items.upsert` |
| `polish` | write | mtop 擦亮 2.0 | ✅ 已通 |
| `publish` | write | CDP 发布步骤机（`channel-cdp`） | ⚠️ 默认 dry-run；`--submit` / `BF_PUBLISH_SUBMIT=1` 才走真链路。2026-10-21 起真机单件跑通多次（首次 itemId `1093817229436`，记录见 §13.6；次数与证据以 [STATUS.md](STATUS.md) 为准）；只验证「学习笔记」一条类目路径，不等于可批量发布 |
| `deliver` | write | IM/闲管家 | ⛔ `UNSUPPORTED`（P2） |
| `reply` | write | IM | ⛔ `UNSUPPORTED`（P2） |

`publish` 入口先跑 `checkListing`（`packages/core/src/policy.ts`：标题/描述长度、价格区间、违禁词 38 条、违禁类目 20 条、首图方形、图片数量），`error` 级问题直接 `VALIDATION` + `details.issues`，不消耗通道预算。**刻意的 `UNSUPPORTED` 不是 bug**：宁可失败也不留「假成功」的已发布假象。

### 6.1 发布通道（P1.2）

- 路线决策见 [ADR 0003](adr/0003-publish-automation-path.md)：确定性 CDP 步骤机是唯一写路径，LLM 不进热路径（只做校准、异常归因、人工兜底）；mtop 发布接口保留为将来加速通道；DSH 内置浏览器（bsk）只作兜底演示。
- 步骤机在 `packages/channel-cdp/src/publish.ts`：打开发布页 → 上传图片（`DOM.setFileInputFiles`，等价用户选文件）→ 文案（contenteditable 富文本走 `Input.insertText`，普通 input 走原生 setter + `input` 事件）→ [选择分类（草稿给 `category` 时才跑）] → 计价方式 → 价格/包邮 → 地址（真实键入触发联想，按候选匹配点选并回读表单）→ 必填项预检（分类/所在地非空）→ 提交并验证（URL 含 item id 或页面出现「发布成功」，超时按失败处理且**不自动重试**）。dry-run 在提交前收尾。
- 装配在 `packages/daemon/src/cdp-publish.ts`：先读浏览器 `unb` 与期望账号比对（防发错号）→ 开空白页跑步骤机 → 返回 `{accountId,dryRun,itemId?,href,durationMs}`。
- 安全默认：`submit=false` 只填表不点提交；CLI `npm run daemon:publish -- --draft <草稿.json> [--account-id X] [--chrome-port 9222] [--screenshots dir] [--submit]`，daemon 队列发布要 `BF_PUBLISH_SUBMIT=1`（另支持 `BF_CHROME_PORT`、`BF_PUBLISH_SCREENSHOTS`，截图默认 `<data-dir>/publish-shots`）。
- 选择器与填写方式已在真机（Edge 155 + CDP 9222，用户大号 `2206569289277`）校准；选择器表、填写原理、**地址搜索限制**、**类目支持矩阵**与**真发布记录**见 §13。2026-10-21 起已用该账号完成端到端真发布（首次 itemId `1093817229436`），见 §13.5。**注意：这个账号不是测试小号**（AGENTS §5），真发必须一次一件、用户点头。

## 7. IPC 契约

- 传输：`http://127.0.0.1:<port>`，默认 47001；只允许回环地址（`127.0.0.1` / `localhost` / `::1`）。
- 鉴权：除 `GET /health` 外全部要求 `Authorization: Bearer <token>`；token 文件默认 `<dataDir>/daemon.token`，不存在则生成 32 字节 hex、权限 0600；比较用 `timingSafeEqual`。鉴权先于路由匹配。
- 信封：成功 `{ok:true,data}`；失败 `{ok:false,error:{code,message,retryable,details?}}`。**业务错误不借用 HTTP 状态码**（只有 400/401/404/405/409/413 这类协议层状态）。
- 错误码：`AUTH_EXPIRED | RISK_CONTROL | RATE_LIMITED | VALIDATION | NETWORK | BUS_STATE | UNAUTHORIZED | NOT_FOUND | CONFLICT | INTERNAL | UNSUPPORTED`（`packages/core/src/errors.ts`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 免鉴权：`{version,pid,uptimeMs}` |
| GET | `/status` | 队列五态计数、`accounts`、`circuits`（账号→原因）、`worker` 计数 |
| GET | `/accounts` | 账号只读摘要：`{accountId, updatedAt, savedFieldCount, ready, unb?, ageMs, broken?, brokenReason?}`；坏凭据单条标 `broken`（不带 cookie 值），未注入时返回 `[]` |
| POST | `/accounts/import` | 从本机 Chrome（CDP，默认 9222）读 goofish cookie 并加密落盘：`{accountId?, port?}` → `{accountId, savedFieldCount, updatedAt, source}`；未注入导入能力时 `UNSUPPORTED` |
| POST | `/accounts/login` | 扫码登录：打开登录页等用户扫码，轮询到 `unb` + `_m_h5_tk` 齐备才落加密凭据（默认超时 180s）；未注入能力时 `UNSUPPORTED` |
| GET | `/tasks?state&kind&limit` | 列表（缺省 50、上限 500） |
| GET | `/tasks/:id` | 单条 |
| POST | `/tasks` | 入队，201；幂等键去重 |
| POST | `/tasks/:id/ack` | 完成（需 owner 匹配） |
| POST | `/tasks/:id/fail` | 失败：`{error, nonRetryable?, retryAfterMs?}` |
| POST | `/tasks/:id/release` | 立即退回队列 |
| POST | `/tasks/:id/retry` | 人工重新排队：只允许 `failed` / `needs_review`；`queue.requeue` 把 attempts 归零、清空 lastError 与旧租约、保留 dedupeKey 与 payload；未注入能力时 `UNSUPPORTED` |
| POST | `/reference` | 参考分析（只读）：`{accountId, itemIds?, sellerId?}` → 价格带/标题长度/类目分布/高频卖点词/图片数/商家量级；单件失败进 `skipped`，`AUTH_EXPIRED`/`RISK_CONTROL`/`UNAUTHORIZED` 中止整批；未注入能力时 `UNSUPPORTED` |
| GET | `/items?state&accountId&limit` | 本地商品快照；`state ∈ online/offline/unknown` |
| POST | `/circuits/reset` | `{accountId}` → `{accountId, reset:boolean}`（未注入熔断器时 `reset:false`） |
| POST | `/shutdown` | 优雅关停：先回 202 `{stopping:true,pid}`，再停止 worker（释放租约）→ 关 HTTP → 关 SQLite；未注入能力时 `UNSUPPORTED` |
| GET | `/events?since&limit&taskId&batchId` | 任务步骤事件流（增量）：`{items, nextSince}`；`since` 为排他游标（只回 `id > since`），缺省 `limit` 200、上限 1000；未注入事件存储时 `UNSUPPORTED` |

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

## 9. 工具清单（14 个）

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `xy_ping` | 无 | 插件/daemon/鉴权三段自检 |
| `xy_daemon_health` | 无 | 只读健康（免鉴权） |
| `xy_status` | 无 | 队列、账号、熔断、worker 概览 |
| `xy_tasks_list` | `state? kind? limit?(1..200, 默认 20)` | 查任务 |
| `xy_task_enqueue` | `kind, dedupeKey, payload?, availableAt?, maxAttempts?(1..10)` | 入队（**写类**） |
| `xy_task_action` | `id, action(ack/fail/release), owner?, error?, nonRetryable?` | 任务流转 |
| `xy_task_retry` | `taskId` | 人工重新排队 `failed` / `needs_review`（attempts 归零、清租约与 lastError、保留 dedupeKey/payload；**写类**，挂审批门禁——`BF_PUBLISH_SUBMIT=1` 下会真重放发布） |
| `xy_items_list` | 无 | 商品列表 |
| `xy_accounts_list` | 无 | 账号只读摘要（id / 更新于 / 登录态字段数 / 是否可写；坏凭据单独标 `broken`，不含任何 cookie 值） |
| `xy_import_account` | `accountId?, port?(1..65535, 默认 9222)` | 从带 CDP 端口的 Chrome 导入登录态（**写类**，加密落盘，回显不含 cookie） |
| `xy_publish_draft` | `draftPath, mode?(dry-run/enqueue), accountId?, chromePort?, screenshotsDir?, dedupeKey?` | 校验草稿并给命令（默认 dry-run 只填表不入队；enqueue **写类**） |
| `xy_publish_batch` | `drafts?, draftPaths?, accountId?(enqueue 必填), mode?(dry-run/enqueue), maxItems?(1..20)` | 批量发布：逐条校验 + 内容哈希幂等 + 批内去重，dry-run 出计划 / enqueue 逐条入队（**写类**，仅 enqueue 需审批；单条非法不拖垮整批，`NETWORK/UNAUTHORIZED` 中止剩余条目） |
| `xy_copy_plan` | `styleId?(5 档), productName, condition, priceYuan\|priceCents, shipping?, categoryHint?, specs?, flaws?, accessories?, imagePaths?, variantCount?, usedAiImages?` | 按语言风格把事实注入成文案生成提示词（**只读**：不调模型、不写文件、不碰 daemon） |
| `xy_reference_collect` | `accountId, itemIds?(≤20) \| sellerId?` | 参考分析只读统计（价格带 / 标题长度 / 类目分布 / 高频卖点词 / 图片数 / 商家量级）；不下载图片、不产出草稿（**只读**，不挂门禁，超时 100s） |

所有工具输出统一为 `{ text }` 对象（`additionalProperties:false`），文本里带 emoji 状态前缀；`DaemonError` 转成 `❌ [CODE] message`，不抛给模型当异常。

## 10. 写操作审批门禁

`tools/pre-execute` 钩子对 `xy_task_enqueue` 判定：`kind ∈ {publish, deliver, polish}` → `{kind:"ask", reason}`；`reply/probe` 与读类直接放行（参数不是对象时**保守**按写处理）。

`xy_accounts_list` 也是读类：只读 daemon 的 `GET /accounts` 摘要（不碰凭据文件、不返回 cookie 值），因此不挂门禁。

`xy_copy_plan` 属于读类：只把风格约束与事实渲染成提示词（`packages/plugin-ops/src/copy.js`，纯函数、确定性），不写队列、不写凭据、不发模型请求，因此不挂门禁。文案风格表的唯一权威是该文件里的 `COPY_STYLES`；面板 `client.js` 内嵌展示副本（loader 只能 require 宿主 9 个静态模块），漂移由 `test/client-bundle.test.mjs` 守护。

`xy_publish_batch` 与 `xy_publish_draft` 同口径：只有 `mode='enqueue'` 才算写操作、才走审批；`dry-run` 只读草稿文件并出计划（`packages/plugin-ops/src/gate.js` 的 `isWriteCall`）。

`xy_task_retry` 是写类（`gate.js` 的 `WRITE_TOOLS`）：它把 failed / needs_review 任务重新排队并清零 attempts，daemon 以 `BF_PUBLISH_SUBMIT=1` 启动时下一轮就会**真的重放这次发布**，所以挂审批门禁，拒绝理由里明说这一点。`xy_reference_collect` 只读（不下载图片、不写库、不产出草稿），不挂门禁。

**裁决：`xy_task_action`（ack/fail/release）不挂审批门禁。** 它只改本地队列状态（本地流转），不触达闲鱼、不产生平台副作用，不属于「写闲鱼」；门禁只覆盖会写平台的入队动作。`writeGate:false` 是测试逃生阀，默认开启。

## 11. 现在明确未实现（不要当 bug）

- **publish 真提交跑通过 3 次、都是单件（用户大号 `2206569289277`，均已下架）**：步骤机与 daemon 通道都在（§6.1），2026-10-21 首次成功（§13.5，`1093817229436`），随后 itemId `1091938715735` 在分类选择修复后又跑通一次（CLI 直发）；另有一次走队列路径（`POST /tasks` → worker → `1091940243200`）。3 次都只验证了「学习笔记」这一条类目路径，真提交需 `--submit` / `BF_PUBLISH_SUBMIT=1` 且必须由用户点头。**别把「单件跑通」当成「可以批量发」。**
- **发布页地址搜索在 CDP 下不可用**：联想请求能发出、响应正常，但候选列表 UI 不回显，只能从「常用地址/附近地址」里匹配（§13.3）。类目：页面 AI 自动识别，草稿可用 `category` 覆盖；**网页端只支持部分类目**，不支持时立即失败（§13.5）。
- **发货未实现、IM 已提交未接线**：`deliver/reply` 仍是 `UNSUPPORTED`；`packages/channel-im` 已提交（32 tests：帧解析/消息归一化/会话状态机）但**未接 daemon**（daemon 无该依赖），websocket 长连/消息发送/鉴权握手均未实现；协议与规则见 [im-protocol.md](im-protocol.md)、[delivery-rules.md](delivery-rules.md)。
- **登录态导入与扫码登录均已实现**：导入走 `npm run daemon:import-account`（或 `POST /accounts/import`、插件 `xy_import_account`），从带 `--remote-debugging-port=9222` 的浏览器读 cookie；扫码走 `npm run daemon:login` / `POST /accounts/login`，轮询到 `unb` + `_m_h5_tk` 齐备才算成功（默认超时 180s）。两者都写 `CredentialStore`（AES-256-GCM），accountId 默认取 cookie 里的 `unb`。
- **侧边栏面板内的模块 tab（2026-10-21 纠正）**：插件只注册 `sidebar.panellist` + `main` 两个插槽；主面板内部用 `PANEL_TABS` 切 6 个分区——自动发布（默认）/ 账号 / 文案 / 采集 / 概览 / 诊断（见 `plugin-ops/client.js` 的 `PANEL_TABS` 与 `PanelBody` 分发）。**不注册会话顶部 tab**（`conversation.view` 与「点侧边栏进面板」互斥，试过后已移除）。面板不读凭据、不调模型，需要执行的动作交给 agent 调工具或 daemon；但**状态是真实数据**：走 host rpc 通道 `/bigfish`（ADR 0004）每 3 秒轮询 `health`/`status`/`accounts`/`settings.get`/`tasks.list`/`batches.get` 六个只读端点，任一失败整块降级成「未连接后台」。DSH 宿主没有「面板按钮调 host 工具」的公开 API，所以写操作按钮仍 disabled 或只产出参数 JSON；写类端点（`accounts.import`/`accounts.login`/`tasks.retry`/`batch.enqueue`/`settings.put`）要配二次确认 UI 再接。⚠️ 该通道在 DSH 0.1.5-rc.2 上**注册必失败**（宿主 `connection` 插件用自己 ctx 注册 `webServer`，`rpc-host.ts:80`/`:178-181`，inject 只有 `['credentials']`），桌面面板当前只显示降级行；修法在宿主侧，详见 [adr/0004-client-host-rpc.md](adr/0004-client-host-rpc.md) §已知阻塞。
- **没有打包**：Electron/headless 分发形态待用户决策。
- **没有真实联调**：所有测试都不发真实网络（AGENTS §5），首次真机验证需小号。

## 12. 测试与验证现状

| 层 | 数量 | 说明 |
| --- | --- | --- |
| 全仓 | 780 tests / 780 pass（31 suites / 79 个测试文件） | `node scripts/test-all.mjs`，约 17s |
| core | 163 | 队列（含 batchId/批次统计/requeue）、仓储、策略、限流熔断与账号级 pacing、凭据、脱敏、配置、settings 存储、发货规则引擎（P2）、参考分析统计 |
| daemon | 200 | HTTP、CLI、客户端、执行器、worker、路由、账号导入/扫码登录、settings 与批次统计路由、CDP 发布通道（含 5 条 `runtime.test.ts` 全链路集成：真 HTTP + 真 SQLite + 假 mtop transport）、发布 dry-run 开关、参考采集、失败重排 |
| channel-mtop / channel-cdp / channel-guanjia / channel-im | 95 / 102 / 62 / 32 | 纯函数、假连接与假页面（channel-mtop 含参考解析；channel-cdp 含富文本/地址/预检假页面回放与发布侧风控探测；channel-im 帧解析/会话状态机，未接 daemon） |
| plugin-ops | 124 | 插件契约、审批门禁、草稿校验、批量入队与 pacing、账号摘要渲染、参考采集客户端、host rpc 桥（13 端点）、client bundle（含面板内 6 个模块 tab 与 rpc 轮询降级） |
| integration | 2 | 插件 client ↔ 真 daemon 的跨层端到端 |
| 类型检查 | 6 个 TS 包 0 错误 | 借 DSH checkout 的 `tsc --noEmit`；`plugin-ops` / `ops-bundle` 是纯 ESM JS（无 tsconfig，靠 JSDoc + 单测），**不在类型检查覆盖内** |

> 口径：`node:test` 的 `suites 31` 与 79 个测试文件不矛盾（文件数 ≠ suite 数）；`ops-bundle` 只声明 bundle patch，无测试。**真实能力边界比测试数重要**：失败重排、发布侧风控识别、账号级 pacing 目前都只有单测（未真机验证）；采集只有单件真机 200。

集成测试覆盖的关键链路：入队 → worker 领租约 → 解凭据 → 假 mtop → `items.upsert` → ack → `/items` 与 `/status.worker` 可查；无凭据时**不调用通道**且直接 `failed`；`publish` 因 `UNSUPPORTED` 进 `failed`；`dedupeKey` 不产生第二个任务；close 后端口不可达。

## 13. CDP 发布页真机校准（2026-10-21）

环境：Edge `155.0.4283.62`，`--remote-debugging-port=9222`，`--user-data-dir` 专用 profile；用户大号「同州禹斋」（accountId `2206569289277`，**不是测试小号**，见 AGENTS §5）；页面 `https://www.goofish.com/publish`（标题「发闲置_闲鱼」）。Cookie 起读改用 `Storage.getCookies`（Edge 155 把浏览器级 cookie 读取从 `Network.getAllCookies` 挪走，后者报 `wasn't found`；代码按「方法不存在」自动降级，见 `packages/channel-cdp/src/cookies.ts`）。

### 13.1 默认选择器（`DEFAULT_SELECTORS`）

| 用途 | 选择器 | 真机事实 |
| --- | --- | --- |
| 宝贝描述 | `div[contenteditable="true"], textarea[placeholder*="描述"], textarea` | 是富文本 DIV（`class="editor--MtHPS94K"`，`data-placeholder="描述一下宝贝的品牌型号、货品来源..."`），**textarea 数量为 0** |
| 图片输入 | `input[type=file]` | 单个，`accept="image/png, image/jpg, image/jpeg, image/heic, image/webp"` |
| 缩略图 | `div[class*="preview-container"]` | 每张图一个 `preview-container`；`.ant-upload-list-item` 数量为 0，旧选择器 `img[src^="blob:"]` 不适用（图是 alicdn URL） |
| 价格 | `input[placeholder="0.00"]` | 3 个同 placeholder，DOM 顺序 = [0]价格 [1]原价 [2]邮费，取第一个 |
| 提交 | `button[class*="publish-button"]` | `button.publish-button--KBpTVopQ` |
| 地址容器 | `div[class*="addressWrap--"]` | 点击后打开 `.ant-modal`（高德地图 iframe + 搜索框 + 常用/附近地址） |
| 地址搜索框 | `input[placeholder="搜索地点"]` | `input#search-input.search-input--SkYFms8d` |
| 地址候选 | `div[class*="addressItem--"]` | 条目内 `addressName--` 名称 + `addressDesc--` 描述 |

表单必填项：宝贝图片* / 宝贝描述* / 分类* / 价格* / 邮费* / 宝贝所在地（原价可选）。发货设置是 `.ant-radio-group`（包邮 / 按距离计费 / 一口价 / 无需邮寄 + 支持自提），值 0/1/2/3。

### 13.2 填写方式（为什么不是简单 setter）

- **富文本描述**：`focus` + `Range.selectNodeContents` 全选 → `Input.insertText`；多行用 `Input.dispatchKeyEvent`（key/code=Enter, windowsVirtualKeyCode 13）分段；填完回读 `innerText` 校验，不一致抛 `INTERNAL`。只用原生 value setter 对 contenteditable 无效。
- **React 受控 input**（价格）：`HTMLInputElement.prototype` 的 value setter + `input`/`change` 事件有效，值稳定。
- **地址搜索框**：setter + events **无效**（值立即被组件清空、不触发联想）→ 必须 `typeInto`（focus + 全选旧值 + `Input.insertText` 真实键入），然后按候选匹配点选。
- **图片上传**：`DOM.enable` + `DOM.getDocument(depth:-1)` + `DOM.querySelectorAll` + `DOM.setFileInputFiles`（等价用户选文件），约 4s 后缩略图出现。

### 13.3 地址搜索限制（重要，别当 bug）

- 页面用高德 `AMap.AutoComplete`（`restapi.amap.com/v3/assistant/inputtips`）。联想请求**确实发出且返回合法 tips**（ASCII 真实按键、中文 IME 合成、原生 setter+dispatch `input` 都能触发，keywords 正确、HTTP 200、JSONP 里含有效条目）。
- 但**候选列表 UI 在 CDP 下不回显搜索结果**：列表始终只有「常用地址」「附近地址」两块，`body.innerText` 里找不到返回的 tip。试过逐字按键 / IME 合成 / React props.onChange / 点搜索图标，均无效。
- 所以 `address` 必须能在现有候选里匹配到：`matchIndex` 先整串 `includes`，再退前 3 字前缀；匹配不到 → `VALIDATION`「地址候选里没有匹配…（看到：…）」fail-closed，绝不瞎点第一个。首次要把某地址变成「常用地址」，需人工在网页/App 选一次。
- 页面会恢复上次草稿（新开 `/publish` 后「宝贝所在地」可能已有值）；分类先由页面 AI 识别，缺省时不自动选类目，草稿给 `category` 时由 `stepSelectCategory` 点选并校验（§13.5）；真发布前 `stepCheckRequired` 等「分类」「宝贝所在地」非空，超时 `VALIDATION`。

### 13.4 校准记录（dry-run 全绿）

```sh
npm run daemon:publish -- --draft '.scratch/pubtest/draft-addr.json' \
  --screenshots '.scratch/pubtest/shots-addr3' --account-id 2206569289277
```

步骤：打开发布页 → 上传图片（2 张）→ 填写文案 → 填写价格（1 元包邮）→ 填写地址（目标「西北工业大学长安校区星天苑」→ 候选「…东祥路1号西北工业大学长安校区」→ 表单回读一致）→ dry-run 收尾，`durationMs≈5.1s`，`{dryRun:true, href:"https://www.goofish.com/publish"}`，截图在 `.scratch/pubtest/shots-addr3/`（01-open / 02-images / 03-text / 05-price / 06-address / 99-dry-run）。

### 13.5 类目下拉与网页端支持矩阵

分类是 antd Select（`.ant-select-single`），不是原生 select：

- 当前值在 `.ant-select-selection-item` 的 `title` 上；触发器是同一 `.ant-form-item` 里的 `.ant-select-selector`。
- **必须用可信鼠标事件**（`Input.dispatchMouseEvent` 的 mouseMoved → mousePressed → mouseReleased 打在触发器中心）才能打开下拉；`Runtime.evaluate` 里造的 `MouseEvent` / `el.click()` 都打不开。
- 选项是 body 级 portal 的 `.ant-select-item-option`，文本就是类目名；点选后 antd 把值写回 `.ant-select-selection-item`。
- **网页端按类目区分可用性**：选中不支持的类目后，分类下方**立刻**出现「网页版暂不支持发布此分类，请使用闲鱼APP扫码继续发布 点击展示二维码」（不必等提交）。
- 实测矩阵（2026-10-21，同一份「大学英语教材」草稿，页面先识别成 教材教辅）：
  | 类目 | 网页端 |
  | --- | --- |
  | 电子资料、学习笔记、课业本 | ✅ 可发布 |
  | 教材教辅、语言与兴趣培训、学习资料定制、文学/小说、考研咨询 | ❌ 提示改用 App 扫码 |
  | 期刊/杂志、生活百科 | 未取到可信结果（两次点击未生效），**待重测** |
- 实现：`packages/channel-cdp/src/category.ts`（`stepSelectCategory` / `readCategoryValue` / `assertCategoryPublishable` / `trustedClickAt`）。步骤顺序：等页面 AI 识别落定（避免被随后覆盖）→ 打开下拉 → 点选 `draft.category` → 回读校验 → 检查「不支持」提示；任一环节不符合就 fail-closed，**不点二维码、不退回提交去撞**。
- 选类目后页面提示「网页版暂不支持」时抛 `VALIDATION`，文案直接给「换类目或改用 App 扫码发布」。

### 13.6 首次真发布记录（成功）

- 草稿：文案「学习资料电子笔记 整理好的电子版资料 / 自动化测试商品，验证完立即下架，请勿拍。」+ 2 张占位 PNG + ¥1 + 包邮 + 地点「西北工业大学长安校区星天苑」（从常用地址点选）。
- 流程：传图 → 文案 → 等识别（学习资料定制，不支持）→ **手动选「电子资料」** → 价格/包邮 → 地址 → 点 `button[class*="publish-button"]` → URL 变为 `https://www.goofish.com/item?id=1093817229436`，页面出现「管理/下架/删除」。
- 该次发布抓到的接口事实（mtop 发布载荷字段、poi.get 按坐标取地址、badwords 预检、kgraph.property.recommend 分类候选）记录在 `docs/p1.3-plan.md` §4 与对应抓包脚本；**daemon 侧尚未接 mtop 发布**，CDP 仍是唯一写路径（ADR 0003）。
- 测试商品 `1093817229436` 已下架留档；真提交默认仍关（`BF_PUBLISH_SUBMIT`/CLI `--submit` 才开）。
