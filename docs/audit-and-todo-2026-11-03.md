# 可用性与完整性评估 + 改进 TODO（2026-11-03）

> 审计口径：**只读**。没改任何代码、没真机发布、没碰真实账号的写操作。
> 唯一真机动作是 `xy_reference_collect` 读了一件自己店的商品（只读 mtop）。
> 所有「写闲鱼」的路径只验到 dry-run 层——`xy_publish_batch(enqueue)` / `xy_task_enqueue` / `xy_publish_draft(enqueue)` 三次尝试都被插件自己的门禁拦下（**门禁有效，这是好消息**），所以批量真提交、失败重放、pacing 校准这三条**本次仍无真机证据**，与 `docs/STATUS.md` §5 一致。

## 0. 证据基线（可复现）

| 项目 | 结果 | 命令 |
| --- | --- | --- |
| 单测 | 1283 pass / 0 fail / 69 suites / 115 文件 / 23.2s | `node scripts/test-all.mjs` |
| client bundle 同步 | ✔ 13 片段 → `client.js` 1673 行 | `node scripts/build-client.mjs --check` |
| 自检 | 1 条要修（两份 chrome-profile）+ 1 条建议（残留 pid） | `node scripts/doctor.mjs` |
| 插件装配 dump | **跑不了**：`spawn EPERM`（`scripts/dsh-dump.mjs:106`） | `node scripts/dsh-dump.mjs` |
| daemon 全端点 | 20 条路由逐条打，含错误路径与越界值 | `.scratch/dogfood/probe-http.mjs` |
| 工具层 | 15 个 `xy_*` 逐个真调 | 本会话直接调用 |
| 工作区 | **87 个未提交改动** | `git status --porcelain` |

⚠️ 87 个未提交改动意味着：`docs/STATUS.md` 的「当前状态」有一部分描述的是**上次提交态**而不是工作树。下文凡涉及「已清零」「只剩 1 处」这类断言，我都用工作树重新核过。

---

## 1. 总评

**能用，但只能按「单件、人工盯着」的方式用。**

| 维度 | 评分 | 一句话 |
| --- | --- | --- |
| 工程卫生 | **A−** | 零第三方依赖、1283 测试全绿、零 `any`、包边界清楚。这是这个库最强的地方。 |
| 单件发布闭环 | **B** | dry-run 干净、错误码稳、真机成功过 4 次。但草稿层零合规校验、面板入队体缺字段。 |
| 批量/多账号 | **D** | 幂等键跨账号串味、租约不续租、批次进度无工具。**第一条真机批量就会踩。** |
| 面板 | **C** | 六个 tab 骨架都对，但有 4 个死控件、3 处「设置写进去不生效」。 |
| 工具层 | **C+** | dry-run 与错误文案质量高；但 `xy_task_action` 100% 失败、`xy_circuit_reset` 不存在。 |
| 能力宣称一致性 | **C** | 文档有三处硬伤：`uniqueCode` 不存在、发布间隔是死配置、`captureJson` 白写了。 |
| 故障恢复 | **D+** | 没有开机自启/崩溃重生；leased 卡死无解；熔断无重置入口。 |

对标 `docs/module-architecture.md` 自带的判定标准（A 需真机端到端 ≥2 次 + 失败有收尾 + 节流 + 不需改代码 + 可回滚）：**四个模块没有一个到 A**，与那份文档的自我评分（38/46/32 分）结论一致——但那份文档的「到 A 还差 8 条」已经过期，今天批次层/常驻/retry 都做了。

---

## 1.5 修复进度（2026-11-03 深夜第一轮，已落盘）

> 本节是回应「我需要你先改，让你用得更加顺手」。基线从 1283 → **1313 tests / 70 suites 全绿**，`client.js` 1741→1827 行。
> 改动原则：**只做不需要真机、不改架构的**；凡是需要真机验收的（批量真提交、风控闭环、pacing 校准）一律留原样并在下面标注。

