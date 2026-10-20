# @bigfish/core

纯 TypeScript 库：领域类型与跨包契约、错误、任务队列（SQLite）、商品仓储、发布前策略校验、限流熔断、凭据加密、脱敏日志、daemon 配置。

- **零第三方依赖**，Node ≥24 直接执行 `.ts`（无构建产物）。
- 导出入口 `src/index.ts`；含 `types / errors / risk / policy / data / items / runtime` 七个 barrel。
- 不允许 import electron / playwright / DSH；也不允许 import 其它 `@bigfish/*`（它是最底层）。

```ts
import { createTaskQueue, createItemRepository, loadDaemonConfig, RateLimiter, XianyuError, checkListing } from '@bigfish/core'
```

| 模块 | 出口 | 说明 |
| --- | --- | --- |
| `types.ts` | `TaskQueue / TaskRecord / TaskState / ItemSummary / DaemonStatus …` | 跨包契约 |
| `errors.ts` | `XianyuError / fail / toXianyuError / RETRYABLE` | 稳定 code |
| `risk.ts` | `classifyMtopRet` | mtop ret 风控分类 |
| `policy.ts` | `checkListing(ListingDraft)` | 发布前校验：长度/价格/违禁词 38/违禁类目 20/首图/图片数 |
| `store.ts` / `queue.ts` | `openStore / createTaskQueue` | SQLite WAL + 幂等入队 + 租约 |
| `items.ts` | `createItemRepository / isItemState` | 商品快照，`state ∈ online/offline/unknown` |
| `limiter.ts` | `RateLimiter`（write 1/60s、media 9/60s、read 30/60s） | 滑动窗口，**失败不退还预算** |
| `circuit.ts` | `CircuitBreaker` | 账号级熔断，默认 10 分钟，原子写盘 |
| `credentials.ts` | `CredentialStore` | AES-256-GCM，主密钥 0600 |
| `redact.ts` | `redact / redactString` | 日志与响应脱敏；**UUID 结构 id 原样保留** |
| `logger.ts` | `createLogger` | 单行 JSON，键序固定 |
| `config.ts` | `loadDaemonConfig(env, overrides)` | CLI 与测试共用 |

- 金额一律整数分，时间一律整数毫秒。
- 错误只用 `XianyuError` + `ERROR_CODES` 里的稳定 code。
- 测试：`node scripts/test-all.mjs packages/core`（112 条）。
