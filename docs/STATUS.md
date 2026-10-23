# 项目状态 — 单一事实源

> **最后更新 2026-10-23 中午（账号管理界面可用：登录态校验端点 + 面板账号表格 + 导入/扫码两次确认；工具注册中间件落地、原 `gate.js` 删除；956 基线）· 代码基线 `main @ ca1134c` + 本次提交。**
> 本文是仓库**唯一**的「现在到哪了 / 下一步做什么」入口。其他文档里的测试数字、工具数量、阶段状态一律以本文为准；
> 若发现别处与本文冲突，以本文为真、并把冲突处改成指向本文。规则看 [AGENTS.md](../AGENTS.md)，实现形态看 [architecture.md](architecture.md)。

---

## 1. 一句话

**能登录、能取品、能单件全自动发布（真机真提交 3 次：2 次 CLI 直发 + 1 次队列路径，都是填表 → 选类目 → 地址 → 提交 → 拿到 itemId → 已下架）；队列批量发布（≥2 条）的 dry-run 已真机跑通（2/2 done，含一次 RATE_LIMITED 退避后成功），**批量真提交还没做过**（要用户点头）；账号只有只读摘要；采集参考只到「只读统计」（R1，真机跑通一次单件解析）；不能自动发货、IM 未接进 daemon。**
P0 → P1.2 全部完成并提交。**当前按四模块重构**（用户 2026-10-21 拍板：一个插件、模块 tab 在侧边栏面板内切换、一个一个做）：发布 → 账号 → 发布前处理 → 采集参考，见 §4.1。
P2 自动发货押后到发布这条线跑顺再切。

## 2. 能做什么 / 不能做什么

验证等级：**真机** = 对真实闲鱼跑通过；**单测** = 只有测试覆盖、未对真实接口跑过；**方案** = 只有文档。