| # | 条目 | 状态 | 落点 |
| --- | --- | --- | --- |
| P0-1 | 幂等键跨账号串味 | ✅ 已修（插件侧） | `draft.js` 的 `draftDedupeKey(draft, accountId)` 把 accountId 放 canonical 首位；`batch.js`/`publish-flow.js`/面板 `02-draft.part.js` 三处调用同步。**DB 侧 `(account_id, dedupe_key)` 复合唯一仍需迁移**（P1 待做）。 |
| P0-2 | `xy_task_action` 100% 失败 | ✅ 已修 | 先 `client.getTask(id)` 读真实 `leaseOwner`（`daemon-<pid>`），读不到才回退；错误文案按 details 翻成「正被 X 持有（还剩 Ns）」/「不在租约里」。面板同步补 `tasks.action` rpc + leased 行「放回队列」按钮。 |
| P0-3 | `RISK_CONTROL` 被吞成 INTERNAL | ✅ 已修 | `cdp-publish.ts` 的 `code: result.code ?? 'INTERNAL'` + `details:{step, stepCode}`。 |
| P0-4 | 错误 `details` 全链路丢失 | ✅ 已修 | `core/errors.ts` `toApiError` 带 details → `daemon/http.ts` 信封 → `plugin-ops/client.js` `DaemonError.details` → `tool-kit.js` `renderDetails()` 渲染成一行（500 字符上限）。 |
| P0-5 | notFound 一律降级成 VALIDATION | ✅ 已修 | `routes-shared.ts` 的 `taskNotFound`/`batchNotFound` + `queue.ts` 的 `requeue`/`requireLease` 改 NOT_FOUND；`http.ts` 新增 `CODE_STATUS`（NOT_FOUND→404、METHOD_NOT_ALLOWED→405）。 |
| P0-6 | 面板入队体缺 shipping/address | ✅ 已修 | `02-draft.part.js` 的 `buildPublishItems` 补 shipping/address（草稿显式 > 设置默认）；发布 tab 新增「宝贝所在地」输入。 |
| P0-7 | `reply` 漏挂审批门禁 | ✅ 已修 | `rpc-schema.js` 的 `CONFIRM_TASK_KINDS` 加 `'reply'`。 |
| P0-8 | 租约 60s 不续租 + 无 owner fence | ❌ 未修（需真机 + 迁移） | 这条改的是「会不会重复发布」的结构性问题，必须有真机批量证据才能验；留作下一批第一项。 |
| P0-9 | 发布间隔设置是死配置 | ✅ 已修 | `batch.js` 新增 `readSettingsPublishMinIntervalMs`，优先级 = 显式 deps > env > daemon settings > 180s。 |
| P0-10 | 草稿层零合规校验 | ✅ 已修 | 新增 `POST /policy/check`（`daemon/routes-policy.ts`）+ `client.checkPolicy` + `publish-flow.js` 的 `policyLines`/`assertPolicyOk`；dry-run 摆出 `✖ [description] …`，enqueue 本地先拦 error 级。 |
| P0-11 | `items.list` 不透传过滤 | ✅ 已修 | 三层全通：`client.listItems(filter)` → `rpc-schema.readItemsFilter` → `rpc.js`；面板商品 tab 按账号取件、换号清勾选。 |
| P0-12 | 两个「不存在的东西」 | ✅ 已修 | 新增第 16 个工具 `xy_circuit_reset`（接上 `POST /circuits/reset`），`tool-format.js` 两处死引用指向真实工具并注明「写操作，要人工确认」。 |

P1/P2 里一并做掉的（不逐条列）：`/status.capabilities`（agent 不用先入队再等失败就知道 publish/deliver/reply 能不能用）、`xy_task_enqueue` 回执带 created/batchId/availableAt、`xy_items_list` 去掉 P0/P1 内部代号并加过滤参数、`xy_market_brief` 的 sellerId 描述改成与 daemon 一致、`xy_ping` 失败走统一「下一步」表、`xy_reference_collect` 超时 100s→120s（不再倒挂 client 的 90s）、`xy_publish_batch` 60s→120s、草稿相对路径错误文案点名要害、`rpc-schema.js` 补 `UNKNOWN`、概览轮询不叠请求 + 失败退避（`MAX_POLL_BACKOFF_SKIPS`）、设置夹取回执透传（`clamped`）、新用户「保存设置」不再永久灰、面板发布模式芯片真管事、入队参数可复制、`OVERVIEW_TOOL_NAMES` 5→8、概览熔断行给复位入口。

**仍未修（下一批）**：P0-8 租约续租与 owner fence、DB 复合唯一迁移、`msgpack.ts` 两个洞（`__proto__` 注入、64 位整数 bigint 落库失败）、`captureJson` 闲置、channel-guanjia 整包零引用、无开机自启/崩溃重生、采集 tab 无 categoryId 入口、面板 tab 的键盘可达性（无 roving tabIndex / 无 `:focus-visible`）。

---

## 2. 最该先修的 12 条（P0：会骗人 / 会造成错误数据）

> ⚠️ 下表是**审计当时**的原始记录，保留作为证据与背景。修复状态见上面的 §1.5。

这 12 条的共同特征是：**用户看到的和实际发生的不是一回事**，或者**会静默产生错误结果**。

### P0-1 幂等键跨账号串味 → 「以为发了，其实一条没发」

- `packages/core/src/store.ts:38`：`dedupe_key TEXT NOT NULL UNIQUE` —— 全表唯一，**不含 accountId**。
- `packages/plugin-ops/src/draft.js:120-133`：`draftDedupeKey()` 的 canonical 数组里也没有 accountId。
- 后果：同一份草稿第一次发 A 号成功入队、第二次发 B 号 → 命中 `ON CONFLICT DO NOTHING`（`packages/core/src/queue.ts:129-150`），返回 `created:false`，**B 号一件都没发**，而工具回执只说「已入队」。
- 这条直接冲突 `AGENTS.md` 架构不变量 2（写操作必须幂等）。**幂等语义被实现成了「全局去重」，这是两回事。**
- 改法：dedupe 键加 accountId 前缀；`UNIQUE` 改成 `(account_id, dedupe_key)` 复合唯一；表迁移要写清 exists 的旧数据怎么补 account_id。
- 验收：同草稿发两个账号 → 两条任务；同草稿发同一账号两次 → 一条任务 + `created:false`。

### P0-2 `xy_task_action` 在生产环境 100% 失败

