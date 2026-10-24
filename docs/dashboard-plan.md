# 看板（数据可视化）实施计划

> 状态：**图表与 `/metrics` 仍未动工**（2026-10-23 起草，同日面板 tab 重排落地，见 §0.1）；本文件是支线计划，**不是主线路线图**。主线排期看 [`docs/STATUS.md`](STATUS.md) §4.4 施工队列，验收口径看 [`docs/auto-publish.md`](auto-publish.md)。

## 0.1 已落地（2026-10-23 面板重排，不含图表）

面板从「6 个扁平 tab（自动发布/账号/文案/采集/概览/诊断）」重排为**按功能的 6 个 tab、三组**，`概览` 不再是占位：

| 组 | tab | 内容 | 用到的 rpc（全部已存在） |
| --- | --- | --- | --- |
| 监控 | 概览（默认） | daemon 状态卡（health/账号/队列/**worker 计数**/最近批次）+ 待办提醒（失败·待审·凭据不全·**熔断**）+ 工作流树 + 系统区（进程管理 / 设置 / 工具与命令） | `health` `status` `accounts` `settings.get` `tasks.list` `batches.get` `events.list` `daemon.start` `daemon.stop` `settings.put` |
| 准备 | 账号 | 账号表 + 导入/扫码/退出/切换/校验 + 保活 + 托管浏览器 | `accounts.*` `browser.status` |
| 准备 | 采集 | 链接解析 → 入库 → 商家/商品表 + **行情简报**（价格带/建议价/结构/高频词） | `reference.parseLink` `seller.collect` `sellers.list` `seller.items` **`market.brief`** |
| 准备 | 文案 | 品类 + 字段勾选 + 风格 → `xy_copy_plan` 参数 | `copy.templates` |
| 作业 | 发布 | 草稿集 → 校验 → 入队 → **任务表（state/kind 筛选，参数交给 daemon）+ 重试**；发货/客服置灰占位 | `batch.enqueue` `tasks.list` `tasks.retry` |
| 作业 | 商品 | 自有商品快照 + 勾选后入队 **polish（擦亮）/ probe（探测）** | **`items.list`** `batch.enqueue` |

概览的「待办提醒」**只用现有字段**（`/status` 的 `queue`、`accounts`、`circuits`）算，没有趋势、没有失败原因 Top、没有成功率 —— 因为 daemon 还没有聚合端点。**不要在面板里编造这些数字**。

## 0. 一句话结论

现成渲染库有、且能离线用：**把 ECharts 5.5.1（Apache-2.0，min 1.03MB）vendor 进 plugin host，服务端 SSR 出 SVG**，面板「概览」tab 直接渲染；纯数字卡 + 5 块图 + 批次进度。全屏交互页（daemon 出 HTML）作为第二阶段可选，卡在 token 鉴权，不建议现在做。

## 1. 现在缺什么（已核实，非猜测）

| 缺口 | 位置 | 现状 |
| --- | --- | --- |
| 概览 tab 只有驾驶舱、没有图表 | `packages/plugin-ops/src/client-bundle/08-panel.part.js`（`overview` 分支已存在，2026-10-23 重排） | 只有状态卡 + 待办提醒 + 工作流；没有趋势 / 状态占比 / 失败 Top，数据来自 `/status` + `/tasks` 的当前态 |
| 没有批次进度可视化 | `docs/STATUS.md:108` 明写「没做 ④ 批次进度可视化（`batches.get` 已能读）」 | 任务表只有单条任务 |
| 没有聚合数据端点 | daemon 只有 `GET /status`、`/accounts`、`/batches/:id`、`/events`、`/tasks` | `/tasks` 是原样列表（limit≤200、带完整 payload），不适合在面板里做聚合 |
| 没有推送 | 无 SSE/WS | 面板只能轮询（`POLL_MS=3000`） |
| 「任务完成」≠「已上架」 | dry-run 是 daemon 全局配置（`packages/daemon/src/operations.ts:150-158`，`dryRun` 优先） | 任务 payload 里没有 dryRun/submit 快照，`state=done` 无法区分「真发成功」与「dry-run 走完」 |
| 宿主没有图表能力 | 宿主 client bundle 只允许 require 9 个静态模块，`@deepseek-ai/dsh-client-ui-primitives` 无任何图表组件 | 宿主自身也 0 命中 echarts/recharts/chart.js/d3/mermaid |

