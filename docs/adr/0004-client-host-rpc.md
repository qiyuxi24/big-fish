# ADR 0004：面板 ↔ 宿主走 connection RPC 通道，不给第三方插件开 Typert namespace

- 状态：已采纳（2026-10-21，C2「面板实时数据 + 写操作入口」落地前定稿）
- 关联：[ADR 0001 基于 DSH](0001-base-on-dsh.md)、[ADR 0002 运行时契约](0002-p0-runtime-contract.md)
- 实现：`packages/plugin-ops/src/rpc.js`（端点表 + 桥）、`packages/plugin-ops/index.js`（`apply` 里挂载 `/bigfish`）；消费方是侧边栏 client bundle（`packages/plugin-ops/client.js`）。2026-10-24 起契约/校验在 `rpc-schema.js`、端点实现在 `rpc-endpoints.js`（拆分理由：文件 ≤400 行，对外契约不变）

## 背景

侧边栏面板（`sidebar.panellist` + `main`）要展示「实时数据」并触发少量写操作：队列状态、账号列表、任务列表、最近批次、条目详情、采集统计、设置读写，以及重试/导入/扫码登录/批量入队。

DSH 宿主给插件的客户端能力只有两类入口：

1. **Typert namespace / 工具**：宿主对第三方插件**只开放公开扩展点**（AGENTS §4），Typert namespace 属于内部契约，第三方无法声明、版本一升就断；
2. **`ctx.connection.rpc`**：宿主公开的连接层通道，签名是 `rpc.handle(channel, handler)`，`handler` 返回 `{ ok: true, value }` 或 `{ ok: false, error }`。

同时 client bundle 跑在**渲染进程沙箱**里：只能 `require` 宿主的 9 个静态模块，禁止 `document`/`localStorage`/`fetch(`（AGENTS §4，且 client 单测会断言这三样不出现）。它不能直连 daemon（token 在磁盘上、也拿不到 node 的 `http`），所以必须由 host 侧代转。

## 决策

1. **唯一通道是 `ctx.connection.rpc`，频道名 `/bigfish`**。`apply` 里注册：

   ```js
   ctx.connection.rpc.handle('/bigfish', bridge.handle)
   ```

   注册包在 `ctx.effect` 里，插件卸载时自动释放；宿主没有 `connection` 服务时**只打一行 info 并跳过**，工具照常注册（面板实时数据降级，不影响 14 个 `xy_*` 工具）。
2. **桥只有一张白名单表**（`createRpcBridge({ client, settingsStore?, endpoints? })`），端点到 daemon 客户端的映射写死：

