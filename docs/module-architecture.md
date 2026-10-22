# 模块架构与可用度（四模块）

> 本文回答两个问题：**四模块各自的边界与数据流是什么**、**哪些真能「正式使用」**。
> - 状态/测试数字的唯一事实源是 [`STATUS.md`](STATUS.md)；
> - 单模块施工细节见 [`auto-publish.md`](auto-publish.md)；
> - 进程/包/任务机的底层契约见 [`architecture.md`](architecture.md)。
> 判定依据来自 2026-10-21 的只读代码审计（证据报告 `.scratch/audit-usability.md`，未提交；每条结论都能在本文引到的 `文件:行号` 复核）。

## 1. 一句话

一个 DSH 插件（`@bigfish/plugin-ops`）+ 一个独立 daemon。插件负责**面板与工具**（组参数、审批、展示），daemon 负责**所有确定性写操作**（队列、串行、限流、CDP、落库），通道包负责**协议**（mtop / CDP / 闲管家 / IM）。
**四个模块没有一个达到「可正式使用」**（A 级）；最好的是账号模块（46/100，只读摘要质量不错），发布 38、发布前处理 32；采集参考 R1 已落地（只读统计 + 真机单件，见 §5.4），但整体仍未达可用。

## 2. 分层与数据流

```
[侧边栏面板]  packages/plugin-ops/client.js（PANEL_TABS 六个分区：自动发布/账号/文案/采集/概览/诊断，只组参数，不执行写）
      │  用户把面板生成的 JSON / 命令贴给 agent
      ▼
[host 插件]   packages/plugin-ops/src/tools.js（14 个 xy_* 工具）+ gate.js（写操作 ask 审批）
      │  HTTP + Bearer token（daemon.token）
      ▼
[daemon]      routes.ts（13 条路由）→ queue.ts（SQLite，dedupe_key 幂等；`requeue` 支持人工重排）
      │  worker.ts：concurrency 1、同账号最多一个在飞、lease 60s
      ▼
[执行器]      executors.ts（probe / polish / publish / deliver / reply 五种 TaskKind）
      │
      ├─ channel-mtop  ── mtop 接口（读详情、擦亮、商家与全量商品、令牌自动刷新）
      ├─ channel-cdp   ── 网页发布步骤机（只 attach 用户自己起的 Chrome）
      ├─ channel-guanjia ─ 闲管家开放平台（无消费者）
      └─ channel-im    ── IM 帧解析（未接 daemon）
```

四条硬边界（不遵守就会出错）：

1. **daemon 不调 LLM。** 需要模型判断的事在插件/agent 侧做完，daemon 只执行确定性动作。
2. **写操作有两个入口，且行为不一致**：① daemon 队列（工具 → `POST /tasks` → worker，有幂等/限流/落库）；② CLI 直连（`node packages/daemon/src/cli.ts publish --draft …`，**不走限流、不走队列、不落 items**）。面板本身没有任何写能力。这个割裂是最需要收口的架构债之一。
3. **默认 dry-run。** `--submit` 或 `BF_PUBLISH_SUBMIT=1` 才真提交；没拿到 itemId 一律按失败处理（绝不假成功）。
4. **失败语义要说准**：只有 `RATE_LIMITED` / `NETWORK` / `STORAGE` 会自动重试；`VALIDATION` / `AUTH_EXPIRED` / `UNSUPPORTED` / `INTERNAL` 直接 `failed`（**不是 needs_review**，needs_review 只在重试用尽时出现）。发布侧风控已能识别（`channel-cdp/src/risk.ts` 的 `detectPublishRisk` / `withRiskGuards` 每步探测，命中抛 `RISK_CONTROL`，daemon 侧熔断 600s），但**只有单测、没在真机故意触发过**。

## 3. 四模块总览与可用度

| 模块 | 面板分区 | 判定 | 分数 | 一句话依据 |
| --- | --- | --- | --- | --- |
| 自动发布 | 自动发布 | **C 半成品** | 38 | 单件真机成功 2 次（另有 1 次队列路径真机记录，见 §5.1）；批量零真机；失败重排 / pacing / 发布侧风控识别已有代码但只有单测；批次层仍缺、daemon 无常驻 |
| 账号 | 账号 | **C 半成品** | 46 | 只读摘要真机 200；CLI 导入可用；扫码只有 CLI/HTTP 且无真机留档；面板无按钮；多账号未进发布路径 |
| 发布前处理 | 文案 | **C 半成品** | 32 | `xy_copy_plan` 只渲染提示词；2 个 skill 未被宿主发现；缺草稿落盘、发布前合规、生图 |
| 采集参考 | 采集 | **R1 已落地（只读统计）** | — | 解析层 95 测试 + `POST /reference` 真机单件 200（241ms）；缺批量/多账号/面板点击验证；R2 自有商品搬家未实现、待拍板 |