- `packages/plugin-ops/src/tools.js:209`：`args.owner ?? deps.owner ?? 'bigfish-plugin'`，而 `packages/plugin-ops/index.js:46` 没给 `buildTools` 传 owner。
- worker 的 owner 是 `'daemon-' + pid`（`packages/daemon/src/runtime.ts:285`）。
- `packages/core/src/queue.ts:288-297` 的 `requireLease` 要求 `leaseOwner` 全等 → **ack / fail / release 对任何真实任务必然 VALIDATION**。
- 更糟：`tools.js:201` 的参数说明写「默认取本机主机名」，与实现不一致，用户照文案填主机名同样失败。
- 后果：**「任务卡在 leased」这个唯一需要人工收尾的场景，工具层完全无解**。daemon 有 `POST /tasks/:id/release` 但需要 owner 匹配。
- 改法：`GET /tasks` 暴露 `leaseOwner`；或给 ack/fail 一条「无租约强收尾」路径（带显式 `force:true`）；或让插件从 `/status` 学到 worker owner 前缀。顺带修 `tools.js:201` 的文案。
- 验收：真机造一条 leased 卡死任务 → `xy_task_action(release)` 成功。

### P0-3 `RISK_CONTROL` 被 daemon 层吞掉 → 不熔断，继续撞风控

- `packages/daemon/src/cdp-publish.ts:115-121`：`if (!result.ok) throw new XianyuError({ code: 'INTERNAL', ... })` —— **不看 `result.code`**。
- 而 `packages/channel-cdp/src/steps.ts:32`、`:52-58` 返回的失败对象是带 code 的。
- 风控保护（`packages/channel-cdp/src/risk.ts:207-221`）只覆盖走 `runRiskGuardedSteps` 的路径。
- 后果：一旦风控命中但没走那条路，`worker.ts:267-286` 看到的是 INTERNAL → **不熔断**，队列继续派下一条 → 连续撞风控 → 账号风险。
- `docs/STATUS.md` §6 第一条「风控码被中间层吞两次」只修好了其中一层。
- 改法：透传 `result.code`，仅当 code 缺失才回落 INTERNAL。

### P0-4 错误 `details` 全链路丢失 → 所有失败退化成「参数错误」

- `packages/core/src/errors.ts:88-90`：`toApiError()` 只返回 `{code, message, retryable}`，**丢掉 `this.details`**（而 `:84` 明明存了）。
- `packages/daemon/src/http.ts:27-29` 直接用它组信封；`packages/plugin-ops/src/client.js:19-31` 的 `DaemonError` 根本没有 details 字段（`:97` 只取 retryable）。
- 丢的是最关键的运营信息：`retryAfterMs`（熔断/限流还要等多久，`executors.ts:167-190`）、`issues`（策略预检逐条原因，`executors.ts:237`）、`httpStatus`（`http.ts:132`/`:146`）。
- `docs/STATUS.md` §6 第二条只在 **rpc 层**修好（`rpc-schema.js` 的 `failEnvelope` 恒带 details），daemon→插件这一段没修。
- 改法：`toApiError` 加 details；`DaemonError` 加 details 字段；`tool-format.js` 渲染「还需等 X 秒」「标题超长 5 字」这类可执行信息。

### P0-5 notFound 一律降级成 VALIDATION

- `packages/daemon/src/routes-shared.ts:58-65`：`taskNotFound` / `batchNotFound` 都 `code: 'VALIDATION'`，注释理由是「core 没有 NOT_FOUND 码」。
- 但 `packages/core/src/errors.ts:8-24` 早就有 `NOT_FOUND` 和 `METHOD_NOT_ALLOWED`。
- 实测印证：`GET /batches/b-does-not-exist` → HTTP 404 但信封 `code:"VALIDATION"`。
- 后果：「任务不存在」被渲染成「参数错误」，用户会去改参数而不是去查队列。

### P0-6 面板入队体缺 `shipping` / `address` / `category` → 面板路径必然 failed

- 面板：`packages/plugin-ops/src/client-bundle/02-draft.part.js:136`
  `const payload = { accountId, title, desc, priceCents, images }` —— 三项全缺。
- 工具：`packages/plugin-ops/src/publish-flow.js:74-87` 的 payload **带**这三项，且 `:80-86` 注释明说「少了 address，『必填项预检』必然 VALIDATION（宝贝所在地为空），任务只会 failed」。
- 后果：**同一个产品，走工具能发，走面板必失败**。而且面板根本没有 address 输入口。
- 附带 bug：`02-draft.part.js:138` 的 dedupeKey 用了 `payload.category ?? null`，而 `payload` 里永远没有 category → 该字段恒为 null。

### P0-7 `reply` 漏挂审批门禁 → 会直接给买家发消息

- `packages/plugin-ops/src/rpc-schema.js:61`：`CONFIRM_TASK_KINDS = new Set(['publish','deliver','polish'])` —— **没有 reply**。
- `packages/plugin-ops/src/tool-kit.js:45-48` 复用它 → `xy_task_enqueue{kind:"reply"}` 不弹确认。
- 但 reply 执行器会真的发消息：`packages/daemon/src/executors.ts:151-161` → `operations.ts:206-213`。
- 违反 `AGENTS.md` §4「写闲鱼 / 写外部系统的工具必须挂审批门禁」。
- 反向问题：`xy_task_retry`（`tools.js:230-248`）是 `access:'confirm'` 且无 `writeWhen`，**只动本地队列却每次弹窗**。
- 改法：`CONFIRM_TASK_KINDS` 加 `reply`；`xy_task_retry` 补 `writeWhen: () => false`。

### P0-8 租约 60s 不续租 + 回收 `WHERE` 无 owner fence → 重复发布