| 能力 | 状态 | 证据与限制 |
| --- | --- | --- |
| 登录态导入（CLI / `POST /accounts/import` / `xy_import_account`） | ✅ 真机 | 从带 `--remote-debugging-port` 的 Chrome 读 goofish cookie，AES-256-GCM 加密落盘；Cookie 读取按 `Storage.getCookies` → `Network.getAllCookies` 降级 |
| 扫码登录（`npm run daemon:login` / `POST /accounts/login`） | ✅ 已实现，单测通过 | 轮询 cookie，`unb` + `_m_h5_tk` 齐备才算成功（默认超时 180s）。**未见真机扫码成功留档** |
| 令牌自动刷新 | ✅ 真机 | `_m_h5_tk` 约 2h 过期；`FAIL_SYS_TOKEN_EXOIRED` 时合并响应 Set-Cookie、重签重试**一次**并回写凭据 |
| 取商家 ID + 全量商品 | ✅ 真机 | `user.page.head` + `xyh.item.list` 分页（每页 ≤20）；CDP 抓包与 mtop 直读双验证 |
| `probe` 商品详情落库 | ✅ 真机 | mtop 详情 → `items.upsert` |
| `polish` 擦亮 | ✅ 真机 | mtop 擦亮 2.0 |
| 采集他人商品做参考（R1 只读统计） | ✅ 单测 + 真机（单件） | `channel-mtop/src/reference.ts`（`parseItemReference` / `extractTitleKeywords` / `summarizeReferences`）+ `daemon/src/reference.ts` + `POST /reference` + 工具 `xy_reference_collect` + 面板「采集」分区。只出统计（价格带 / 标题长度 / 类目分布 / 卖点词 / 商家量级），**绝不返回图片直链、不落他人商品图**。真机 2026-10-21：真实凭据目录起 daemon，`POST /reference` 200/241ms，单件「AI工作流咨询」priceCents 10000 / categoryId 50023914 / seller 西安·在售 7 件。限制：卖点词要求出现 ≥2 次，只采 1 件时为空；**多件/商家主页整批、面板点击都未真机**；「自有商品搬家」（R2）未实现、待拍板（§4.3） |
| `publish` 单件发布（CDP 步骤机，真提交） | ✅ 真机（3 次） | CLI 直发 2 次：`1093817229436`（2026-10-21 首次）、`1091938715735`（分类修复后，14.5s 拿到 itemId）；队列路径 1 次：`1091940243200`（`POST /tasks` → worker → `operations.publish`，落 items 表）。**3 次都是单件、都是「学习笔记」类目、都已下架留档**。真提交需 `--submit` / `BF_PUBLISH_SUBMIT=1`；类目受网页端支持矩阵限制（电子资料/学习笔记/课业本 ✅；教材教辅/语言培训/学习资料定制/文学/考研咨询 ❌）。itemId 是人工试验的产物，仓库代码里没有痕迹 |
| `publish` dry-run（填表不提交） | ✅ 真机 | 发布页 → 传 2 图 → 文案 → 选类目 → 价格/包邮 → 地址 → 必填预检 → 收尾，每步截图。**不带 category/address 时能填表但过不了提交前预检**。两条路径都真机过：CLI `publish`（单件）+ **daemon 队列批量**（2026-10-22，批次 `b-e2e-mvj3aedp`，2 条同批 → 2/2 `done`，第 2 条先 `RATE_LIMITED`（写桶满）退避后成功，两轮各 7 张截图在 `.scratch/e2e3/shots/`） |
| 草稿指定类目 + 不支持即失败 | ✅ 真机 | **网页端分类不是全量类目树**：候选来自 `mtop.taobao.idle.kgraph.property.recommend`（入参标题/描述/图片，一次约 10 个），**不可搜索、不可手输**，文案与图片会重新触发推荐。`channel-cdp/src/category.ts`（+ `category-page.ts`）：按 `aria-controls` 绑定当前下拉、点前 `elementFromPoint` 命中测试、**不对 portal 选项 scrollIntoView**（会滚主页面导致点击落空）、候选在可视区外时只滚下拉内部 `.rc-virtual-list-holder`、连续 2 次回读一致才算选中；目标不在候选里时关下拉等推荐刷新再重开（`REFRESH_WAIT_MS`，受步骤预算约束），仍不在就 fail-closed 并在报错里列出当前候选；命中「网页版暂不支持」立即 `VALIDATION`。真机：上传图片 → 填文案 → 分类从「电子资料」按文案刷新出「学习笔记」并选中（`86ca47e`） |
| 面板内模块 tab（切换） | ✅ 真机（桌面端 GUI 实拍；实时数据改用兼容路由后待重启桌面验证） | 插件只注册 `sidebar.panellist` + `main`；面板内 `PANEL_TABS` 切 6 个分区：自动发布（默认）/ 账号 / 文案 / 采集 / 概览 / 诊断，`PanelBody` 分发。面板本身不联网、不执行写操作，但 daemon 状态是**真实数据**：`ctx.connection.rpc.call('/bigfish', endpoint)` 每 3 秒轮询 6 个只读端点（`health`/`status`/`accounts`/`settings.get`/`tasks.list`/`batches.get`）、另用 `events.list` 增量拉工作流树（失败单独降级，不拖垮 daemon 状态行），daemon 状态任一失败整块降级成「未连接后台」一行（降级时宿主会**自动拉起 daemon**，见 §5 与 `plugin-ops/src/daemon-supervisor.js`）；账号 tab 已是动态表格（进 tab 自动 `accounts.verify`、60s 缓存、手动「检测」强制重打，导入/扫码两次确认 `confirm:true`）；`tasks.retry` / `batch.enqueue` / `settings.put` 仍无 UI（`docs/client-plugin-sidebar.md` §1.1）。**宿主 bug 已由插件侧绕过（2026-10-22）**：DSH 0.1.5-rc.2 的 `connection` 插件用自己 ctx 注册 `webServer`（`rpc-host.ts:80`/`:178-181`），外部插件的 `rpc.handle` 必抛 `cannot get property "webServer" without inject`；插件现在「官方通道优先 → 失败自动回退到自建 `webServer` prefix 路由 `/bigfish`」（`plugin-ops/src/host-route.js`，信封/状态码/fail-closed 鉴权 1:1 复刻宿主，ADR 0004）。dev host 真机探针已 200；**桌面端需重启 DSH 才加载新代码，重启后应显示「在线」而非「未连接后台」**（§5 风险表）。面板底部新增「进程管理」区（`data-role=daemon-manage`）：**启动 daemon / 停止 daemon 两个按钮**，并写明「daemon 是常驻后台监听进程——worker 按固定间隔轮询本地队列执行发布/擦亮/探针，面板只是看板，关掉面板 daemon 照旧运行」；`daemon.start` 走 supervisor 的 `force` 拉起（跳过 30s 冷却），`daemon.stop` 是写端点（要求 `confirm:true`，面板第一次点只上膛、第二次点才发），停止后 daemon 收到 `POST /shutdown` 走优雅退出（先停 worker 释放租约再关 HTTP/SQLite）。**不回退到会话顶部 tab**（`conversation.view`：点侧边栏后 main 换成 bigfish，会话与 tab 条一起离开 DOM） |
| 账号列表摘要（`GET /accounts` / `xy_accounts_list`） | ✅ 真机 | daemon 只读摘要：accountId / updatedAt / savedFieldCount / ready（`unb`+`_m_h5_tk` 齐备）/ ageMs；单个凭据损坏标 `broken` 不拖垮整表；不带任何 cookie 值。工具只读、不挂门禁。真机：真实数据目录 `%LOCALAPPDATA%/bigfish` 下起 daemon，`GET /accounts` 200 返回 1 个账号（`ready: true`、savedFieldCount 21）；`xy_accounts_list` 仍只有单测 |
| 登录态校验（`POST /accounts/:id/verify` / rpc `accounts.verify` / 面板「检测」） | ✅ 真机（单账号） | 真调一次 `user.page.head`：成功 → `{accountId, online:true, checkedAt, refreshed}`；`_m_h5_tk` 过期会合并 Set-Cookie 重签重试**一次并回写凭据**，回写成功才置 `refreshed:true`；失败仍 200 + `online:false` + `code`（AUTH_EXPIRED / RISK_CONTROL / RATE_LIMITED / NETWORK / VALIDATION / INTERNAL）+ 固定中文短句；账号不存在 → 400 VALIDATION；缺失登录态 → 200 `VALIDATION`。真机 2026-10-23：隔离副本凭据目录起 daemon，`POST /accounts/2206569289277/verify` → 200 `online:true, refreshed:true`（过期 token 确实被刷新并回写副本），`does-not-exist` → 400。**限制**：不占限流桶/熔断（连点会直接打 `head`）、无定时保活、多账号进 tab 会串行打 mtop |
| 批量入队 `xy_publish_batch` + 批次层 | ✅ 工具单测 / 队列批量真机（dry-run） | `plugin-ops/src/batch.js`：逐条校验 + `draftDedupeKey` 幂等 + `mode=dry-run` 默认；按账号逐条预约 `availableAt`（默认 180s，`BF_PUBLISH_MIN_INTERVAL_MS` 可调，失败不占位）；写类工具挂审批门禁（仅 enqueue 需确认）。daemon 侧已有批次层：`EnqueueInput.batchId` / `batchStats` / `GET /batches/:id`（五状态计数 + items）。真机 2026-10-22：HTTP 直接入队 2 条同 `batchId` → 2/2 `done`。**仍缺**：`POST /tasks` 不给 `created` 标志（跨批重复只能显示 queued）、批次真提交未跑、180s pacing 未真机校准 |
| 批量上架调度 | 🟡 链路通，真提交未做 | 批次层（batchId / `GET /batches/:id` 汇总）+ 单账号串行 + 账号级 pacing 已就位；队列批量 dry-run 真机 2/2；**一条命令真机验收已就绪**：`pnpm accept:publish`（`scripts/publish-acceptance.mjs`，自起 dry-run daemon、同批塞一条支持类目 + 一条不支持类目、轮询到终态、落证据 JSON；只能在非沙箱终端跑，沙箱里 CDP 渲染进程起不来）；**批量真提交仍未跑**，面板尚无批次进度消费 |
| `deliver` 自动发货 | ❌ `UNSUPPORTED` | 规则引擎已就绪，缺订单/消息源与执行接线 |
| `reply` / IM 收发 | ❌ `UNSUPPORTED` | `channel-im` 已提交（帧解析/归一化/会话状态机，32 tests），**未接 daemon**；websocket 长连、发送、握手未实现 |
| 文案 skill（改写 + 合规审核） | ✅ 2 个 skill | `.agents/skills/xianyu-listing-copy`、`.agents/skills/xianyu-listing-audit`；**已被 DSH 自动发现**（provider 只扫 `.dsh/skills` / `.agents/skills`，2026-10-22 实测），可被 agent 直接调用 |
| 文案风格注入（面板 + `xy_copy_plan`） | ✅ 真机（面板）/ 单测（工具） | 面板内「文案」分区（`PANEL_TABS` 六分区之一）：5 档语言风格（plain/warm/professional/urgent/story）、填商品名/价格/成色，组出 `xy_copy_plan` 参数 JSON；工具把风格约束渲染成提示词。**都只产出请求/提示词，不调模型** |
| AI 生图 | 📝 方案 | 选型与管线见 [copywriting-and-imagegen-plan.md](copywriting-and-imagegen-plan.md)，未实现调用 |
| 地址库 / 别名匹配 | ❌ 未做 | CDP 下地址搜索候选不回显，只能匹配「常用地址/附近地址」；匹配不到就失败回显候选 |
| 闲管家开放平台 | 📝 客户端在 | `channel-guanjia`（MIT 移植）无消费者、缺凭证 |
| daemon 异常唤醒会话 | ✅ 单测（host 侧） | 发布任务落到 `failed`/`needs_review` 时，插件 10s 轮询 `/events` 并用 `agent.followup` 往当前会话推一条 notice（任务 id / 批次 / 错误码 / 下一步建议），同一事件不重复推、连续离线只记一条 warn；配置 `enableAlerts: false` 可关。**面板未读角标、真机 failed 场景验证未做** |
| Web GUI 侧边栏面板 | ✅ 只读 | 静态快照 + 手动刷新；按钮 disabled 是刻意的（DSH 无「面板按钮调 host 工具」公开 API） |