**底座能力（不是模块，但确实可用）**：登录态导入、取商家 + 全量商品、probe 单条详情落库、polish 擦亮、`GET /accounts` 只读摘要、令牌自动刷新（仅 mtop 路径）。这些都是真机验证过的「单点」，但没被组织成模块的日常流程。

## 4. 可用度判定标准

| 级别 | 含义 | 硬门槛 |
| --- | --- | --- |
| **A 可正式使用** | 用户按文档点几下就能完成业务动作，失败了有人工可收尾的入口 | ① 同一路径真机端到端成功 ≥ 2 次；② 失败落库且**有可用的收尾通道**（重试/重新入队/改库以外的入口）；③ 有节流，不会一发就被风控打断；④ 不需要改代码/改环境变量；⑤ 有下架/回滚手段 |
| **B 可用但需人工确认** | 能跑，但要人盯着、手工补参数或逐条跑 | 满足 ①③⑤，缺 ②或④ |
| **C 半成品** | 主链路有真机或单测证据，但缺关键环节（节流、批次、收尾、面板联动） | 至少一段真机通，其余只有单测 |
| **D 未开始** | 只有方案或未接线的底层函数 | 无可执行入口 |

> 判级只看「用户能不能按现有仓库跑通」，不看代码写得多漂亮。**未跑通的路径不得声称成功**（AGENTS §0）。

## 5. 逐模块

### 5.1 自动发布

**边界**：把一份或多份草稿变成闲鱼在线商品并留下证据；不含文案生成、生图、多账号并发、发货。

**今天「发一件」实际要人肉这些步**（`packages/daemon/src/cli.ts`、`channel-cdp/src/launch.ts:147-171`、`daemon/src/cdp-publish.ts:219-233`）：

| # | 步骤 | 现状 |
| --- | --- | --- |
| 1 | 自己用 `--remote-debugging-port` 起 Chrome 并登录闲鱼 | daemon 只 attach，**不会自起浏览器**（`launchChrome` 存在但全仓无调用方） |
| 2 | 起 daemon | `npm run daemon` 前台阻塞，Ctrl+C 结束；**无服务化/自启/日志文件**（`core/src/config.ts:49-64` 无日志路径） |
| 3 | 准备登录态 | 导入（CLI/工具/HTTP）或扫码（只有 CLI/HTTP） |
| 4 | 跑发布 | CLI 直发（绕过队列/限流/items）或队列（工具 enqueue → worker） |
| 5 | 看结果 | `xy_tasks_list` 逐条看 state/lastError（只显示前 80 字）、`xy_status` 计数、items 表；**截图路径没有任何入口能列** |
| 6 | 失败收尾 | **已有入口（单测级）**：`POST /tasks/:id/retry` + `xy_task_retry`（写类、挂审批）把 failed / needs_review 重新排队（attempts 归零、清租约、保留 dedupeKey/payload）；**还没在真机上重放过一次发布** |

**已有真机证据**：单件 dry-run 多次；单件真提交 2 次（`1093817229436`、`1091938715735`，均已下架）；队列路径真提交 1 次（`1091940243200`，已下架）。类目只验证过「学习笔记」。

**到 A 还差（按影响排序）**：
1. ✅ **失败收尾通道**（单测级）：`queue.requeue` + `POST /tasks/:id/retry` + `xy_task_retry`；**缺真机重放验证**与「整批重试」。
2. ✅ **发布侧风控识别**（单测级）：`channel-cdp/src/risk.ts` 每步探测，命中抛 `RISK_CONTROL` 并熔断 600s；**缺真机故意触发验证**。
3. ✅ **账号级 pacing**（单测级）：`core/src/limiter.ts` 默认 180s（夹 30s..3600s），批量工具逐条预约 `availableAt`；**180s 是推导值、未真机校准**，且单条 enqueue 不受约束（写桶 1/60s 兜底）。
4. **批次层**——无 batchId / 批次进度 / 批次汇总；结果粒度=单条任务 + 入队瞬间文本。
5. **daemon 常驻与日志文件**——否则关终端就丢现场。
6. **队列路径端到端真机 ≥2 条**（含一条不支持类目），目前为零。
7. **类目预检**——CDP 侧没有静态白名单，只按页面文本 fail-closed；矩阵只写在文档与面板文案里。
8. **两路径收口**——CLI 直发绕过限流/队列/items，建议收成「队列唯一写入口 + CLI 仅排障」。

### 5.2 账号

**边界**：登录态的导入、加密存储、有效性摘要；不含面板内点按钮、不含多账号切换策略。

**现状**：导入（CLI / `POST /accounts/import` / `xy_import_account`，写操作走 ask 门禁）真机可用；扫码只有 CLI/`POST /accounts/login`，**无真机成功留档**；`GET /accounts` + `xy_accounts_list` 只读摘要真机 200（accountId 2206569289277、21 个字段、ready=true）；面板「账号」分区是静态说明，**没有按钮**。