- `packages/daemon/src/worker.ts:23` 租约默认 60s；`:55` 注释自承「P1.1 暂不续」。
- CDP 发布单步就 20s（`packages/channel-cdp/src/publish.ts:111-113`），一次完整发布多步 → **很容易跨 60s**。
- `packages/core/src/queue-sql.ts:49-55` 把「自己那条已过期 leased」也当可领取，`UPDATE` 只按 `id` 不带 owner 条件 → 另一个 worker 能领走同一行 → **同一件商品点两次提交**。
- 今天单进程 concurrency=1 侥幸没出事，但这正是 AGENTS 不变量 2/3 要防的。
- 改法：长任务期间心跳续约；回收 `UPDATE ... WHERE id=? AND lease_owner=?`（fencing）。

### P0-9 发布间隔设置是死配置（面板骗人）

- 面板可写：`client-bundle/07-daemon.part.js:15,21` + `rpc-schema.js:297` + `core/src/settings.ts:82,133`。
- 真正生效的：`packages/plugin-ops/src/batch.js:315-320` —— **只读 `process.env.BF_PUBLISH_MIN_INTERVAL_MS`**，不读 settings。
- `packages/daemon/src` 里 `publishMinIntervalMs` **零命中**（已 grep 确认）。
- 后果：用户把 180s 改成 3600s，**实际节奏一点没变**。这是全套面板里最硬的一条「宣称不符」。
- 另：真正生效的写桶是 60 秒窗口（`packages/core/src/limiter.ts:42` `write: {limit:1, windowMs:60_000}`），设 30 秒会被压到 60 秒且不提示。

### P0-10 草稿层零合规校验（dry-run 什么都不拦）

实测：我构造了「标题 40+ 字 + 描述含『政治/违禁/代购/走私/假货/高仿/复刻』+ 图片指向不存在的 `no-such-image.jpg` + `category:『根本不存在的类目』`」的草稿，`xy_publish_draft` dry-run **全部放行**，只回显「分类：根本不存在的类目（发布时会按下拉选项实际点选）」。

- `packages/plugin-ops/src/draft.js` 只校验 4 项：desc 非空 / priceCents 正整数 / images 非空且绝对路径 / shipping 枚举。
- daemon 侧有策略（`packages/daemon/src/executors.ts:120` `requirePolicy`、`packages/core/src/policy.ts:55-58` 标题 ≤30 字 / ≤9 图 / 价格偏离 70%），但**只在入队后执行**。
- 后果：dry-run 是用户唯一的预检手段，而它不检查最重要的东西 → 35 字标题面板显示通过、入队后 `VALIDATION` failed。
- 改法：`draft.js` 复用 `core/policy.ts` + `.agents/skills/xianyu-listing-audit` 的问题码，dry-run 阶段就把 issues 全列出来。**这是投入产出比最高的一条**（纯本地、零风险、直接挡住真机失败）。

### P0-11 `items.list` 不透传过滤 → 多账号串号操作

- daemon 支持：`packages/daemon/src/routes-items.ts:50-66` 的 `state` / `accountId` / `limit`。
- 插件没传：`packages/plugin-ops/src/rpc.js:64` 是 `'items.list': () => client.listItems()`；`packages/plugin-ops/src/client.js:139` 是 `request('/items')`。
- 后果：多账号下「选中账号 B 却能勾到 A 的商品」，擦亮入队变成 `itemId(A) + accountId(B)` → **真会操作错账号**。
- `packages/plugin-ops/test/client-bundle.test.mjs` 全 2031 行**零处**断言 `items.list` 收到 `accountId` —— 测试把这个洞固化成了契约。

### P0-12 两个「不存在的东西」被当成存在的

1. **`uniqueCode` 不存在**：`grep -r uniqueCode packages` → **No matches**。但 `AGENTS.md:20`、`docs/architecture.md:82`、`docs/p1.3-plan.md:116` 都声称有这条防线。→ 平台侧「这件已发过」的检查**一层都没有**，四层防线全在入队侧。
2. **`xy_circuit_reset` 不存在**：`packages/plugin-ops/src/tool-format.js:298`（「等冷却，或跑 xy_circuit_reset 复位后再试」）与 `:326` 让用户去跑一个不存在的工具。而 daemon 端点 `POST /circuits/reset` 早就可用（`packages/daemon/src/routes-items.ts:68-73`），**只差一个 client 方法 + 一个工具 + 一个 rpc 端点**。

---

## 3. P1：走不通 / 会误导，但有替代路径（14 条）