**能用的数据**：`DaemonStatus`（`packages/core/src/types.ts:161-176`：daemonRunning/pid/queue/accounts/lastError）、`BatchStats`（`queued/leased/done/failed` + items）、`events` 分页（`seq/limit`）。

## 2. 依赖策略（关键约束，先看这个）

- **不能 `pnpm add`**：本机 `ops_bash` spawn 出去的进程没有外网（`curl registry.npmjs.org` → 000），registry 不可达；`run_code` 的 Node `fetch` 才有网。
- 因此依赖只能**下载后 vendor 入库**：`cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js`（实测 200，**1,030,855 bytes**）。
- 体积 1.03MB < AGENTS §6 的 2MB 上限，可以提交；但 **AGENTS §2 写死「运行时零第三方依赖」，新增依赖必须先补 ADR**（说明为什么 node 内置不够、体积、离线安装怎么办）→ `docs/adr/0005-vendor-echarts.md`（编号顺延，若 0005 被文案/生图占用则往下排）。同时 vendor `LICENSE`/`NOTICE`（Apache-2.0 要求保留声明）。
- **ECHARTS 只能跑在 host 侧（Node）**：client bundle 里 `require` 不了第三方包（loader 只给 9 个静态模块），所以「客户端 ECharts」需要引入 esbuild 构建链——这是路线 2 的主要成本。

## 3. 三条路线对比

| # | 方案 | 效果 | 工期 | 主要成本/风险 |
| --- | --- | --- | --- | --- |
| 1 | **服务端 ECharts SSR**（vendor 到 plugin host，`echarts.init(null, null, {renderer:'svg', ssr:true})` + `renderToSVGString()`，client 只 `dangerouslySetInnerHTML` 塞 SVG） | ECharts 品质的静态图，无 hover/tooltip | ~1.5 天 | 1MB 入库 + 1 个 ADR；图不可交互 |
| 2 | **客户端 ECharts**（新增 esbuild 构建链把 echarts 打进 client.js） | 最好：tooltip/动画/缩放/点击下钻 | ~3 天 | 改插件装配方式（client.js 变成构建产物）、测试基线 `client-bundle.test.mjs` 要大改、bundle 1.1–1.3MB |
| 3 | **独立全屏看板页**（daemon `GET /dashboard` 直接吐自包含 HTML） | 整页最漂亮 | ~1 天 | daemon 现在只发 JSON（`packages/daemon/src/http.ts` 的 `JSON_CONTENT_TYPE`），要加 HTML 路由；**token 鉴权要进 query（会泄露到历史/日志）或只信 localhost**；宿主对插件 iframe/asset 无先例 |

**推荐：路线 1 先落地（面板内数字卡 + SSR 小图 + 批次进度），把「数据层」一次做对；路线 3 押后到真有人要看全屏时再说。**

实测证据（2026-10-23 在 `.scratch` 里跑通）：Node 24 下 `echarts.init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 150 })` + `chart.renderToSVGString()` → **5,515 bytes SVG**，不需要 canvas/DOM。
⚠️ 踩过的坑：根 `package.json` 是 `"type":"module"`，直接 `require` 一个 `.js` UMD 会被当 ESM 解析 → 返回空对象（`echarts.init is not a function`）。**vendor 目录必须自带 `package.json`**（`{"name":"echarts","version":"5.5.1","main":"echarts.min.js"}`，**不要写 type**），让它按 CJS 解析。

## 4. 数据层设计（先做，独立于 UI）

### 4.1 `GET /metrics?days=7`（只读）

- 聚合逻辑放 **`packages/core/src/stats.ts`（纯函数，注入 `now` 与行数组）**，daemon 只负责取数：新 `packages/daemon/src/metrics.ts` 读 `tasks` 表 → 调 core 聚合 → 返回。
- 契约（响应体）：

```json
{
  "generatedAt": 0,
  "range": { "days": 7, "fromMs": 0, "toMs": 0 },
  "tasks": { "total": 0, "byState": { "queued": 0, "leased": 0, "done": 0, "failed": 0 }, "byKind": { "publish": 0 }, "successRate": 0, "retried": 0 },
  "publish": { "dryRun": 0, "submitted": 0, "unknown": 0, "failed": 0 },
  "accounts": { "total": 0, "ready": 0, "online": 0, "expired": 0 },
  "batches": { "total": 0, "active": 0, "last": { "batchId": "", "total": 0, "done": 0, "failed": 0 } },
  "failures": [ { "code": "RISK_CONTROL", "count": 0 } ],
  "trend": [ { "date": "2026-10-23", "queued": 0, "done": 0, "failed": 0 } ]
}
```