**到 A 还差**：
1. 面板内点「导入/扫码」——需要 client→host rpc 通道（`ctx.connection.rpc.handle('/bigfish')` + 客户端轮询，灰区，采用前写 ADR）。
2. 扫码真机留档。
3. 多账号：**发布是单 Chrome 单端口 + `assertSameAccount`**，多账号只是数据结构，发布路径用不上。
4. 令牌与发布的关系要说清：`_m_h5_tk` 只在 mtop 调用（probe/polish 等）触发刷新；**发布走 CDP，不刷新 token**，过期只影响 mtop 侧动作。
5. 凭据过期/损坏的用户可见提示（现在只有摘要里的 ready/broken）。

### 5.3 发布前处理

**边界**：把商品原始信息变成「可发布的文案/图片/参数」；不含直接发布。

**现状**：`xy_copy_plan` 是纯函数，产出一段纯文本提示词（skill 路径与输入输出契约 + 5 档风格约束 + 事实 JSON + 合规红线 + 下一步），**不调模型、不写文件、不碰 daemon**。`xianyu-listing-copy` 与 `xianyu-listing-audit` 位于 **`.agents/skills/`**（2026-10-22 从 `skills/` 迁入）：`skill-filesystem` 只扫项目根 `.dsh/skills` 与 `.agents/skills`，后者就是 DSH 项目级 skill 根，**启动即自动发现**，不需要 `customSkillDirs`。

**到 A 还差（五环，缺一环都闭合不了）**：
1. **skill 装载**（✅ 已解决：`.agents/skills/` 自动发现，2026-10-22 迁移后 skill 目录已可见）。
2. **草稿落盘工具**——`xy_publish_draft` 只收 `draftPath`，`xy_copy_plan` 不写文件，现在是人工把文案贴成 JSON。
3. **发布前合规校验**——policy 校验在 daemon 执行时才跑，违规文案会先入队再 failed；应该入队前拦。
4. **dry-run 真执行**——工具 dry-run 只打印命令，agent 无法在对话内完成填表验证。
5. **设置页**——用户要「既有默认又可自己调」；DSH 官方设置体系要 zod（新依赖要 ADR），先按方案 B 在面板内自建设置页 + host 工具落 JSON。
6. （可选）生图——`packages/` 内零实现，只有 `copywriting-and-imagegen-plan.md` 方案。

### 5.4 采集参考

**边界**：参考别人的商品做「标题结构 / 卖点 / 价格区间 / 图片风格」的判断；**不搬运商品、不下载原图入库、不照抄文案**（AGENTS §1.6）。

**现状（R1 已落地）**：`channel-mtop/src/reference.ts`（`parseItemReference` / `extractTitleKeywords` / `summarizeReferences`，只读统计、**绝不返回图片直链**）+ daemon `POST /reference`（head→itemList→detail；单件失败进 `skipped`，`AUTH_EXPIRED`/`RISK_CONTROL`/`UNAUTHORIZED` 中止整批）+ 工具 `xy_reference_collect`（只读、不挂门禁、100s 超时）+ 面板「采集」分区（纯 UI，不联网）。**真机**：2026-10-21 `POST /reference {accountId, itemIds:['1091933071728']}` → 200 / 241ms，item「AI工作流咨询」priceCents 10000、categoryId `50023914`、imageCount 3、seller 西安/在售 7/注册年 2012、siblings 2 条（3000/15000）；keywords 为空是因为只有 1 件、卖点词要求出现次数 ≥2。

仍缺：items 表仍只有 `item_id / account_id / title / price_cents / state / updated_at` 六列（采集结果不落 items）；sellerId 路径、多件汇总、面板点击、GUI 内工具调用都**没真机验证**；搜索接口只有常量 `mtop.taobao.idlemtopsearch.pc.search`，没有 build/parse 实现。

**到 A 还差**：
1. 业务红线拍板：R2「自有商品搬家」未实现、**待用户明确授权**（不碰他人素材）。
2. 真机验证覆盖面：sellerId 路径、多件汇总、面板「采集」分区点击（GUI 里调工具）都还没跑过；批量商品与限流/去重未做。
3. `items` 扩字段（描述/图片数/卖家/类目）——需要先定「存什么粒度」，见红线。

## 6. 公共底座（改动前先看影响面）

| 层 | 位置 | 作用 | 影响面 |
| --- | --- | --- | --- |
| 契约 | `packages/core` | 任务机、队列、凭据接口、policy、限流、熔断、delivery 规则 | daemon、channel-* |
| 队列与 worker | `packages/daemon/src/{queue,worker}.ts` | 幂等入队、领租约、重试语义 | 所有写模块 |
| 通道 | `packages/channel-*` | mtop / CDP / 闲管家 / IM 协议 | daemon 执行器 |
| 工具与门禁 | `packages/plugin-ops/src/{tools,gate}.js` | 14 个 `xy_*` 工具、写操作审批 | 所有模块入口 |
| 面板 | `packages/plugin-ops/client.js` | `PANEL_TABS` 六分区（自动发布/账号/文案/采集/概览/诊断） | 所有模块 UI |

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
