# @bigfish/plugin-ops

Cordis 插件：给 agent 提供 7 个 `xy_*` 工具 + 写操作审批门禁。

- **纯 ESM JavaScript + JSDoc，零依赖、零构建**——它是被 DSH 宿主直接 import 的代码。
- `export const inject = ['tools']`；`apply(ctx, config)` 里注册工具与 `tools/pre-execute` 门禁。
- 不 import `@bigfish/core`：自带最小 DaemonError 与错误码映射，跨进程只走 HTTP。
- 配置（来自 bundle 的 patch 或 profile 配置）：`daemonUrl`（默认 `http://127.0.0.1:47001`）、`tokenPath`（默认 `<dataDir>/daemon.token`）、`timeoutMs`（默认 15000）、`writeGate`（默认 true）。

工具：`xy_ping` / `xy_daemon_health` / `xy_status` / `xy_tasks_list` / `xy_task_enqueue` / `xy_task_action` / `xy_items_list`。

写类工具（`xy_task_enqueue` 且 `kind ∈ publish/deliver/polish`）会返回 `{kind:"ask"}` 等用户确认。

- 测试：`node scripts/test-all.mjs packages/plugin-ops`（21 条，fake ctx + stub HTTP server）。