## 3. 质量基线（可复现）

```
node scripts/test-all.mjs     # 956 tests / 956 pass / 40 suites / 88 个测试文件 / ~18s
```

| 范围 | 用例数 | 备注 |
| --- | --- | --- |
| core | 171 | 队列（含 batchId/批次统计/requeue）、仓储、策略、限流熔断、账号级发布间隔、凭据、脱敏、配置、settings 存储、发货规则引擎 |
| daemon | 235 | HTTP、CLI、执行器、worker、路由、账号导入、账号摘要、**登录态校验（`account-verify.ts`：`online` 判定 / 错误分类 / 固定中文文案 / cookie 线索脱敏）**、参考采集、settings 路由、批次统计、CDP 发布、dry-run 开关、发布侧风控、任务事件流（`GET /events` 增量/游标/过滤、发布步骤落库） |
| channel-mtop | 95 | 纯函数（含参考解析与卖点词） |
| channel-cdp | 102 | 假连接与假页面回放（分类下拉按 AI 推荐刷新/虚拟列表滚动、风控探测） |
| channel-guanjia | 62 | 纯函数 |
| channel-im | 32 | 帧解析 / 归一化 / 状态机 |
| plugin-ops | 226 | 插件契约、**工具注册中间件（spec 校验 / read-confirm 分桶 / 按参数判定写 / 统一 ask 门禁）**、草稿校验、批量入队与 pacing、文案风格注入、账号摘要、**账号表格与登录态检测（verify 徽标 / 60s 缓存 / 导入扫码两次确认）**、参考报告渲染、host rpc 桥（17 端点，含 `accounts.verify`）、**webServer 兼容路由回退**、**daemon 自动拉起（冷却/单飞/回环守卫）+ 面板内启停（停止需二次确认）**、**异常唤醒（事件去重/合并/提示语、游标定基线、无 agent 不轮询、失败不刷屏）**、client bundle（面板内 6 个模块 tab、**工作流树 `events.list` 增量轮询**） |
| scripts | 31 | daemon 常驻服务（参数/状态机/日志尾）16 + 发布真机验收脚本（参数/草稿/批次判定/PNG 生成）15 |
| integration | 2 | 插件 client ↔ 真 daemon 端到端 |
| **合计** | **956** | ops-bundle 无测试（只声明组合） |

- 类型检查：**6 个 TS 包** tsc 0 错误（core / daemon / channel-mtop / channel-cdp / channel-guanjia / channel-im）。
  **plugin-ops 与 ops-bundle 是纯 ESM JS，无 tsconfig，不在类型检查覆盖内**——改这两个包只能靠测试。
- 运行时零第三方依赖；全仓 `TODO/FIXME/HACK` 0 条。
- 仓库 8 个包、daemon 19 条 HTTP 路由（含 `POST /shutdown`、`GET /events`、`POST /accounts/:id/verify`）、插件 14 个 `xy_*` 工具（由 `src/tool-middleware.js` 统一校验注册并挂审批门禁，`src/gate.js` 已删）、5 个 TaskKind（probe/polish/publish/deliver/reply）、面板内 6 个模块 tab。
- 账号登录态：**能登录、能自动续期、能按需校验**；缺的是定时保活与多账号并发检测。

## 4. 下一步

### 4.1 主线：拆成四个模块，一个一个做（用户 2026-10-21 拍板）

**产品结构（2026-10-21 纠正）**：仍然是**一个插件**；插件入口只在侧边栏（`sidebar.panellist` + `main`），**四个模块是侧边栏面板内部的 tab**（`client.js` 的 `PANEL_TABS` + `PanelBody` 分发），不占会话顶部；加模块 = `PANEL_TABS` 追加一项 + `PanelBody` 补一行分支（模块组件之间互不依赖）。