| endpoint | 读写 | 落点 daemon 客户端 | 允许字段 |
| --- | --- | --- | --- |
| `health` | 读 | `client.health()` | 无 |
| `status` | 读 | `client.status()` | 无 |
| `accounts` | 读 | `client.listAccounts()` | 无 |
| `items.list` | 读 | `client.listItems()` | 无 |
| `tasks.list` | 读 | `client.listTasks(filter)` | `state`/`kind`/`limit(1..200)` |
| `events.list` | 读 | `client.listEvents(filter)` → `GET /events` | `since`(≥0)/`limit`(1..1000)/`taskId`/`batchId`；返回 `{items,nextSince}` |
| `tasks.retry` | 写 | `client.retryTask(id)`，缺失时 `POST /tasks/:id/retry` | `id` |
| `batches.get` | 读 | `client.getBatch(id)`，缺失时 `GET /batches/:id` | `id` |
| `reference.collect` | 读（会写抓取结果） | `client.collectReferences(input)` | `accountId` 必填；`itemIds`(≤20, 去重) 或 `sellerId` 至少一个 |
| `reference.parseLink` | 读 | `client.resolveLink(link)` → `POST /resolve` | `link` 必填（≤2048 字符）；格式由 daemon 的 `parseXianyuLink` 判 |
| `seller.collect` | **写**（落库 `seller_items`/`sellers`） | `client.collectSeller(input)` → `POST /sellers/collect` | `accountId`/`sellerId` 必填；`maxItems`(1..60)/`acknowledgeOther`；必须 `confirm:true` |
| `market.brief` | 读 | `client.marketBrief(input)` → `POST /market/brief` | `categoryId`(≤64)/`sellerId`(纯数字)/`limit`(1..500)/`condition`(成色枚举)；返回已入库他人商品的价格带/结构/建议价统计 |
| `browser.status` | 读（真探端口） | `client.browserStatus()` → `GET /browser` | 无 |
| `sellers.list` | 读 | `client.listSellers()` → `GET /sellers` | 无 |
| `seller.items` | 读 | `client.listSellerItems(sellerId, limit?)` → `GET /sellers/:id/items` | `sellerId` 纯数字必填；`limit`(1..500) |
| `settings.get` | 读 | `settingsStore.read()`，缺失时 `GET /settings` | 无 |
| `settings.put` | 写 | `settingsStore.write(patch)`，缺失时 `PUT /settings` | 白名单字段：`copyStyle`/`defaultCategory`/`defaultAddress`/`shipping`/`publishMinIntervalMs`(30000..3600000)/`maxBatchItems`(1..20)/`imageProvider{endpointUrl?,model?,enabled}` |
| `accounts.verify` | 读（真调一次 mtop，可能触发 `_m_h5_tk` 刷新并回写凭据） | `client.verifyAccount(accountId)`，缺失时 `POST /accounts/:id/verify` | `accountId` 必填；返回 `{accountId, online, checkedAt, refreshed, code?, message?}` |
| `accounts.import` | 写 | `client.importAccount({accountId?,port?})` | `accountId`/`port` |
| `accounts.login` | 写 | `client.loginAccount({accountId?,port?})`，缺失时 `POST /accounts/login` | `accountId`/`port`/`timeoutMs(1..180000)` |
| `batch.enqueue` | 写 | 逐条 `client.enqueue(task)`（串行） | `batchId`、`items[]`(1..20)，每条 `kind`/`payload`/`dedupeKey`/`availableAt?`/`maxAttempts(1..10)` |
| `daemon.start` | 写（拉起本地进程） | `supervisor.ensure('panel', {force:true})`（`plugin-ops/src/daemon-control.js`） | 无（空对象） |
| `daemon.stop` | 写（关停本地进程） | `POST /shutdown` → 250ms 轮询 `/health` 到不可达（同文件 `stopDaemon`） | 无（必须 `confirm:true`） |

3. **写端点必须显式确认**：`tasks.retry`、`accounts.import`、`accounts.login`、`batch.enqueue`、`settings.put`、`seller.collect`、`daemon.stop` 要求 `payload.confirm === true`，否则直接返回 `{ ok:false, error:{ code:'VALIDATION', message:'需要 confirm:true' } }`，且**不触达 daemon**。
4. **未知端点一律 `UNSUPPORTED`**；payload 先窄化再转发，未知字段**永不**透传（防模型幻觉把 `cookie`/`token` 之类字段塞进 daemon 请求）。
5. **`handle` 永不向宿主抛错**：任何异常都收敛成 `{ ok:false, error:{ code, message, details? } }`，`code` 只用仓库稳定枚举，未知异常收敛为 `INTERNAL` 且不带栈。
6. **面板侧是轮询，不是订阅**：client 按需调用端点并设自己的刷新间隔；写操作成功后触发一次重取。宿主的 RPC 通道没有推送语义，伪造推送等于自建一层易漂移的总线。
7. **`batch.enqueue` 串行入队**：单账号写操作必须串行（AGENTS §1.3），并且每条都带账号级 `availableAt`，避免面板批量入口绕开 daemon 侧的节奏保护。

## 为什么

| 维度 | Typert namespace | 自建轮询 RPC（采纳） |
| --- | --- | --- |
| 第三方可用性 | 不可用：非公开契约，宿主升级即断 | 可用：`ctx.connection.rpc` 是公开连接层 |
| 类型/校验 | 依赖宿主生成，第三方拿不到 | 手写窄化，符合 AGENTS「`unknown` + 窄化」 |
| 传输实现 | 需要理解宿主内部路由 | 一行 `rpc.handle`，卸载走 `ctx.effect` |
| 安全边界 | 由宿主 namespace 隐式决定 | 白名单 + `confirm` + 字段丢弃，显式可审 |
| 实时性 | 可推送 | 轮询（数据量小、面板可见时才拉） |

**为什么频道名不是 `/api`**：DSH Gateway 已占用 `/api`，`rpc.intercept('/api')` 会抛 `channel already has an interceptor`。这不是可配置项，直接换成 `/bigfish`，并在 `apply` 里对注册失败做降级（只告警、不影响工具），因为面板实时数据是增强项而非发布链路的一部分。

