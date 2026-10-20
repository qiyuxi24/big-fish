# @bigfish/daemon

独立 Node 进程（**不调 LLM**）：完整运行时装配 + 本机 HTTP 控制面 + SQLite 任务队列 + worker + CLI。

```sh
node packages/daemon/src/cli.ts --data-dir .scratch/daemon --port 47001
```

## 运行时（src/runtime.ts）

`startDaemonRuntime({config, transport?, ports?, owner?, autoStartWorker?})` → `{daemon, worker, store, queue, items, credentials, limiter, circuits, refreshAccounts(), close()}`。

装配顺序：`openStore → createTaskQueue → createItemRepository → CredentialStore → RateLimiter → CircuitBreaker → createOperationPort（可注入假 transport）→ createExecutors → startWorker → startDaemon`。失败时逐层回收；`SIGINT` 先停 worker 再关 HTTP 与 store。

## worker（src/worker.ts）

`startWorker({queue, executors, owner, leaseTtlMs?, pollIntervalMs?, concurrency?, now?, logger?, autoStart?})`：

- 单轮按 `concurrency`（默认 1）领租约；**同一 `payload.accountId` 串行**，冲突任务立即 release 并记 skipped。
- `stop()` 幂等：停止领取并 abort 在飞任务（被 abort 的 release，不计失败）。
- 不可重试集合：`VALIDATION | AUTH_EXPIRED | UNSUPPORTED | INTERNAL | UNAUTHORIZED | UNKNOWN`；`RISK_CONTROL` 额外 trip 熔断并带 `retryAfterMs`。
- 不做租约续约，>leaseTtlMs 的长任务可能被重复领取 → **执行器必须幂等**。

## 执行器（src/executors.ts + src/operations.ts）

统一顺序：校验 → 熔断 → 限流桶 → 凭据 → 通道。

| kind | 桶 | P1.1 状态 |
| --- | --- | --- |
| probe | read | ✅ mtop 详情，成功后 upsert 商品 |
| polish | write | ✅ mtop 擦亮 2.0 |
| publish | write | ⛔ `UNSUPPORTED`（P1.2），入口已跑 `checkListing` |
| deliver / reply | write | ⛔ `UNSUPPORTED`（P2） |

`createFetchTransport(fetchImpl?)` 是唯一真网络出口；测试用 `ports` 注入假通道。

## HTTP 面

- `startDaemon({config, queue, items?, accounts?, circuits?, worker?, now?, version?})` → `{url, port, close, status}`；只绑回环地址。
- 路由：`/health`（免鉴权）、`/status`（队列/账号/熔断/worker）、`/tasks`、`/tasks/:id`、`ack/fail/release`、`/items?state&accountId&limit`、`/circuits/reset`。
- 鉴权：Bearer token 文件（默认 `<dataDir>/daemon.token`，32 字节 hex，0600），`timingSafeEqual` 比较。
- `DaemonClient` 供其它 Node 侧代码调用；插件不用它（插件自带零依赖 JS client）。
- 出站响应与日志统一过 `redact`；UUID 结构 id 不会被误掩。
- 测试：`node scripts/test-all.mjs packages/daemon`（69 条，真 HTTP + 真 SQLite + 假 mtop transport，不依赖真实闲鱼）。