| 模块 | 模块 tab（面板内） | 现在到哪 | 下一步 |
| --- | --- | --- | --- |
| **发布** | 自动发布（`PANEL_TABS[0]`） | 单件真提交真机 3 次（均已下架）；**队列批量 dry-run 真机 2/2 done**（批次层 + `GET /batches/:id` 已落地）；失败收尾（retry）、发布侧风控识别、账号级 pacing 仍只有单测；**daemon 常驻化已落地**（`pnpm daemon:start/stop/restart/status/logs`）；**真机验收已脚本化**（`pnpm accept:publish`，含同批混不支持类目） | 在普通终端跑一次 `pnpm accept:publish`（dry-run，无需授权，补上「同批混不支持类目」真机证据）→ 用户点头后跑批量真提交（1 条，发完立即下架） |
| **账号** | 「账号」tab | **本轮做完并真机验证**：只读摘要 `GET /accounts`（真机）+ 登录态校验 `POST /accounts/:id/verify`（真机 `online:true, refreshed:true`）+ rpc `accounts.verify` / `accounts.import` / `accounts.login` + 面板账号表格（状态徽标、最近检测、凭据更新时间、「检测」按钮、导入/扫码两次确认） | 定时保活/巡检；多账号并发检测与绑定发布；凭据备份恢复 |
| **发布前处理** | 「文案」tab（部分） | 文案 skill 2 个（`.agents/skills/`，**已被宿主自动发现**）+ `xy_copy_plan` 风格注入（只产提示词）；core settings 存储已有（`settings.ts`，未接面板）；无生图实现 | 面板接 settings（读写走 `/bigfish` rpc）；文案接进 agent 流程；生图选型 |
| **采集参考** | 「采集」tab（`PANEL_TABS[3]`） | **R1 已落地**：只读统计（价格带/标题长度/类目/卖点词/商家量级）+ `POST /reference` + `xy_reference_collect` + 面板「采集」分区；真机跑通一次单件解析 | R2「自有商品搬家」范围待拍板（§4.3）；多件/商家主页整批真机；R3 自摄图片处理 |

### 4.1.1 发布模块（先做，单件已通）

**为什么是它**：单件链路已经真机跑通过一次，缺的不是「能不能发」，而是「一批能不能发得稳、发重了怎么办、发失败了落在哪」——也就是批次层、幂等、可观测。设计见 [auto-publish.md](auto-publish.md)。

**卡点**：①类目矩阵——网页端只支持一小撮类目，且分类候选由 AI 推荐（约 10 个、不可搜索），这是覆盖面天花板；②真提交只成功过 3 次单件（2 次 CLI + 1 次队列），**批量真提交没做过**；③面板读 daemon 状态的通道已落地（`ctx.connection.rpc.handle('/bigfish')`，ADR 0004），面板侧只读消费已接（6 端点 / 3 秒轮询）；宿主 `webServer` bug 已由插件侧兼容路由绕过，**待重启桌面验证**，面板启停按钮已接（停止需二次确认；其余写类按钮未接）；④daemon 常驻已补 `scripts/daemon-service.mjs`（未做开机自启），并且**面板打开时宿主会自动拉起 daemon**（rpc 拿到 NETWORK 即拉起，30s 冷却，日志 `<dataDir>/plugin.log`、`daemon.log`）。

| 步骤 | 做什么 | 验收 |
| --- | --- | --- |
| **A1 面板内「自动发布」tab** ✅ | 侧边栏面板默认分区：流水线说明 + 草稿集粘贴 + 发布前校验 + 产出请求 JSON + 发布命令（不联网、不执行） | 桌面端 GUI 实拍 + client-bundle 测试覆盖 |
| **A2 批量入队** ✅ 工具单测 | `xy_publish_batch`：逐条校验 + `dedupeKey` 幂等入队 + 逐条状态（queued / skipped-duplicate / invalid），默认 `mode=dry-run` | 单测全绿 + 写类工具挂审批门禁 |
| **A3 真机小批量** 🟡 dry-run 段完成 | 1 条 dry-run → 1 条真发 → 看队列/截图/itemId；再跑 3 条含一条不支持类目 | 单件 dry-run ✅、单件真发 + itemId + 已下架 ✅（`1091938715735`）、**队列批量 dry-run 2/2 done ✅**（批次 `b-e2e-mvj3aedp`，2026-10-22）；**「同批混一条不支持类目」已脚本化（`pnpm accept:publish`），待普通终端跑一次**；**批量真提交还没跑** |
| B1 pacing ✅ 单测 | 账号级任务间隔：`core/src/limiter.ts` 的 `resolvePublishMinIntervalMs`（默认 180s，夹 30s..3600s）+ 批量按账号预约 `availableAt` | 单测（core/test/pacing.test.ts、plugin-ops/test/pacing.test.mjs）；**180s 未真机校准**；单条 enqueue / 直接 POST /tasks 不受它约束 |
| B2–B4（后续） | 批次汇总/面板进度 → 类目矩阵补测（A3 扫码兜底）→ 10 件连发回归 | 不跨步；每步都先小批真机 |

> **未跑通的不得声称成功**：批量发布目前只真机跑通了 **dry-run**（填表不提交）；批量真提交没做过，不许说「已支持批量发布」。

### 4.1.2 账号模块（第二个做，本轮做完：能看、能测、能导入/扫码）

**① 只读摘要（c01e86e，真机）**：`GET /accounts`（`packages/daemon/src/account-list.ts`）返回 `{ accountId, updatedAt, savedFieldCount, ready, unb?, ageMs, broken?, brokenReason? }`——`unb` + `_m_h5_tk` 齐备才算 `ready`，单个凭据损坏只标 `broken` 不拖垮整表，任何 cookie 值都不出 daemon 进程。**注意 `ready` 只代表本地字段齐备，不代表闲鱼侧在线**（过期 token 也算 ready），在线与否看下面的校验端点。

**② 登录态校验（本轮新增，真机验证）**：`POST /accounts/:id/verify`（`packages/daemon/src/account-verify.ts` + `executors.verifySession`）真调一次 `user.page.head`：`online:true` 即闲鱼侧登录有效；`_m_h5_tk` 过期时走 `callMtop` 的合并 Set-Cookie 重签重试**一次**，经 `onSessionUpdate → credentials.save` 回写成功才置 `refreshed:true`；失败仍返回 200 + `online:false` + 稳定 `code`（AUTH_EXPIRED / RISK_CONTROL / RATE_LIMITED / NETWORK / VALIDATION / INTERNAL）+ 固定中文短句（错误原文里的 cookie 线索被正则剥掉，不落面板）。插件侧：rpc `accounts.verify`（只读、不挂 `confirm`、40s 超时）+ `src/client.js` 的 `verifyAccount()` + 面板「检测」按钮。真机：隔离副本凭据目录起 daemon，`POST /accounts/2206569289277/verify` → 200 `{online:true, refreshed:true}`，`POST /accounts/does-not-exist/verify` → 400 VALIDATION。

