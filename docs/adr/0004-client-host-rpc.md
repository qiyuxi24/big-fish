# ADR 0004：面板 ↔ 宿主走 connection RPC 通道，不给第三方插件开 Typert namespace

- 状态：已采纳（2026-10-21，C2「面板实时数据 + 写操作入口」落地前定稿）
- 关联：[ADR 0001 基于 DSH](0001-base-on-dsh.md)、[ADR 0002 运行时契约](0002-p0-runtime-contract.md)
- 实现：`packages/plugin-ops/src/rpc.js`（桥）、`packages/plugin-ops/index.js`（`apply` 里挂载 `/bigfish`）；消费方是侧边栏 client bundle（`packages/plugin-ops/client.js`）

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
| `tasks.retry` | 写 | `client.retryTask(id)`，缺失时 `POST /tasks/:id/retry` | `id` |
| `batches.get` | 读 | `client.getBatch(id)`，缺失时 `GET /batches/:id` | `id` |
| `reference.collect` | 读（会写抓取结果） | `client.collectReferences(input)` | `accountId` 必填；`itemIds`(≤20, 去重) 或 `sellerId` 至少一个 |
| `settings.get` | 读 | `settingsStore.read()`，缺失时 `GET /settings` | 无 |
| `settings.put` | 写 | `settingsStore.write(patch)`，缺失时 `PUT /settings` | 白名单字段：`copyStyle`/`defaultCategory`/`defaultAddress`/`shipping`/`publishMinIntervalMs`(30000..3600000)/`maxBatchItems`(1..20)/`imageProvider{endpointUrl?,model?,enabled}` |
| `accounts.import` | 写 | `client.importAccount({accountId?,port?})` | `accountId`/`port` |
| `accounts.login` | 写 | `client.loginAccount({accountId?,port?})`，缺失时 `POST /accounts/login` | `accountId`/`port`/`timeoutMs(1..180000)` |
| `batch.enqueue` | 写 | 逐条 `client.enqueue(task)`（串行） | `batchId`、`items[]`(1..20)，每条 `kind`/`payload`/`dedupeKey`/`availableAt?`/`maxAttempts(1..10)` |

3. **写端点必须显式确认**：`tasks.retry`、`accounts.import`、`accounts.login`、`batch.enqueue`、`settings.put` 要求 `payload.confirm === true`，否则直接返回 `{ ok:false, error:{ code:'VALIDATION', message:'需要 confirm:true' } }`，且**不触达 daemon**。
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
| daemon 路由假设 | `GET/PUT /settings`、`GET /batches/:id`、`POST /tasks` 返回 `{task,created}`、`POST /tasks/:id/retry` | 路由改名时同步改 `rpc.js` 的 fallback 分支（都在同文件，便于 grep） |
| 鉴权 | 复用 `src/client.js` 的 Bearer + token 文件 | 面板出现多用户/远程访问时，另立鉴权 ADR |

## 验收（当前状态）

- 单测：`packages/plugin-ops/test/rpc.test.mjs`（白名单透传、写端点缺 `confirm` 拒绝、未知端点 `UNSUPPORTED`、客户端异常收敛信封、`ctx.effect` 卸载释放、无 `connection` 时降级不抛错）。
- 面板侧接线与 daemon 路由（`/settings`、`/batches/:id`、`POST /tasks` 的 `{task,created}`）由 C2/C3 落地；本文锁的是「通道 + 白名单 + `confirm`」这一层契约。
