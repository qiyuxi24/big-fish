# @bigfish/core

纯 TypeScript 库：领域类型与跨包契约、错误、任务队列（SQLite）、限流熔断、凭据加密、脱敏日志、daemon 配置。

- **零第三方依赖**，Node ≥24 直接执行 `.ts`（无构建产物）。
- 导出入口 `src/index.ts`；含 `types / errors / data / runtime` 四个 barrel。
- 不允许 import electron / playwright / DSH；也不允许 import 其它 `@bigfish/*`（它是最底层）。

```ts
import { createTaskQueue, loadDaemonConfig, RateLimiter, XianyuError } from '@bigfish/core'
```

- 金额一律整数分，时间一律整数毫秒。
- 错误只用 `XianyuError` + `ERROR_CODES` 里的稳定 code。
- 测试：`node scripts/test-all.mjs packages/core`（67 条）。