| # | 问题 | 证据 | 改法 |
| --- | --- | --- | --- |
| P1-1 | `xy_publish_batch` 超时 60s，最坏耗时 300s | `tool-specs-publish.js:76` `timeoutMs: 60_000`；`batch.js:261-303` 串行 ≤20 条 × 15s | 超时按条数动态算；超时后**回报已入队的那几条**而不是中止剩余 |
| P1-2 | 扫码登录 180s 撞 server 180s `requestTimeout` → 假失败 | `daemon/src/login.ts:22` vs `server.ts:44,178` 都是 180_000 | 登录专用超时单独放大，或改成 202 + 轮询 |
| P1-3 | 概览每 3s 最多 7 个 rpc，无退避无可见性暂停 | `client-bundle/03-rpc.part.js:149-152,162,230` ≈140 次/分；`:182-190` 固定 `setInterval` | 合并成一次 `GET /snapshot`；失败指数退避；`document.hidden` 时暂停 |
| P1-4 | 「daemon 没起」与「DSH 没重启」分不清 | `03-rpc.part.js:28` 返回 `{ok:false,code:'',message:''}`，`07-daemon.part.js:80` 一律显示「daemon 未启动」 | connection 为 null 时给独立文案 + 重启指引 |
| P1-5 | 待审任务 / 熔断账号无恢复入口 | `07-daemon.part.js:142-151` 让用户去面板外；rpc 无 `tasks.ack/fail/release`、无 `circuits.reset` | 补 4 个 rpc 端点 + 两个按钮 |
| P1-6 | 批次进度无工具、列表无 batchId/accountId 过滤 | `TaskFilter` 只有 state/kind/limit（`core/src/types.ts`）；`GET /batches/:id` 只有面板在用 | 加 `xy_batch_status`；`xy_tasks_list` 加 batchId |
| P1-7 | 面板四个死控件 | 发布 tab 模式芯片 `09-publish.part.js:89,91`（payload 里没有 mode）；默认类目/风格 `07-daemon.part.js:21` vs `08-panel.part.js:18-21`；「生成批量发布请求」`09-publish.part.js:111,116` 无复制无 rpc | 逐个接通或删掉 |
| P1-8 | 面板预览无法带走、面板产物喂不进 `xy_publish_draft` | 后者 `draftPath` 必填（`tool-specs-publish.js:32-44`），与 `.agents/skills/xianyu-listing-copy/SKILL.md:65-71` 的流程割裂 | 加 `xy_draft_save` 落盘（STATUS T4 已点名） |
| P1-9 | `BF_DATA_DIR=""` 让 daemon 直接死 | `core/src/config.ts:52-63` 的 `assertNonEmpty` | 空串视同未设置，或给中文提示 |
| P1-10 | `pnpm daemon:start` 清残留 pid 时会 `EPERM` | `%LOCALAPPDATA%\bigfish\run\daemon.pid` 权限被拒；且 adopt 分支把 `dataDir` 写成 undefined（`scripts/daemon-service.mjs:119-213`） | pid 文件放可写位置；adopt 时回填真实 dataDir |
| P1-11 | `xy_publish_draft` 相对路径静默读不到 | 实测 `draftPath: ".scratch/..."` → `❌ [VALIDATION] 读不到草稿文件`；插件进程 cwd 不是工作区 | 错误文案加「请传绝对路径」；或支持相对路径按 dataDir 解析 |
| P1-12 | `xy_market_brief` 描述与行为**相反** | `tools.js:354` 说「同时给两个条件都要满足」，`routes-market.ts:77` 是直接拒绝 | 改描述 |
| P1-13 | `xy_task_enqueue` 回执残缺；`xy_items_list` 文案过时 | `tools.js:188` 丢 created/batchId/availableAt；`:253,257` 仍说「P0 空表、P1 才落库」 | 回执补字段；删掉内部阶段代号 |
| P1-14 | 两个插件文件超 AGENTS 400 行 | `tool-format.js` 426 行、`daemon-supervisor.js` 504 行（HEAD 是 331/366，是未提交改动撑破的） | 拆分 |

---

## 4. P2：体验 / 无障碍 / 一致性（12 条）

1. **无键盘支持**：tab 有 `role/aria-selected` 但没有 roving tabIndex、没有 ←→/Home/End；全仓 13 个片段 grep `onKeyDown|tabIndex` **零命中**。
2. **无焦点可见样式**：`10-styles.part.js` 无 `:focus-visible` / `outline`。
3. **表格不是语义表格**：`ITEM_COLUMNS` / `ACCOUNT_COLUMNS` 都是 div+grid，无 `role=table/row/columnheader`。
4. **disabled 原因只在 title**：键盘和读屏都拿不到（`08b-items.part.js:90,94`、`09-publish.part.js:17`）。
5. **`role=status` 覆盖不全**：账号表检测结果、商品表变化无 live 区域。
6. **首次打开概览「保存设置」永久灰**：`07-daemon.part.js:20` 要求 `form.category.trim() !== ''`，而 core 默认 `defaultCategory: ''` → 新用户必须凭空编一个类目才能保存。
7. **切换当前账号无二次确认**：`11-account.part.js:124-133` 一次点击就改 `settings.activeAccountId`，而后续所有发布/擦亮都按它走。
8. **确认后无撤销**：只有 `daemon.stop` 有 `cancelStop`，其余 5 秒后消失就没了。
9. **设置被夹取却不告知**：daemon 设计了 `clamped`（`routes-settings.ts:30-31,52`，注释「不要静默」），但 `client.js:102` 只 `return payload.data` → 面板永远收不到。
10. **商品只有 50 条不能翻页**：`08b-items.part.js:23-28` 不传参 → `core/src/items.ts:21` `DEFAULT_LIST_LIMIT=50`（上限 500）。
11. **插件版本硬编码 `0.0.0`**：`packages/plugin-ops/index.js:28` → `xy_ping` 报的版本号对排障无用。
12. **文案里的内部代号**：`xy_items_list` 空态说「P1 接入后填充」，`xy_accounts_list` 说「✅ 可写」（其实是「字段齐备」，读起来像「现在能写闲鱼」）。

---

## 5. 完整性：能力矩阵（如实）

图例：**真机** = 真机跑通过；**单测** = 只有单测/假数据；**未做** = 没有。

