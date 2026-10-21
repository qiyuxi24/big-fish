# 模块架构与可用度（四模块）

> 本文回答两个问题：**四模块各自的边界与数据流是什么**、**哪些真能「正式使用」**。
> - 状态/测试数字的唯一事实源是 [`STATUS.md`](STATUS.md)；
> - 单模块施工细节见 [`auto-publish.md`](auto-publish.md)；
> - 进程/包/任务机的底层契约见 [`architecture.md`](architecture.md)。
> 本文只做「模块级切分 + 可用度判定」，不重复上面三篇的数字。

## 1. 一句话

一个 DSH 插件（`@bigfish/plugin-ops`）+ 一个独立 daemon。插件负责**面板与工具**（组参数、审批、展示），daemon 负责**所有确定性写操作**（队列、串行、限流、CDP、落库），通道包负责**协议**（mtop / CDP / 闲管家 / IM）。当前四个模块（发布 / 账号 / 发布前处理 / 采集参考）**没有一个达到可正式使用的标准**，能用的是一组「单点能力」，见 §3 的判定表。

## 2. 分层与数据流

```
[侧边栏面板]  packages/plugin-ops/client.js（PANEL_TABS 五个分区，只组参数，不执行写）
      │  用户把面板生成的 JSON / 命令贴给 agent
      ▼
[host 插件]   packages/plugin-ops/src/tools.js（12 个 xy_* 工具）+ gate.js（写操作 ask 审批）
      │  HTTP + Bearer token（daemon.token）
      ▼
[daemon]      routes.ts（10 条路由）→ queue.ts（SQLite，dedupe_key 幂等）
      │  worker.ts：concurrency 1、同账号最多一个在飞、lease 60s
      ▼
[执行器]      executors.ts（probe / polish / publish / deliver / reply 五种 TaskKind）
      │
      ├─ channel-mtop  ── mtop 接口（读详情、擦亮、商家与全量商品、令牌自动刷新）
      ├─ channel-cdp   ── 网页发布步骤机（attach 用户已启动的 Chrome）
      ├─ channel-guanjia ─ 闲管家开放平台（目前无消费者）
      └─ channel-im    ── IM 帧解析（未接 daemon）
```

三条硬边界（不遵守就会出错）：

1. **daemon 不调 LLM。** 需要模型判断的事在插件/agent 侧做完，daemon 只执行确定性动作。
2. **写操作只有两个入口**：① daemon 队列（工具 → `POST /tasks` → worker）；② CLI 直连（`node packages/daemon/src/cli.ts publish --draft …`，**不经队列、不落 items 表**）。面板本身没有任何写能力。
3. **默认 dry-run。** `--submit` 或 `BF_PUBLISH_SUBMIT=1` 才真提交；没拿到 itemId 一律按失败处理（绝不假成功）。

## 3. 四模块总览与可用度

| 模块 | 面板分区 | 工具 / 命令 | 后端能力 | 可用度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 自动发布 | 自动发布 | `xy_publish_draft`、`xy_publish_batch`、`xy_task_enqueue`；CLI `publish` | 队列 + worker + CDP 步骤机（单件真机通） | **C 半成品** | 能发，但要人肉起 Chrome、逐件确认、无节流、无批次 |
| 账号 | 账号 | `xy_accounts_list`、`xy_import_account`；CLI `daemon:import-account` / `daemon:login` | 凭据加密存储 + 只读摘要 + 扫码/导入 | **C 半成品** | 摘要可看、导入可用；面板内点不了、扫码未真机、多账号未接发布 |
| 发布前处理 | 文案 | `xy_copy_plan`；skills/ 两篇 | 确定性文案拼装（不调模型） | **C 半成品** | 有提示词产物，但无设置页、skill 未被宿主发现、生成→草稿未闭环、无生图 |
| 采集参考 | 无 | 只有 `xy_task_enqueue{kind:'probe', itemId}` | 单条详情落 items（6 列） | **D 未开始** | 没有列表采集/特征提取；业务红线未拍板 |