- 边界：`days` 夹 1..90，默认 7；空库返回全 0（不报错）；单条 payload 损坏只跳过该条。
- `accounts.online` 只统计**最近一次检测结果**（来自 account-state 缓存），detect 不到就只算 ready——**不在这里主动打 mtop**（读端点不能有副作用）。

### 4.2 入队时快照 dryRun/submit（不改 schema，塞 payload）

- 位置：`packages/daemon/src/operations.ts` 发布执行器读取配置的地方（`operations.ts:150-158`）向前一步——在 `POST /tasks` 建任务时把 `{ dryRun, submit }` 快照写进 `payload`（`BF_PUBLISH_DRYRUN` / `BF_PUBLISH_SUBMIT` 解析在 `packages/daemon/src/cli.ts:229-247`）。
- 兼容：旧任务没有该字段 → 聚合归 `publish.unknown`，不猜。
- 这样面板才能说人话：「真发 3 条（2 成功）/ dry-run 5 条」，而不是「done 8 条」。

### 4.3 插件 rpc 暴露

- host `packages/plugin-ops/src/rpc.js` 的 `createDefaultHandlers`（端点表）加 `metrics.get`（**只读，不进 `WRITE_ENDPOINTS`**），handler 转发 `client.request('/metrics?...')`。
- client 侧通过 `ctx.connection.rpc.call('/bigfish', 'metrics.get', { days })` 拿数据（`client.js:98-123`）。

## 5. 面板 UI 设计（概览 tab 替换占位）

布局自上而下（`page` 容器 `maxWidth 860px`，够放）：

1. **数字卡行**（4 格）：今日入队 / 今日完成 / 失败 / 成功率
2. **7 日趋势**：柱（入队/完成）+ 折线（失败），SVG，高 150
3. **状态分布**：环形（queued/leased/done/failed）+ 图例
4. **失败原因 Top 5**：横向条形，标签是稳定错误码中文短句（`RISK_CONTROL`→风控拦截 等，映射表放 client）
5. **最近批次进度**：`batchId` + 进度条（done/total）+ 失败数；点「查看」切到发布 tab
6. **账号健康条**：总数 / ready / 在线 / 过期（数字，不画图）

规则：
- 轮询 **10s**（比任务表的 3s 慢，看板不需要实时），tab 不可见时不轮询（React 里靠 tab 状态控制，不摸 `document`）。
- 每个块挂 `data-role`：`metrics-cards` / `chart-trend` / `chart-states` / `chart-failures` / `batch-progress` / `account-health`，供测试断言。
- 空库：显示「还没有任务，去发布 tab 入队第一条」；错误：单块降级文案 + 其他块照常（不整页白屏）。
- SVG 渲染放 host：rpc `metrics.chart`（`{type, days, width, height}` → `{svg}`）避免把 echarts 塞 client；**同一份 metrics 在 host 侧缓存 30s**，SSR 一次约 10–20ms（实测 5.5KB SVG）。

**原「登录态导入 / daemon 地址」说明的去处**：这些内容账号 tab 已有（导入/扫码按钮 + 提示），概览页可直接替换；同步改 `packages/plugin-ops/test/client-bundle.test.mjs:530-580` 与 `scripts/dsh-shot.mjs` 里对该文案的断言。

## 6. 分阶段任务（可并行，写域已分开）

| 阶段 | 内容 | 写域 | 工期 | 依赖 |
| --- | --- | --- | --- | --- |
| M1 | payload 快照 dryRun/submit + `core/src/stats.ts` + `daemon/src/metrics.ts` + `GET /metrics` + 单测（注入假时钟/空库/坏 payload） | `packages/core/src/stats.ts`、`packages/daemon/src/{metrics.ts,operations.ts,routes.ts}` | 0.5d | 无 |
| M2 | vendor echarts + `packages/plugin-ops/src/charts.js`（SSR 封装 + 缓存）+ rpc `metrics.get`/`metrics.chart` + ADR 0005 | `packages/plugin-ops/{src,charts,vendor}`、`docs/adr/` | 0.5d | M1 契约 |
| M3 | 概览 tab 五块 + 空/错态 + `data-role` 单测 + `dsh:shot` 断言更新 | `packages/plugin-ops/client.js` | 1d | M2 |
| M4（可选） | 全屏 `GET /dashboard`（浏览器端 echarts）+ 面板入口 | `packages/daemon/src/http.ts` 新路由 | 1d | 先答 token 鉴权 |