**③ 面板账号表格（本轮重做）**：`packages/plugin-ops/client.js` 的 `AccountView` 从静态卡片改成表格——每行 账号 / 状态徽标（在线 · 已过期 · 无法确认 · 检测中 · 未检测）/ 最近检测 / 凭据更新（相对时间 + 字段齐备与否）/ 字段数 / 操作；进 tab 自动 verify（同账号 60s 缓存，手动「检测」强制重打），单个账号失败只落该行不整页降级；导入/扫码走**两次确认**（第一次点只改文案，第二次才带 `confirm:true` 发 `accounts.import` / `accounts.login`，扫码期间显示「等待扫码…（最长 180s）」）。说明文字已按用户要求压掉（原来的三张来源卡与边界说明删除）。

**没做**：①定时保活/巡检（现在只有打开面板或手点才校验）；②多账号进 tab 会串行打 mtop，没有并发与限速；③账号绑定发布任务、凭据备份恢复；④`tasks.retry` / `batch.enqueue` / `settings.put` 仍无 UI。

**验收**：全量 956 全绿 ✅（plugin-ops 226 / daemon 235）；`GET /accounts` 真机 ✅；`POST /accounts/:id/verify` 对**真实凭据目录**的 daemon（pid 4808）真机 ✅：`200 {online:true, refreshed:true}`，`does-not-exist` → `400 VALIDATION`；**面板真机（真实浏览器）** ✅ 2026-10-23 13:0x 用 `scripts/dsh-dev.mjs` 起隔离 DSH（47080，加载当前插件代码）+ headless Chrome 走 CDP：展开侧边栏「BigFish 闲鱼运营」→ 账号 tab 渲染出表格行 `2206569289277 / 在线 / 最近检测 13:02:28 / 1 分钟前 · 字段齐备 / 23 字段 / [检测][重新导入][扫码登录]`，`data-role` 全套命中（截图 `.scratch/panel-account.png`、`.scratch/panel-after-click.png`）。这条路径已固化成一条命令：`pnpm dsh:shot`（6 个 tab 的断言 + 截图 `.scratch/shots/bigfish-sidebar{,-account}.png`，2026-10-23 13:05 实跑 exit 0）。**用户自己的桌面应用仍需重启一次**才能加载同一套代码（当前进程加载的是 12:38 前的旧插件）。

### 4.1.3 采集参考模块（第三个做，R1 只读统计已落地）

**已落地（5ffda24）**：
- 解析层 `packages/channel-mtop/src/reference.ts`：`parseItemReference`（itemId / title / desc / priceCents / categoryId / properties / imageCount / 浏览·想要·收藏·卖出 / publishedAt / seller / siblingItems；兼容 `{data:{itemDO}}`、`{data:{itemCardDO}}`、扁平三形态，缺 itemId 或 sellerId → VALIDATION）、`extractTitleKeywords`（CJK 整段 + 3 字以上才切 2-gram + 英文数字 ≥2 字符，`STOP_CHARS` 过滤虚词，出现 ≥2 次才进榜）、`summarizeReferences`（价格带 min/median/max/avg、标题长度、平均图片数、有描述占比、类目分布、卖点词）。**只给 imageCount，绝不返回图片 URL**（测试断言 JSON 里不含镜像域名）。
- 采集器 `packages/daemon/src/reference.ts`：`parseReferenceRequest`（accountId、itemIds ≤20 去重、sellerId，后两者至少一个）+ `createReferenceCollector`（给 sellerId 先 `user.page.head` → `xyh.item.list`，再逐件详情；单件失败进 `skipped`，只有 AUTH_EXPIRED / RISK_CONTROL / UNAUTHORIZED 中止整批；带 `onSessionUpdate` 回写刷新后的 cookie）。
- `POST /reference`（daemon 自己从 CredentialStore 取凭据）+ 工具 `xy_reference_collect`（只读、不挂门禁、超时 100s）+ 面板第 6 个分区「采集」（输入形态、产出说明、红线、工具入口）。
- 真机：2026-10-21 `POST /reference` 200 / 241ms（数据见 §2 表）。

**没做**：①多件 / 商家主页整批只有单测（真机只跑过 1 件）；②卖点词要求出现 ≥2 次，样本 <2 件时为空（符合预期，不是 bug）；③**R2「自有商品搬家」**（把自己商品从 A 号搬到 B 号 / 多店铺同步）——技术上就是同一条采集+发布链路，但属「跨账号复制」灰区，**必须你拍板**（§4.3）；④R3 自摄图片处理（缩放/水印/白底）、R4 多账号并行（要先解 `assertSameAccount` 的单 Chrome 单账号约束）。

**红线（写进代码注释与测试）**：只做统计参考；不下载他人图片、不照抄文案、不跨账号复制他人商品。

### 4.2 下一步备选：P2 自动发货（等发布线跑顺再切）

**三块地基已就位**：规则引擎（`core/src/delivery.ts`，21 tests，4 种动作 + 红线词拦截）、IM 协议事实（[im-protocol.md](im-protocol.md) 已写成可施工规格：注册/心跳/ACK/`/r/MessageSend/sendByReceiverScope`/解密顺序）、消息解析（`channel-im` 32 tests）。
**卡点**：①订单源完全没有依据——`docs` 里「订单」0 命中，订单列表/确认发货接口未抓包；②IM websocket 客户端未写（协议有、实现无）。

| 步骤 | 做什么 | 验收 |
| --- | --- | --- |
| **P2.0 半自动** | 规则命中 → 面板展示建议动作与文案 → 人工确认 → 入队 | 手填买家消息能出命中规则与建议文案；确认后队列有任务 |
| **P2.1 IM 接线** | websocket 长连（15s 心跳、逐帧 ACK、token 过期分流）+ 消息解密落库 + 发送帧 | 真实小号能给买家发一条文本；消息表唯一键去重 |
| **P2.2 自动发货** | 订单源（先 CDP 读「我卖出的」兜底）+ 发卡 + 状态回写 + 幂等 `uniqueCode` | 一个测试订单从付款到发货全自动，重复触发不双发 |

> 不建议跳过 P2.0：**发货是写操作且直接触达买家**，先让人确认一轮，把文案与规则调对再放开。

### 4.3 需要你决定的事