**底座能力（不是模块，但可直接用）**：登录态导入、扫码登录、令牌自动刷新、取商家 ID + 全量商品、probe 单条详情落库、polish 擦亮。这些是真机验证过的「单点」，但都还没有被组织成模块的日常流程。

## 4. 可用度判定标准

| 级别 | 含义 | 硬门槛 |
| --- | --- | --- |
| **A 可正式使用** | 用户按文档点几下就能完成业务动作，失败有人工可收尾路径 | ① 真机端到端成功 ≥ 2 次（同一条路径）；② 失败会落库并留下可读原因；③ 有账号级节流，不会被风控打断；④ 不需要改代码/改环境变量；⑤ 有下架/回滚手段 |
| **B 可用但需人工确认** | 每一步都能跑，但需要人盯着、逐步确认或手工补参数 | 满足 ①③⑤，缺 ②或④ |
| **C 半成品** | 主链路有真机或单测证据，但缺关键环节（节流、批次、面板联动、设置） | 至少一段真机通，其余只有单测 |
| **D 未开始** | 只有方案或零散接口，没有可执行链路 | — |

> 判级只看「用户能不能按现有仓库跑通」，不看代码写得多漂亮。**未跑通的路径不得声称成功**（AGENTS §0）。

## 5. 逐模块

### 5.1 自动发布

**边界**：把「一份或多份草稿」变成「闲鱼上在线商品」并留下证据；不含文案生成、不含生图、不含多账号并发、不含发货。

**入口**（三条，能力不同）：

| 入口 | 走队列 | 落 items 表 | 审批 | 适用 |
| --- | --- | --- | --- | --- |
| 面板 → `xy_publish_batch`（mode enqueue） | ✅ | ✅ | ask 门禁 | 日常批量（未真机验证 ≥2 条） |
| `xy_publish_draft` | ✅ | ✅ | ask 门禁 | 单件 |
| CLI `publish --draft`（`--submit`） | ❌ 直连 CDP | ❌ | 无（命令行自己负责） | 真机校准、排障 |

**已有真机证据**：单件 dry-run 多次；单件真提交 2 次（itemId `1093817229436`、`1091938715735`，均已下架）；队列路径真提交 1 次（itemId `1091940243200`，已下架）。类目只验证过「学习笔记」。

**到 A（正式可用）还差**：
1. **账号级发布间隔/节流**——目前代码里没有任何 pacing，同账号 15s 内连发第二件立刻 RATE_LIMITED/INTERNAL（真机踩过）。这是批量能不能用的第一道坎。
2. **批量真机 ≥2 条连发成功**（含失败混入时整批不崩、失败条进 needs_review）。
3. **批次概念**——没有 batchId/批次进度/批次汇总，用户只能逐条看任务状态。
4. **Chrome 生命周期**——daemon 只 attach 用户手动起的 Chrome（`cdp-publish.ts`），没有自起/自检/掉线重连。
5. **类目支持矩阵**——网页端只支持部分类目（电子资料/学习笔记/课业本 ✅，教材教辅等 ❌），需要发布前预检 + 明确告知。

### 5.2 账号

**边界**：登录态的导入、加密存储、有效性摘要；不含「在面板里点按钮」、不含多账号切换策略。

**入口**：`xy_accounts_list`（读）、`xy_import_account`（写，ask 门禁，从本机 Chrome 读 cookie）、`npm run daemon:login`（扫码，轮询 cookie 直到 `unb`+`_m_h5_tk` 齐备，默认 180s）。

**已有证据**：daemon `GET /accounts` 真机 200（真实数据目录，accountId 2206569289277、21 个 cookie 字段、ready=true）；导入登录态被真机发布链路反复使用；令牌 `_m_h5_tk` 约 2h 过期，mtop 通道遇 `FAIL_SYS_TOKEN_EXOIRED` 会合并新 token 重试一次并回写凭据库。

**到 A 还差**：
1. 面板内点「导入/扫码」——需要 client→host rpc 通道（`ctx.connection.rpc.handle('/bigfish')` + 客户端轮询），采用前要写 ADR；现在按钮只出现在工具审批里。
2. 扫码登录的真机留档（目前只有单测）。
3. 多账号：发布任务的 `accountId` 靠草稿/工具参数手填，没有「选账号 → 绑定发布」的界面与校验流程。
4. 凭据过期/损坏的用户可见提示（现在只有摘要里的 ready/broken 标记）。