**为什么读端点也走白名单而不做通用转发**：通用转发等于把 daemon 的 Bearer token 暴露成一个「任意路径」代理；面板代码一旦被注入（或模型幻觉构造参数），就能打任意 daemon 路由。白名单让「面板能做什么」在源码里一次看全。

## 代价与替换触发条件

| 需要 | 现在 | 何时换 |
| --- | --- | --- |
| 新增面板能力 | 在 `createDefaultHandlers` 表里加一行 + client 侧加调用 | 端点超过 ~20 个且出现重复字段校验时，抽共享 schema |
| 实时推送（任务进度、日志） | 轮询（面板可见时） | 宿主公开订阅/事件通道后，改为订阅 + 断线重连 |
| 设置持久化 | 优先注入 `settingsStore`，否则退回 daemon `GET/PUT /settings` | daemon 侧设置落地后，面板不再直连磁盘 |
| daemon 路由假设 | `GET/PUT /settings`、`GET /batches/:id`、`POST /tasks` 返回 `{task,created}`、`POST /tasks/:id/retry` | 路由改名时同步改 `rpc-endpoints.js` 的 fallback 分支（端点实现都在该文件，便于 grep） |
| 鉴权 | 复用 `src/client.js` 的 Bearer + token 文件 | 面板出现多用户/远程访问时，另立鉴权 ADR |

## 已知阻塞：宿主 0.1.5-rc.2 的 connection 插件不给自己 inject webServer（2026-10-22 实测）

**现象**：外部插件执行 `ctx.connection.rpc.handle('/bigfish', handler)` 必抛
`cannot get property "webServer" without inject`；面板因此只显示「未连接后台（daemon 未启动）」一行。
`POST /bigfish/health` 返回 **405**（路由根本没注册）。

**根因**（DSH checkout `C:/Users/34239/Documents/GitHub/deepseek-harness`）：
`packages/client/connection/src/rpc-host.ts:80` 的 `get rpc()` 取的是 `const owner = this.ctx`——即 **connection 插件自己的 ctx**，
而不是调用方传进来的 ctx；同文件 `:178-181` 注册时执行 `owner.webServer.register(route)`。
而 connection 插件的 `inject` 只有 `['credentials']`（`packages/client/connection/src/index.ts`），所以 owner ctx 上取不到
`webServer`。**这不是本仓库能绕开的**：不用 `rpc.handle` 就只剩「自建 HTTP 路由（client 侧被禁 `fetch(`）或 Typert namespace（不可用）」两条死路。

**取证时验证过的宿主修法（仅用于证明根因；改动已全部还原，未提交到任何仓库）**：把 connection 插件 `inject` 改成 `['credentials','webServer']`，
同时改编译产物 `lib/index.js` 对应行，重启 host → `/bigfish` 注册成功，面板渲染出真实数据：
daemon 在线 · v0.0.0 · 已运行 12 分钟、账号 1/1 可写、队列 0/0/1/1/0、批次 `b-e2e-mvj2gf5w`、设置 plain/未设置/180 秒
（截图 `.scratch/shots/panel-online.png`；未打补丁的降级态 `.scratch/shots/panel-offline.png`）。改动已全部还原，checkout 干净。

**建议的正式修法（二选一，在 DSH 侧）**：
1. connection 插件 `inject` 增加 `webServer`（最小改动，与现状注册路径一致）；
2. `get rpc()` 不再用 `this.ctx`，改由调用方把 ctx 传进来（例如 `rpc.handle(channel, handler, { ctx })` 或注册时显式传 ctx）。

### 插件侧绕过：自建 webServer 兼容路由（2026-10-22 已实现，随 `@bigfish/plugin-ops` 发布）

不能改用户安装的宿主，也不能让面板一直降级，所以插件自己注册一条与宿主 `rpcFetchHandler` **同协议**的 HTTP 路由：

- **注册顺序**（`packages/plugin-ops/index.js` 的 `registerRpcChannel`）：先走官方 `ctx.inject(['connection'], …)` → `rpc.handle('/bigfish', bridge.handle)`；
  官方通道缺失或抛错（命中上面这个宿主 bug）才回退 `ctx.inject(['webServer','connection'], …)`，用 `webServer.register` 注册 `createPanelRoute(...)`。
  宿主修好后自动走官方通道，插件不用改。