1. **发布主打哪些类目**：目前只有电子资料 / 学习笔记 / 课业本网页端可发。要不要花时间试「期刊杂志 / 生活百科」等旁支（见 4.1 B3），还是就锁定这三类做量？
2. **目标商家形态**：纯个人号，还是要覆盖鱼小铺 / 闲管家（有企业资质）？后者才需要接 `channel-guanjia`。
3. **发货接受「半自动」多久**：先人工确认跑一段，还是必须一步到全自动？（全自动要先逆向订单接口）
4. （已落地）客户端→宿主 rpc 通道（ADR 0004，`/bigfish`，13 端点）；面板按钮调 host 不再是灰区——剩下的只是把写类端点（`accounts.import` / `accounts.login` / `tasks.retry` / `batch.enqueue`）接成按钮并挂确认。
5. **「自有商品搬家」做不做**：要不要支持「把自己 A 号的商品（含图片）发到 B 号」或「多店铺同步同一批货」？这是搬运助手最核心的能力，但踩 AGENTS §1.6「不跨账号复制他人商品」的边——如果只限**你自己名下**的账号之间，可以做成 R2；如果含他人商品，一律不做。
6. **批量真提交用哪个账号**：现有凭据只有 `2206569289277`（你的大号，2026-10-21 已用它真发过 3 次并全部下架）。批量真提交第 1 条要你点头：用大号发 1 条「自动发布测试」并立刻下架，还是等你导入一个测试小号再跑？（AGENTS §5：真人验证优先测试小号）
7. （已拍板，存档）首发主打：**自动发布**——用户 2026-10-21 决定「先做自动发布，其他功能一个一个来」。
8. （已拍板，存档）**一个插件 + 四个模块**，模块 tab 在侧边栏面板内切换，插件入口只在侧边栏——用户 2026-10-21 定。
9. **（需要你动手两件）** ①**重启 DSH 桌面应用**（关掉再开，会话不丢）让面板新插件代码（账号表格 + `accounts.verify` rpc + 工具注册中间件）生效：重启后侧边栏「自动发布 → 账号」应看到表格而不是三张静态卡。daemon **已经由我这轮重启**（pid 4808，含 verify 路由，不必再动）。②在**普通终端**（不是 DSH 沙箱）跑一次 `pnpm accept:publish` 补「同批混不支持类目」的真机证据；它自己起 dry-run daemon、跑完即停，**不会真发**。
10. **（仍未答）批量真提交授权**：见第 6 条——等你点头才能动真格。
11. **账号定时保活要不要做**：现在只有打开面板/手点「检测」才校验一次登录态；要做成 daemon 每 N 分钟巡检 + 失效时面板标红/推 notice，需要你先点头（会周期性真调 `user.page.head`，频率建议 30–60s 或 10min 一档）。


### 4.4 施工队列（2026-10-23 凌晨讨论产出，按依赖排序）

> 口径：**daemon 不调 LLM、插件不直接调 LLM、会话/agent 是唯一 LLM 主体**（见 §4.5）。T4/T7 属白名单外扩展点，动工前先补 ADR。

| # | 事项 | 做什么（关键点） | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| T1 ✅ | **daemon 步骤事件流（2026-10-23 已落地）** | 新表 `task_events`（taskId / batchId / step / status / at / seq）；worker 执行时把 `channel-cdp/src/steps.ts:36-51` 已有的每步回调落库；新增 `GET /events?since=<seq>&limit=`（增量） | 单测（写入顺序、增量、越界）+ 真机 dry-run 一批后能拉到 step 级事件 | 无 |
| T2 ✅ | **面板工作流树（2026-10-23 已落地）** | 新增 rpc 端点 `events.list`（白名单 `since`/`limit`/`taskId`/`batchId`，`limit≤1000`）+ daemon 客户端 `listEvents`；client 侧 `useWorkflowEvents`（3s 增量、闭包 `since` 游标、缓冲 300 条）→ `groupEventsByTask` 聚合成「任务→步骤」→ `WorkflowTree`（挂在「自动发布」页 daemon 状态块之后，最近 6 任务 × 6 步，`data-role='workflow-tree'/'workflow-task'/'workflow-step'`）；失败只降级工作流区、不影响在线状态行 | client-bundle 4 条（树结构/游标推进/端点缺失降级/空流）+ rpc 2 条（白名单/非法参数）+ client 1 条；全量 887 绿。**桌面目视仍需用户重启 DSH 后看一眼** | T1 |
| T3 ✅ | **daemon 异常唤醒 DSH 并回消息（2026-10-23 已落地，host 侧）** | 不走 `ctx.jobs.start`（常驻轮询会被当成长任务），改 `setTimeout` 链 + `unref()`：`alerts.js`（纯函数：`isAlertEvent` 只认 `task.state` 的 `failed`/`needs_review`、按 id 去重、合并成一条中文摘要、风控/登录态/待复核三类下一步建议、`source.form='notice'` 的 user message）+ `alert-watch.js`（10s 轮询 `/events`，启动时先翻页定基线**不把历史失败当新告警**，无活着的 agent 不 arm 只等 `agent/created`，推送成功才清队列，连续失败只记一条 warn）；`agent.followup()` 用宿主公开扩展点，插件名走 `ctx.get('agents').roots()` 取最新会话；配置 `enableAlerts`（默认开） | 26 条单测（去重/合并/提示语/基线/agent 消失补推/失败不刷屏/stop 后不再 tick）+ 全量 913 绿；**面板未读角标未做**（下一步）；真机验证需 daemon 里真跑出一条 failed | T1 |
| T4 | **面板 AI 按钮（发布前处理）** | 按钮 → 输入 JSON → `ctx.subagents` 跑 `xianyu-listing-copy` skill → agent 调新写工具 `xy_draft_save` 落草稿 → 面板草稿列表 → 人审 → `xy_publish_draft` 校验入队（LLM 输出必须过工具落盘，不从会话文本抠 JSON） | 一次走通「原图+原话 → 草稿 → 人审 → 入队 dry-run」；ADR 0005 写清 subagents 用法与审批门禁 | 可与 T1 并行 |
| T5 | **只读「相机」（闲鱼浏览器画面）** | daemon `GET /camera?taskId=` → CDP `Page.captureScreenshot`（只在发布任务运行时截，不常开）→ 面板 `<img>` 刷新；第一版**只读**，可交互（转发鼠标）留第二步 | 真机 dry-run 时面板看到发布页画面 | Chrome 调试端口 |
| T6 | **工具层重切** | 一 HTTP 端点一工具 → 一业务动作一工具；读类一次拿全并返回 `nextAction`；合并 `publish_draft` / `publish_batch` / `task_enqueue` 的重叠语义 | 工具数从 14 收敛到 ≤10、每个返回带 `nextAction`、测试与文档同步 | T4 |
| T7 | **browser-skill 评估（bsk_*）** | 评估用它替代 CDP 做「找货源 / 看页面 / 截图回会话」；再评估能否当发布执行器（**登录态不用带调试端口重启 Chrome** 是最大收益） | 一次真机 dry-run 用 bsk_* 走完发布页填表；写 ADR 定 CDP vs bsk 分工 | 需 ADR |
| T8 | **定时任务** | 复用 DSH schedule（cron → `agent.followup`，白名单内）或 daemon `availableAt` + 面板编辑；先做「每天定时擦亮 N 件」 | 面板能建/停定时擦亮，到点真跑一次（dry-run 可） | T3 |