| 能力 | 状态 | 卡在哪 |
| --- | --- | --- |
| 登录态导入 | 真机 | — |
| 扫码登录 | 真机 | 180s 撞 server 超时（P1-2） |
| 令牌自动刷新 | 真机 | — |
| probe / polish | 真机 | polish **不读响应**（`operations.ts:148-156` 返回 void，全仓无 `parsePolish`） |
| 单件发布 dry-run | 真机 | 草稿层零合规校验（P0-10） |
| 单件发布真提交 | 真机 ×4 | 全是「学习笔记」类目、全单件 |
| 批量入队 | 单测 + 1 次 dry-run | 幂等跨账号（P0-1）、超时倒挂（P1-1） |
| 批量真提交 | **未做** | 需要用户拍板用哪个号 |
| 失败重放 | 单测 | owner 断链让「人工收尾」这条路走不通（P0-2） |
| 发布侧风控识别 | 单测 | 命中可能被吞成 INTERNAL（P0-3） |
| pacing 校准 | 单测 | settings 是死配置（P0-9） |
| 采集参考（只读统计） | 真机 | `POST /reference` 会把**他人描述原文**返回给调用方（`channel-mtop/src/reference.ts:261`），与「只出统计」的红线相悖；落库路径才真的剥了（`seller-collect.ts:253-254`） |
| 市场简报 / 建议价 | 单测 | 无样本时只能看空态；价格缺失静默变 0 会污染价格带（`reference.ts:249`） |
| 文案 skill ×2 | 可用 | 产物写不进 `xy_publish_draft`（P1-8） |
| AI 生图 | **未做** | `settings.imageProvider` 字段能存能读、**零消费者**（比「方案」多了一步，容易误读成已接线） |
| 地址库 | **未做** | CDP 下地址搜索候选不回显 |
| 自动发货 deliver | **未做** | `operations.ts:202-204` 恒 `UNSUPPORTED`；core `delivery.ts`（20KB 规则引擎）除自身单测外**零消费者** |
| IM 收发 reply | 真机只到握手 | 不按 `pts` 续传；`channel-im/src/msgpack.ts` 有两个解码洞（见 6.1）；插件无工具无 rpc |
| 定时任务（定时擦亮） | **未做** | 无 cron、无调度表；只能手工 `availableAt` |
| 只读「相机」`GET /camera` | **未做** | 实测 404 |
| 开机自启 / 崩溃重生 | **未做** | 待 ADR |
| 熔断重置 | 端点有、无入口 | `xy_circuit_reset` 不存在（P0-12） |
| 闲管家开放平台 | **未做** | 整包零外部引用，四个凭证无注入路径 |

---

## 6. 值得单独说的三个技术洞

### 6.1 `channel-im/src/msgpack.ts` 两个会静默丢消息的洞

边界保护做得不错（嵌套深度上限 32、长度越界、坏数据保留已解出前缀、未知类型整条失败，全有用例），但缺两项：

1. `readMap` 用 `record[key] = value` 直接赋值（`:100-101`），**没有 `__proto__` / `constructor` 防护**。实测构造 `{__proto__:{polluted:1}}` 解码后 `Object.keys()` 为空、`rec.polluted === 1`。不是 RCE（全局 `Object.prototype` 未被污染），但足以把字段解析成幽灵属性。
2. **64 位整数解出 `bigint`**（`:70-75`、`:145-160`），`raw` 带 BigInt 一路传到 `core/src/im-messages.ts:135` 的 `encodePayload` → `JSON.stringify` 抛「Do not know how to serialize a BigInt」→ `daemon/src/im-client.ts:271-274` 吞成 STORAGE 事件 → **整条消息不落库**。

修法很便宜：两条用例（`__proto__` 不污染原型、大整数不阻断落库）+ 把 `msgpack.ts` 从 `index.ts` 导出（现在它是纯私有，改它不触发任何跨包类型检查，也无法复用来做断线补拉）。

### 6.2 `CdpPage.captureJson` 是闲置资产

`packages/channel-cdp/src/page.ts:152-209`，145 行、带 `loadingFinished` 竞态兜底、8 条测试——**生产代码零调用**。它是「免签名读 mtop」这条路的唯一实现。它能替代的 DOM 依赖：类目推荐、地址候选、商品状态。`docs/STATUS.md` 完全没提这个能力。

### 6.3 发布页 DOM 知识是最高价值也最不可维护的部分

散在 5 个文件：选择器表（`publish.ts:65-76`）、6 段页面脚本字符串（`category-page.ts:51-183`）、4 种填值路径（`dom.ts:107-276`）、风控探测脚本（`risk.ts:71-99`）。**零 fixture 快照**。所有「为什么必须用可信鼠标事件 / 为什么不能 `scrollIntoView` / 为什么回车要带 `text:'\r'`」都靠长注释传给人脑，改版唯一验证手段是真机重跑 + 人看截图（而且沙箱里跑不了，见 AGENTS §7.11）。

建议：把 antd 下拉 / Lexical 输入 / 地址联想三块的**页面输出样本**（`getBoundingClientRect`、`outerHTML` 片段、`aria-*`）落成 fixture，让「闲鱼改版了」能用一条命令在本地检出来，而不是靠用户投诉。

---

## 7. TODO（按建议顺序）

### 第一批：不用真机、零风险、直接减少真机失败（1–2 天）

- [ ] **P0-10** `draft.js` 接 `core/policy.ts` + `xianyu-listing-audit` 问题码，dry-run 列出全部 issues
- [ ] **P0-4** `details` 打通（`errors.ts:88` → `http.ts` → `client.js:97` → `tool-format.js` 渲染）
- [ ] **P0-5** notFound 改用 `NOT_FOUND`；405 改用 `METHOD_NOT_ALLOWED`
- [ ] **P0-2** owner 断链（`/tasks` 暴露 leaseOwner + 强收尾路径 + 修 `tools.js:201` 文案）
- [ ] **P0-12** 补 `xy_circuit_reset`（client 方法 + 工具 + rpc 端点，daemon 端点已有）
- [ ] **P1-12 / P1-13** 三处工具文案与回执（market_brief 描述、items_list 过期文案、task_enqueue 回执）
- [ ] 清掉 `xy_circuit_reset` 之外的所有「指向不存在能力」的文案（`tool-format.js:298,326`）

