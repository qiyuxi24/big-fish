# @bigfish/daemon

独立 Node 进程（**不调 LLM**）：本机 HTTP 控制面 + SQLite 任务队列 + CLI。

```sh
node packages/daemon/src/cli.ts --data-dir .scratch/daemon --port 47001
```

- `startDaemon({config, queue, now?, version?})` → `{url, port, close, status}`；只绑回环地址。
- 路由：`/health`（免鉴权）、`/status`、`/tasks`、`/tasks/:id`、`ack/fail/release`、`/items`、`/circuits/reset`。
- 鉴权：Bearer token 文件（默认 `<dataDir>/daemon.token`，32 字节 hex，0600），`timingSafeEqual` 比较。
- `DaemonClient` 供其它 Node 侧代码调用；插件不用它（插件自带零依赖 JS client）。
- 出站响应与日志统一过 `redact`，cookie/token 不外泄。
- 测试：`node scripts/test-all.mjs packages/daemon`（32 条，真 HTTP + 临时目录，不依赖真实闲鱼）。

**P0 没有执行器**：只落库，不领取任务去执行。
