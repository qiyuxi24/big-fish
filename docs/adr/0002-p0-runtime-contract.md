# ADR 0002：P0 运行时契约（零第三方依赖 / 无构建 / 插件用 JS）

- 状态：已采纳（P0）
- 日期：2026-10-20
- 关联：[ADR 0001 基于 DSH 二次开发](0001-base-on-dsh.md)

## 背景

P0 要证明三件事：插件能被**真的 DSH loader** 装配；daemon 能作为独立进程跑；队列、限流、熔断、凭据能单测。

两个硬约束决定了技术选型：

1. **安装不可靠。** 本机 registry 不可达，`pnpm install` 必须加 `--offline --ignore-scripts`；给 plugin-ops 写 `peerDependencies: @deepseek-ai/dsh-tools` 会直接 `ERR_PNPM_NO_OFFLINE_META`。
2. **宿主不可控。** 插件最终被 DSH 宿主 import，宿主的 Node 版本与打包形态（Electron）不由我们决定，不能假设它支持 TypeScript 类型擦除。

## 决策

1. **core / daemon 用 TypeScript，不做构建。** Node ≥24 直接执行 `.ts`（类型擦除）；`package.json` 的 `exports` 指向 `./src/index.ts`，没有 tsc 产物、没有 dist/。
2. **plugin-ops / ops-bundle 用纯 ESM JavaScript + JSDoc。** 插件是唯一被宿主 import 的代码，纯 JS 把"宿主是否支持类型擦除"这个变量删掉。
3. **插件不 import `@bigfish/core`。** 插件自带最小的 DaemonError 与错误码映射；跨进程只走 HTTP 契约，不共享内存类型。
4. **运行时零第三方依赖。** 只用 `node:http` / `node:sqlite` / `node:crypto` / 全局 `fetch` / 全局 `WebSocket`。
5. **测试用 `node:test`，不用 vitest。** 沙箱禁止 spawn 子进程，而 `node --test` 会 spawn；`scripts/test-all.mjs` 在**单进程内顺序 import** 所有 `*.test.ts|mjs`。
6. **类型检查借用 DSH checkout 的 tsc。** `scripts/typecheck.mjs` 依次探测 `BF_TSC` → 本地 `node_modules` → checkout 的 `typescript/bin/tsc`，并把 `--typeRoots` 指向 checkout 的 `@types/node`。

## 为什么

- **零依赖让「clone 即可跑」成立**：不需要 registry、不需要 postinstall、不需要锁文件之外的网络。
- **无构建 = 无产物漂移**：改代码立刻被测试和插件加载；不存在"改了 src 忘了 build"的排查成本。
- **纯 JS 插件是集成风险最小化**：`scripts/dsh-dump.mjs` 已在真 loader 里验证装配成功，这是 P0 的验收线。

## 代价与替换触发条件

| 需要 | P0 做法 | 何时换 |
| --- | --- | --- |
| 参数校验 | 手写 narrow 函数，边界只出现 `unknown` | 工具/接口数上到 20+ 且能装依赖时引入 zod |
| SQLite | `node:sqlite`（实验 API，Node ≥22.5；本仓要求 Node 24） | 需要加密或遇到性能瓶颈时换 `better-sqlite3` |
| HTTP 服务/客户端 | `node:http` + 全局 `fetch` + `AbortSignal.timeout` | 不需要 |
| WebSocket（P1 IM） | Node ≥22 全局 `WebSocket` 客户端 | 需要底层握手/自定义扩展时再评估 `ws` |
| 测试 | `node:test` + 单进程加载脚本 | 需要覆盖率阈值或生态插件时换 vitest |
| 类型检查 | 借用 checkout 的 tsc | 仓库能安装 devDependencies 后改为本地 tsc |

## 已知缺口

- `node:sqlite` 是实验 API，升级 Node 大版本必须回归。
- 插件 JS 没有类型检查，只有单测与集成测试兜底（错误在运行期才暴露）。
- 发布到真实 DSH profile 时用 `link:`/`file:` 引用源码包，还没有正式的发版打包（P2 再定 Electron 或 headless）。

## 验收（当前状态）

```sh
node scripts/test-all.mjs      # 122 tests / 122 pass / 0 fail
node scripts/typecheck.mjs     # core、daemon 通过
node scripts/dsh-dump.mjs --smoke  # 真 loader 装配 + 7 个工具注册 + 门禁挂载
```