- **路由与信封**：`packages/plugin-ops/src/host-route.js` 的 `createPanelRoute` 返回 `{ kind: 'prefix', path: '/bigfish', handler }`；
  请求体 `{ type: 'client-request', rpcId, method, payload }`，响应 `{ type: 'server-response', rpcId, result }`，`result` 即 `bridge.handle` 的 `{ ok: true, value }` / `{ ok: false, error }`。
  client bundle 一行不用改（它只认 `ctx.connection.rpc.call('/bigfish', endpoint, payload)`）。
- **鉴权 fail-closed**：每个请求先调 `connection.requestRejection(req)`（宿主公开方法，内部查 trusted host + 浏览器 cookie）：
  返回 403/401 就直接回 `forbidden` / `unauthorized`，**绝不**无鉴权暴露 daemon 数据；拿不到 `requestRejection` 就拒绝注册路由（记一条 warn，面板保持降级）。
- **与宿主 rpcFetchHandler 对齐**：非 POST 或缺 endpoint → 404；content-type 主类型不是 `application/json` → 415；JSON 解析失败 → 400；
  信封不合法或 `method !== endpoint` → **HTTP 200 + `gateway/bad-request` 错误信封**（与宿主一致，client 才能按同一逻辑解析）；
  `bridge.handle` 抛错 → 500 `handler failure: ...`；请求体上限 1 MiB / 15 s（超限 413 / 408）。
  endpoint 段只允许 `[A-Za-z0-9_$.-]`、禁空段与 `.`/`..`、不做 percent 解码（与宿主 `endpointFromPath` 一致）。
- **卸载与中断**：注册包在 `webCtx.effect(() => webServer.register(route), …)` 里，插件卸载自动释放；client 断开（res close）会 abort 透传给 `bridge.handle` 的 signal。
- **日志**（单行 JSON，稳定字段）：成功 `{ msg: "面板 rpc 通道已启用 webServer 兼容路由（绕过 DSH 已知宿主 bug…）", rpcChannel: "registered-webServer", hostBug: true }`；失败才 warn。
  **注意**：真实 Cordis 的 `ctx.inject` 回调是异步的，`apply` 同步返回的加载汇总日志里 `rpcChannel` 仍是 `"deferred"`，真正状态看随后那条 info/warn；排障时不要只看第一行。
- **验证**：`packages/plugin-ops/test/host-route.test.mjs`（13 条，直接挂 `node:http`，覆盖 401/403/404/415/400/413、信封回显、method 不匹配、bridge 抛错、abort）
  + `test/rpc.test.mjs` 的「命中宿主 bug 时回退兼容路由」用例；隔离 dev host 实测（`node scripts/dsh-dev.mjs`，127.0.0.1:47080）：
  server.log 出现上面那条 info 且无 webServer warn；带登录 cookie `POST /bigfish/health` 返回 200 与真实 daemon 数据，无 cookie 返回 401。
  （本会话沙箱禁止 spawn 浏览器，桌面截图这一步需在非沙箱环境重启 DSH 后人工确认。）

**当前状态**：面板实时数据不再依赖宿主补丁——插件侧兼容路由已随 `@bigfish/plugin-ops` 生效；发布链路（工具 + daemon）不受影响。
桌面端需重启一次 DSH 进程（运行中的进程没有新插件代码）。宿主修好后（上面二选一）自动回到官方通道，插件侧路由成为兼容旧宿主的回退路径。

## 验收（当前状态）

- 单测：`packages/plugin-ops/test/rpc.test.mjs`（白名单透传、写端点缺 `confirm` 拒绝、未知端点 `UNSUPPORTED`、客户端异常收敛信封、`ctx.effect` 卸载释放、无 `connection` 时降级不抛错；宿主 bug 时回退 webServer 兼容路由）。
- 兼容路由：`packages/plugin-ops/test/host-route.test.mjs`（node:http 直挂路由，覆盖鉴权、路径解析、415/400/413/500、信封与 signal）。
- 面板侧接线与 daemon 路由（`/settings`、`/batches/:id`、`POST /tasks` 的 `{task,created}`）由 C2/C3 落地；本文锁的是「通道 + 白名单 + `confirm`」这一层契约。