**T1 + T2 + T3 均已落地并测试全绿（956）**；T4–T8 是下一轮队列。T2/T3 的桌面目视验收需用户重启一次 DSH 桌面应用（面板 host 侧代码在插件启动时加载；重启后异常唤醒也会一并生效）。

> **现场根因已实锤（2026-10-23 01:0x）**：桌面壳 23:24 启动时加载的是当时的旧 host 插件，T2 的 `events.list` 与 T3 的告警 watcher 都还没写（文件 mtime 00:36–00:43）。在渲染进程 DevTools Console 里 `fetch('/bigfish/events.list', …)` 返回 `200 {"ok":false,"error":{"code":"UNSUPPORTED","message":"不支持的 rpc endpoint：events.list"}}`，而同一时刻 5 个老端点全部正常 → 面板 daemon 状态块正确、只有工作流区报错。已在面板里把这种情况和其它失败分开：`UNSUPPORTED` → 「重启 DSH 桌面应用后自动恢复」，`NETWORK` 等 → 「启动 daemon 后恢复」（`client.js` 的 `callRead` 现在带回 `error.code`）。**重启桌面应用是本条的解法，不是 daemon 的问题。**

### 4.5 分层分工（方向性拍板基线，2026-10-22 深夜讨论）

- **daemon**：确定性动作（队列、发布步骤、限流、熔断、凭据）。**绝不调 LLM**（AGENTS §1.1）。
- **插件 host 侧**：不持有 loop、不直接拿 `ctx.llm` 发请求（否则绕过 `tools/pre-execute` 审批、成本记账、会话审计）。只能经三个公开入口：`ctx.agent.followup(msg)`（注入主会话）、`ctx.agents.create`（新会话）、`ctx.subagents`（隔离子 agent，需 ADR）。
- **会话 / agent**：唯一 LLM 主体；日常操作在面板，开放式探索（找货源、论证文案）在会话。
- **面板**：看板 + 一次性可结算动作按钮（启动/停止 daemon、生成草稿、重试任务）；**不做自建 chat UI**。

## 5. 已知风险（别对外宣称）

- **发布真机真提交只成功过 3 次，都是单件、都是「学习笔记」类目**（2 次 CLI 直发 + 1 次队列路径）；**批量只跑过 dry-run**（2026-10-22 队列路径 2/2 done，没点提交）。任何「已稳定支持批量发布」的说法都是假的。
- **失败收尾已补代码、但未真机重放**：`core/src/queue.ts` 的 `requeue`（failed/needs_review → queued，attempts=0、清租约、保留 dedupeKey/payload）+ `POST /tasks/:id/retry` + 工具 `xy_task_retry`（写操作，走审批门禁）。仍是单测级证据；重放会真的再发一次，第一次用必须 `BF_PUBLISH_SUBMIT=1` + 人工盯着 + 发完立刻下架。
- **发布侧风控识别只有单测**：`channel-cdp/src/risk.ts` 每步前/抛错/步后探测 URL、页面文案、验证组件，命中抛 `RISK_CONTROL`（带 `details.step`）→ daemon 熔断 600s。但**没有真机故意触发过**，页面特征清单是 best-effort，改版会失效；截图+人工过的流程仍靠人。
- **daemon 常驻已补脚本、未做开机自启**：`pnpm daemon:start/stop/restart/status/logs`（`scripts/daemon-service.mjs`，detached + pid 文件 + 日志重定向 + `/health` 就绪等待），2026-10-22 全生命周期真机验证通过；**插件宿主侧已能自动拉起**（面板 rpc 拿到 NETWORK → detached spawn 同仓 `cli.ts`，20s 轮询 `/health`，30s 冷却、并发单飞、只认回环地址；真机 e2e 拉起 560ms 就绪、`/health` 200；实现在 `plugin-ops/src/daemon-supervisor.js` + `daemon-watch.js`，17 例单测）；**开机自启/崩溃后由系统级服务拉起仍未做**（需要服务管理器或计划任务，另开一题）。
- **地址搜索在 CDP 下不可用**（候选不回显），只能匹配常用/附近地址。
- **插件层没有类型门禁**：plugin-ops / ops-bundle 是纯 JS（无 tsconfig），改动只能靠 plugin-ops 的 226 个测试兜。
- **面板实时数据**：宿主 bug 仍在（DSH 0.1.5-rc.2 `connection` 插件用自己 ctx 注册 `webServer`，`rpc-host.ts:80`/`:178-181` → 外部插件 `rpc.handle` 必抛 `cannot get property "webServer" without inject`），但插件已自行绕过：官方通道失败即回退到自建 `/bigfish` prefix 路由（信封/状态码/fail-closed 鉴权与宿主一致，ADR 0004）。dev host 上真实 cookie 探针 `/bigfish/health`、`/bigfish/status` 均 200。**桌面端要重启 DSH 才生效**，重启后若仍降级看 server.log 是否出现「webServer 兼容路由」。daemon 没起不再需要手动 `pnpm daemon:start`：面板轮询第一次 NETWORK 时宿主会自动拉起（冷却 30s；日志 `<dataDir>/plugin.log` / `daemon.log`）。写类端点目前消费了 `daemon.start` / `daemon.stop`（面板「进程管理」：启动直接拉起、停止要点两次且带 `confirm:true`）与 `accounts.import` / `accounts.login`（账号 tab，两次确认、扫码等 180s）；**重试、入队、改设置与「逐任务明细」视图仍未接**。
- **pacing 未真机校准**：默认 180s 是推导值（同账号 15s 连发被真机风控拦过一次），单条 enqueue 与直接 `POST /tasks` 绕过它，只剩 daemon 写桶 1 次/60s 兜底。
- **账号风控**：策略是「遇到 x5sec/滑块不硬刚，停队列 + 截图 + 人工过」；识别代码有了但未真机验证，真人验证只用用户自己的账号，且默认 dry-run（AGENTS §5 账号纪律）。
- **账号在线状态是「按需校验」，不是「持续在线」**：`POST /accounts/:id/verify` 只在打开面板/手点检测时打一次，`ready:true` 只说明本地凭据字段齐备（过期 token 也算 ready）。没有定时保活/巡检，也没有失效推送（§4.3 第 11 条）；verify 本身**不占限流桶、不触发熔断**，连点会直接打 `user.page.head`。
- **面板只用隔离 dev host + headless Chrome 验过，用户桌面应用尚未重启**：2026-10-23 13:0x 用 `scripts/dsh-dev.mjs`（47080）+ headless Chrome（CDP，1680×1050）真实渲染了「自动发布」与「账号」两个 tab，daemon 状态行与账号表格都对（截图在 `.scratch/panel-account.png` / `.scratch/panel-after-click.png`）。用户桌面应用（64113）里加载的是 12:38 前的旧插件，重启后才会一致。
- **分类只能选 AI 推荐的那 10 个左右**：候选由图片+文案决定、不可搜索，推荐接口偶发「目标不在候选里」→ fail-closed。批量时若某条文案把类目推荐带偏，那条会失败待审（不拖垮整批），但**覆盖面取决于文案质量**，这是产品级天花板，不是 bug 修补能绕过的。
- **第三方材料删除流程**：`research/repos/` 仍在，删之前必须走 AGENTS §6（列清单 → 标靶点 → 等确认），不要「facts 已吸收」就删。