### 第二批：安全与正确性（必须真机验一次，3–5 天）

- [ ] **P0-1** 幂等键加 accountId + 复合唯一索引 + 旧数据迁移
- [ ] **P0-3** `cdp-publish.ts` 透传 `result.code`
- [ ] **P0-8** 租约心跳续约 + 回收加 owner fence
- [ ] **P0-6** 面板入队体补 `shipping`/`address`/`category`，或直接改成调 `publish-flow.js` 的 `enqueuePublish`
- [ ] **P0-7** `CONFIRM_TASK_KINDS` 加 `reply`；`xy_task_retry` 降级
- [ ] **P0-9** settings 真正生效（daemon 读 settings 注入批处理），或删掉这个设置项
- [ ] **P0-11** `items.list` 透传 `accountId`/`state`（并补一条断言，防再退化）
- [ ] **6.1** msgpack 的 `__proto__` + BigInt 两个洞
- [ ] 把 URL leak 修掉：`POST /reference` 不返回他人 `desc` 原文

### 第三批：让批量真能跑（需用户拍板账号，3 天）

- [ ] **P1-1** `xy_publish_batch` 超时按条数算 + 部分入队可回报
- [ ] **P1-6** `xy_batch_status` + `xy_tasks_list` 支持 batchId
- [ ] 真机跑一批（2–3 件、同一账号、dry-run → submit），记 batchId 与截图
- [ ] 顺带校准 pacing（`BF_PUBLISH_MIN_INTERVAL_MS` 与写桶 60s 的关系要写清楚）

### 第四批：面板从「能用」到「好用」（3–4 天）

- [ ] **P1-3** 轮询合并成 `GET /snapshot` + 退避 + `document.hidden` 暂停
- [ ] **P1-4** 三种离线态分开（daemon 没起 / DSH 没重启 / 鉴权失败）
- [ ] **P1-5** 待审任务与熔断账号的恢复按钮
- [ ] **P1-7** 四个死控件逐个接通或删掉
- [ ] **P1-8** `xy_draft_save`（STATUS T4）
- [ ] P2-6「保存设置」首次可用（默认类目给候选而不是空串）
- [ ] P2-9 `clamped` 渲染出来
- [ ] P2-1~5 无障碍一轮（键盘 tab、focus-visible、语义表格、live region）

### 第五批：基础设施（需 ADR）

- [ ] 开机自启 / 崩溃重生（dogfood-todo 唯一剩下的 ⬜ 之一）
- [ ] 单实例保护改按数据库而不是端口+pid
- [ ] 三份 dataRoot 实现合并（`core/config.ts` vs `plugin-ops/config.js` vs `scripts/lib/daemon-service.mjs`，其中 1 份在 POSIX 上与 core 不一致）
- [ ] `doctor` 补：`credential.key` 存在性与 32 字节、熔断文件、队列状态
- [ ] `GET /camera`（T5）
- [ ] 定时擦亮（T8）

### 文档债（半小时，但影响信任）

- [ ] `AGENTS.md:20` 删掉/改正 `uniqueCode` 的说法（或真去实现它）
- [ ] `AGENTS.md` 关于 client.js 1465 行已过期（实际 1673）
- [ ] `docs/module-architecture.md` §5.1「到 A 还差 8 条」已部分过期
- [ ] `packages/daemon/README.md:32-33` 仍写「publish/deliver/reply 全 UNSUPPORTED」
- [ ] `docs/STATUS.md` §5「超 400 行已清零」在工作树里已经不成立
- [ ] `docs/im-protocol.md:245` 声称的「base64 3092 字节真实样例」**不在仓内**，任何解码改动都无法用真实语料回归

---

## 8. 就功能而言，还要学什么

按「学了这个能不能立刻做出新功能」排序。

### 8.1 最该补的一块：mtop 的**发布 / 类目推荐 / POI / 搜索**载荷

`packages/channel-mtop/src/api.ts:20-29` 的 8 个接口里有 **5 个只剩名字**：`publish`、`backendPublish`、`search`、`propertyRecommend`、`poi`。一个 `buildXxxData` / `parseXxx` 都没有。

这一块缺了，代价是三条链全绑在 DOM 上：

- **发布**只能走脆弱的页面填表（改版就全瞎）
- **类目推荐**只能靠页面自己发（所以我们既不能预判候选，也无法在批量前校验类目可行性）——`MTOP_APIS.propertyRecommend` 的版本常量写着 `'2.0'` 却从未被请求过
- **地址**只能靠 UI 点击（`docs/architecture.md:249-251` 那条「CDP 下候选不回显」的限制，本质是这条知识缺失的替代品）

具体要拿到的三样：发布载荷里 `imageInfoDOList` 的结构、`kgraph.property.recommend` 的入参/响应 schema（入参 `title/description/imageInfos`，一次约 10 个候选）、`poi.get` 的坐标→地址格式。**补齐任一条都能把一条 DOM 依赖换成接口依赖。**