### 5.3 发布前处理

**边界**：把商品原始信息变成「可发布的文案/图片/参数」；不含直接发布。

**现有**：`xy_copy_plan`（确定性拼装风格提示词，不调模型，供 agent 写文案用）；`skills/xianyu-listing-copy`（改写模板 + 违禁词）与 `skills/xianyu-listing-audit`（18 个审核码映射 `core/policy.ts`）。

**到 A 还差**：
1. **设置页**——用户要「既有默认又可自己调」。DSH 官方设置体系要 zod（新依赖要 ADR），先按方案 B：面板内设置页 + host 工具落 JSON。
2. **skill 被发现**——`cordis.patch.yml` 没有 `customSkillDirs`，`skills/` 下两篇目前宿主不加载。
3. **闭环**——文案产物要能一键变成草稿 JSON（现在是人工把文本贴进草稿）；生图只有选型方案，没有实现代码。
4. 文案质量的真机验收口径（发布后违规词拦截、标题长度/类目匹配）。

### 5.4 采集参考

**边界**：参考别人的商品做「标题结构 / 卖点 / 价格区间 / 图片风格」的判断；**不搬运商品、不下载原图入库、不照抄文案**（AGENTS §1.6 红线）。

**现有**：只有 probe 单条详情能力，落 `items(item_id, account_id, title, price_cents, state, updated_at)` 六列——**没有描述、图片、类目、销量**，也没有「按关键词/店铺遍历列表」的代码。

**到 A 还差**：
1. 业务红线拍板：能不能抓、抓到什么粒度、能不能存缩略图。
2. 采集入口（列表遍历 + 限流 + 去重），以及 `items` 表扩字段（desc/images/category）。
3. 特征提取（价格区间、标题模式）——属于需要模型判断的部分，按 ADR 0001 应放插件/agent 侧，不进 daemon。

## 6. 公共底座（改动前先看影响面）

| 层 | 位置 | 作用 | 被谁影响 |
| --- | --- | --- | --- |
| 契约 | `packages/core` | 任务机、队列、凭据接口、policy、限流、熔断、delivery 规则 | daemon、channel-* |
| 队列与 worker | `packages/daemon/src/{queue,worker}.ts` | 幂等入队、领租约、重试语义（不可重试码直接 failed） | 所有写模块 |
| 通道 | `packages/channel-*` | mtop / CDP / 闲管家 / IM 协议 | daemon 执行器 |
| 工具与门禁 | `packages/plugin-ops/src/{tools,gate}.js` | 12 个 `xy_*` 工具、写操作审批 | 所有模块的入口 |
| 面板 | `packages/plugin-ops/client.js` | `PANEL_TABS` 五分区（自动发布/账号/文案/概览/诊断） | 所有模块的 UI |

## 7. 完工标准与加模块步骤

**模块要进 A，必须同时满足 §4 的五条**，并在 `STATUS.md` §2 对应行写「真机 + 次数 + 边界」。

**加一个模块（或分区）**：
1. `plugin-ops/client.js` 的 `PANEL_TABS` 加一项 + `PanelBody` 补一行分支（面板只组参数，不写）。
2. `plugin-ops/src/tools.js` 加 `xy_*` 工具；写类进 `gate.js` 的 `WRITE_TOOLS`。
3. 需要 daemon 动作就加执行器 kind 或路由，写操作必须幂等（`dedupe_key`）。
4. 补单测 + 真机试验记录，更新 `STATUS.md` 与本文。

## 8. 与其它文档的关系

- 想看**现在能不能用、数字是多少** → `STATUS.md`。
- 想看**发布链路怎么搭、验收清单** → `auto-publish.md`。
- 想看**进程/包/任务状态机/IPC 契约** → `architecture.md`。
- 想看**为什么这么分层** → `adr/`（0001 不 fork 上游、0002 零依赖与语言边界、0003 发布通道选型）。