## 6. 这两周踩过的坑（读代码前先看）

- **风控码被丢掉两次（发布熔断一直不触发的根因）**：`channel-cdp/src/steps.ts` 原来只回 `{ok,step,error}`、`daemon/src/cdp-publish.ts` 又统一包 `INTERNAL`，worker 永远看不到 `RISK_CONTROL`。改通道错误码时要一路传到 worker，别在中间层吞掉 `code`。
- Edge 155 移除了 `Network.getAllCookies`，cookie 读取要按 `Storage.getCookies` 降级。
- 发布页描述是 `div[contenteditable=true]`；分类是 antd Select，**`el.click()` 打不开，必须 `Input.dispatchMouseEvent`**；价格是 3 个同 placeholder 输入框取第 1 个。
- **闲鱼发布页「分类」不可搜索、候选只有 ~10 个**（2026-10-22 真机）：候选来自 `mtop.taobao.idle.kgraph.property.recommend`，入参是标题/描述/图片；先把图传完、把文案写进描述区，推荐才会按文案刷新（实测「学习笔记」会在填完「高数笔记…」后出现）。顺序反了就只能拿到图片猜出来的类目（如「女士包」）。
- **antd 下拉的两个坑（2026-10-21/22 真机定位）**：①选项在 body 级 portal，关闭后节点不销毁（只加 `ant-select-dropdown-hidden`），全页扫 `.ant-select-item-option` 会点到旧/别的 Select 的选项；②**对选项 `scrollIntoView` 会滚动主页面**（实测 scrollY 94→29），下拉随之重排，可信点击被当成「点了外面」→ 值没变。取坐标时页面不能滚；判「已打开」只认 `.ant-select-open` + `aria-expanded=true`（本机 appear 动画永远停在 prepare）。③点击后 `selection-item` 更新有延迟（6ms 还是旧值、23ms 才变），回读要等。
- DSH 沙箱造的 workspace junction 是坏的（`realpathSync` 返回链接自身）；重建用 `fs.rmdirSync` + `fs.symlinkSync(...,'junction')`，**删 node_modules 下链接绝不能用 `rm -rf`**（会跟随 junction 删真源码，已发生过一次）。
- `scripts/typecheck.mjs` 在本沙箱因 `spawnSync node.exe EPERM` 报错，用 DSH checkout 的 tsc 直接跑（命令见 [handoff.md](handoff.md) §4）。
- Hindsight 本机不可用（daemon 起不来、Python 无网），不要调 `hindsight_*`。

## 7. 文档怎么读

| 层 | 文档 | 什么时候读 |
| --- | --- | --- |
| **必读** | 本文（现状+下一步） · [AGENTS.md](../AGENTS.md)（硬规则） · [architecture.md](architecture.md)（已实现形态 + 发布页真机校准 §13） | 每次开工 |
| 参考 | [module-architecture.md](module-architecture.md)（四模块边界 + 可用度 A/B/C/D 判定） · [auto-publish.md](auto-publish.md)（自动发布施工设计 + 真机验收口径） · [dev-setup.md](dev-setup.md)（怎么跑） · [component-decomposition.md](component-decomposition.md)（包边界） · [im-protocol.md](im-protocol.md) / [delivery-rules.md](delivery-rules.md)（P2 施工规格） · [client-plugin-sidebar.md](client-plugin-sidebar.md) · [p1.3-plan.md](p1.3-plan.md)（方案，执行状态看本文） · [adr/](adr/) · [end-to-end-chain-and-borrowing.md](end-to-end-chain-and-borrowing.md) · [repost-feature-parity.md](repost-feature-parity.md)（搬运助手逆向与功能覆盖/红线） | 做对应模块时 |
| 历史（只作证据，不必读） | [xianyu-ops-agent-design.md](xianyu-ops-agent-design.md) · [xianyu-4q-research.md](xianyu-4q-research.md) · [xianyu-commercial-tools-analysis.md](xianyu-commercial-tools-analysis.md) · [xianyu-wuli-kit-analysis.md](xianyu-wuli-kit-analysis.md) · [asset-extraction.md](asset-extraction.md) · [tool-failure-analysis.md](tool-failure-analysis.md) · [copywriting-and-imagegen-plan.md](copywriting-and-imagegen-plan.md)（选型） | 需要溯源时 |