> 注：`api.ts:26` 写 `mtop.taobao.kgraph.property.recommend`，`category.ts:18,279` 的注释写 `mtop.taobao.idle.kgraph.property.recommend`。全仓没有代码真调这条接口，所以哪个是平台真名**现在无法判定**——这本身就是「知识不足」的证据。

### 8.2 风控与账号养护（做多账号/批量之前必须懂）

代码里已经有了：`core/src/risk.ts:14-67` 的 ret 分类、`channel-cdp/src/risk.ts:36-65` 的页面信号三张表、熔断 600s、写桶 1 次/60s。但「为什么是这个值」「撞了之后多久能恢复」目前没有依据。

要学的是：`RGV587_ERROR` / `FAIL_SYS_USER_VALIDATE` / `x5sec` / `/_____tmd_____/punish` / `baxia` 各自意味着什么等级的惩罚；哪些是接口级频控（`mtop.taobao.idlemessage.pc.login.token` 是独立频控点，实测同账号其他接口照常 SUCCESS）、哪些是账号级；cookie 新鲜度与风控概率的关系；为什么「停手冷却」优于「退避重试」。

**这块直接决定批量发布能不能做**——现在 `pacing 180s` 这个数字是拍的，没有依据。

### 8.3 队列/分布式语义（决定「会不会重复发布」）

现在的实现是「至少一次」语义，但产品和文档都在暗示「恰好一次」。要补的：

- 租约 + fencing token 的正确写法（worker 崩了怎么办、`WHERE` 要不要带 owner）
- at-least-once 下**业务侧怎么做幂等**（平台侧幂等键 vs 本地去重键的区别）——这正是 P0-1/P0-12 的病根
- outbox 模式（「先写库再发请求」还是「先发请求再写库」）
- SQLite WAL 的并发边界（什么时候真的会出现双写）

### 8.4 CDP 与前端框架交互（决定发布能不能稳）

- CDP 协议本身：`Runtime.evaluate` / `DOM.*` / `Input.dispatchMouseEvent` / `Page.captureScreenshot` 各自的边界（为什么 `el.click()` 对 antd Select 无效）
- **React 受控组件与 Lexical 编辑器**：为什么必须走原生 setter + `Input.dispatchKeyEvent`，为什么 `contenteditable` 的换行要单独派发
- antd / `rc-virtual-list` 的 portal 机制：为什么不能全页扫 `.ant-select-item-option`、为什么 `scrollIntoView` 会毁掉点击（会滚主页面 → 重排 → 落空）
- 可信事件 vs 合成事件：`isTrusted` 到底影响什么

### 8.5 IM / 长连接协议（P2 自动发货和 AI 客服的地基）

- `lwp` 协议：帧头字段、`mid/sid`、`pts` 游标的语义（为什么是「毫秒×1000」）、ACK 为什么必须先发再处理
- **MessagePack 解码**：现在的 `msgpack.ts` 只实现了子集，要懂 spec 才知道哪些类型没覆盖（这也是 6.1 两个洞的来源）
- 断线补拉：`/r/MessageManager/listUserMessages`（`docs/im-protocol.md:248`）仍是未实现状态，不做这个，断线期间的消息永久丢失
- 「静默判死」的问题：现在**不按静默判死**（`4b394a6` 刻意删掉了 `HEARTBEAT_TIMEOUT_MS`），要理解为什么，以及正确的做法是什么（应用层 ping vs 协议层心跳）

### 8.6 闲鱼平台规则与合规（决定商品能不能活）

- 类目支持矩阵：为什么网页端只支持「电子资料/学习笔记/课业本」，`docs/STATUS.md` 的 `CATEGORY_MATRIX` 是怎么得来的、会不会变
- 违禁词与禁售类目：`.agents/skills/xianyu-listing-audit/references/audit-codes.md` 现在是手写的，需要知道依据
- AI 生成内容的标注义务（`usedAiImages` 字段已有，但没人校验）
- 商品下架/风控处置的实际流程（现在 `docs/delivery-rules.md` 有一些，但发布侧的处置策略没有）

### 8.7 DSH / Cordis 插件体系（加功能的地基，你已经会一半）

- 公开扩展点：`ctx.tools.register`、`ctx.on('tools/pre-execute')`、`ctx.jobs.start`、`ctx.slots.inject`、`ctx.subagents`、cron → `agent.followup`
- client bundle 的单文件约束（ADR 0006）与「只能 require 9 个静态模块」的边界
- 审批门禁的正确挂法（`access` / `reason` / `writeWhen` 三件套）——P0-7 就是没挂对

### 8.8 运营/选品（决定这个工具值不值得用）

技术通了不等于有用。要补的是：闲鱼 listing 的标题结构（4 段式、5 个标签）、定价与成色系数、市场简报的统计口径（p25/p50/p75 在样本量 <10 时能不能看）、什么类目值得做。这部分 `docs/xianyu-4q-research.md` 与两个 skill 里已经有不少，但**没有和真实成交数据对上过**。

---

## 9. 一句话结论

**这个库的工程质量（A−）远好于它的产品完整度（C）。** 最值得先做的不是加功能，而是把「已经写了但没接通」的那 12 条 P0 接上——它们全都不需要真机、不需要新知识，只需要把已有的两端连起来（`/circuits/reset` 早就通了、`core/policy.ts` 早就写好了、`details` 早就存在内存里）。

真机批量发布之前，P0-1（幂等跨账号）和 P0-8（租约不续租）必须先修，否则「重复发布」这件事是**结构性**的，不是概率问题。