## 7. 验收

- 单测（`node scripts/test-all.mjs`）：stats 纯函数边界（空库、单日、跨日、坏行）、rpc 参数校验、client 渲染断言 `data-role` 存在且数字卡片与 fixture 一致。
- 类型：`packages/core`、`packages/daemon` 过 tsc；`plugin-ops` 纯 JS（不影响）。
- 视觉：`pnpm dsh:shot` 出图（`.scratch/shots/bigfish-sidebar.png`），由我对照截图自查后再交你。
- **不连真实闲鱼**：`/metrics` 只读本地 SQLite；SSR 不发请求。

## 8. 风险

1. **1MB vendor 进 git**：仓库会变大且不可逆（历史里删不掉）。缓解：只 vendor `echarts.min.js` + LICENSE，不要整包 `dist/`；若你不想让仓库变大，可退化为「纯 SVG 手绘柱状/环形（~150 行，无依赖）」，效果差一档但零依赖——**这也是备选路线 0**。
2. **echarts 升级/安全**：vendor 后没有 registry 通知，需在 ADR 里写「升级方式 = 手动下载覆盖并跑 SSR 冒烟」。
3. **SSR 性能**：每 10s 一次 × 5 张图可控，但必须缓存；不要把 `days` 开放到 90 天还实时算。
4. **测试基线**：`client-bundle.test.mjs` 与 `dsh-shot.mjs` 对概览页文案有断言，必须同 PR 改掉，否则 CI 红。
5. **数据真实性**：dryRun 快照只对新任务生效；历史任务归 unknown，别在 UI 里假装知道。

## 9. 待你拍板

1. 路线：**1（面板内 SSR 图 + 批次进度）** 是否够；要不要现在就排 M4 全屏页？
2. 1MB vendor 入库可以吗？（不允许 → 走路线 0：手绘 SVG，零依赖，效果朴素）
3. ~~概览 tab 直接替换占位登录说明还是保留一行入口~~ → **已定：直接替换**（2026-10-23 重排，概览 = 驾驶舱 + 系统区）。
4. 是否接受为此补一份 ADR（按 AGENTS §2 必须补）并把它排在主线之后——**看板是支线，不抢发布主线的工期**。

## 10. 下一步技术方案（TODO，2026-10-23 重排后更新）

面板已经把 daemon **现有**能力全接完了，剩下的是「daemon 还没有的能力」。按依赖顺序排：

### 10.1 补齐 3 个 rpc 端点（0.5d，daemon 侧不用改，路由都已存在）

面板够不着、但 daemon 已实现的能力，只差 host `src/rpc.js` 端点表一行 + client 调用：

| endpoint | 转发到 | 性质 | 面板归属 |
| --- | --- | --- | --- |
| `circuits.reset` | `POST /circuits/reset` | **写**（进 `WRITE_ENDPOINTS`，两次确认） | 账号 tab 熔断行 / 概览待办提醒的「重置」按钮 |
| `task.action` | `POST /tasks/:id/{ack\|fail\|release}` | 本地队列流转，**不挂审批门禁**（2026-10-21 裁决），但面板仍点两次 | 发布 tab 任务行（处理 `needs_review` 卡死） |
| `tasks.get` | `GET /tasks/:id` | 只读 | 发布 tab 任务详情展开（payload / attempts / lastError） |

验收：`packages/plugin-ops/test/rpc.test.mjs` 加白名单与 confirm 断言 + `client-bundle.test.mjs` 加渲染断言；**不改 daemon**。

### 10.2 `GET /metrics` + 概览图表（M1→M2，见 §4 / §6）

前置：`tasks` 表加 `kind`+`state`+`createdAt` 的聚合查询（SQL 里 GROUP BY，不要把全表拉进内存）；入队时把 `{dryRun, submit}` 快照写进 payload（§4.2），否则 `done` 分不清「真发」与「dry-run」。

### 10.3 明确的「不做」

- **不做客户端图表库**：client bundle 只能 require 宿主 9 个静态模块，塞 echarts 要引入 esbuild 构建链（路线 2），优先级低于发布主线。
- **不做全屏看板页**：卡在 token 进 query 的鉴权问题（路线 3）。
- **不在面板里编数字**：概览的提醒只来自 `/status` 的 `queue` / `accounts` / `circuits`；没有 `/metrics` 之前不显示趋势、成功率、失败 Top。
