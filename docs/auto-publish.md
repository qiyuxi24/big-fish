# 自动发布：要处理什么、现在在哪、怎么验证

> 现状与下一步的唯一事实源是 [STATUS.md](STATUS.md)；本文只展开「自动发布」这一块的施工设计。
> 最后更新 2026-10-21。**当前主线**（用户 2026-10-21 决定：先做自动发布，其他功能按解耦顺序往后排）。

## 1. 定义与边界

**自动发布 = 一批草稿 → 逐条校验 → 批量入队（幂等）→ daemon 单账号串行执行 CDP 发布 → 结果落库 / 失败进待审。**

明确**不包含**（保持解耦，各做各的）：
- 不包含文案生成与生图：文案走 `skills/xianyu-listing-copy` + `xy_copy_plan`，生图只有方案（[copywriting-and-imagegen-plan.md](copywriting-and-imagegen-plan.md)）。
- 不包含 IM / 自动发货：那是 P2，`channel-im` 已提交但未接 daemon，`deliver`/`reply` 仍是 `UNSUPPORTED`。
- 不包含 GUI 之外的执行：daemon 不调 LLM（AGENTS §1.1），面板不执行写操作，面板只产出「请求」。
- 不做多账号并发：单账号写串行、QPS ≤ 1 是硬不变量；多账号是以后的事。

## 2. 流水线（五段，每段单独可测）

```
草稿集（JSON/目录） → ①批次校验 → ②批量入队（幂等 dedupeKey） → ③daemon worker 串行执行
                                                                      ↓
                                                     ④CDP 步骤机：填表 → 选类目 → 价格 → 地址 → 提交
                                                                      ↓
                                          ⑤结果：itemId 落 items 表 / 失败分类 → 待审 or 退避重试
```

| 段 | 现在有什么 | 缺什么 |
| --- | --- | --- |
| ① 草稿与校验 | `plugin-ops/src/draft.js`：`validatePublishDraft`（title/desc/priceCents/images 绝对路径/quantity/shipping/pricingMode/address/category）+ `draftDedupeKey`（内容哈希，同草稿重复入队只留一条） | 批次层：一次处理 N 条、单条非法不拖垮整批、批内重复先挡 |
| ② 入队 | `POST /tasks`（`kind: publish`，payload `{accountId,title,desc,priceCents,images,category?}`）；`core/src/queue.ts` 的 dedupeKey `ON CONFLICT DO NOTHING`（命中不新建、不重置 attempts） | 批量入队工具（`xy_publish_batch`）+ 每条结果状态表（queued / skipped-duplicate / invalid） |
| ③ 执行 | `packages/daemon/src/worker.ts`：concurrency 默认 1、同 accountId 最多一个在飞、租约 60s；`UNSUPPORTED/VALIDATION/AUTH_EXPIRED` 等不可重试码直接 failed 进待审 | 批量进度汇总；单条 `POST /tasks` 直接入队**不受账号级 pacing 约束**（写桶 1/60s 兜底） |
| ④ CDP 发布 | `packages/channel-cdp/src/publish.ts` 步骤机 + `category.ts` 选类目；`operations.ts` 里 `publishItem` 只在 `BF_PUBLISH_SUBMIT=1` 时真提交；每步截图（`BF_PUBLISH_SCREENSHOTS`，默认 `<data-dir>/publish-shots`） | 批量下的失败分类统计；类目不支持时提前拦（现在到提交才 `VALIDATION`） |
| ⑤ 结果 | `items` 表 upsert、任务 failed→待审（`needs_review` 语义）；failed / needs_review 可用 `POST /tasks/:id/retry` + `xy_task_retry` 重新排队（单测，未真机重放） | 批次维度结果汇总（这一批几成几败、卡在哪、截图路径）；整批重试 |

## 3. 幂等与失败语义（不许破的规则）

1. **幂等键来自草稿内容**（`publish:<fnv1a(canonical)> `）：同一份草稿重复入队 → 队列只留一条，返回已有记录。改一个字就是新键，会真的再发一次——所以在批量工具里必须把「批内重复」先挡掉并报出被跳过的是第几条。
2. **失败不退预算、不盲目重放**：`VALIDATION / AUTH_EXPIRED / UNSUPPORTED / INTERNAL / UNAUTHORIZED / UNKNOWN` 不可重试，直接 failed（人工看）；只有 `NETWORK / RATE_LIMITED / STORAGE`（以及风控冷却后的 `RISK_CONTROL`）走退避 `min(60·2^(n-1), 1800)s`。发布侧风控由 `channel-cdp/src/risk.ts` 每步探测，命中抛 `RISK_CONTROL`（带 `details.step`），daemon 侧熔断 600s；**目前只有单测，没在真机故意触发过**。
3. **绝不假成功**：CDP 发布成功但拿不到 `itemId` 按 `INTERNAL` 失败处理（`operations.ts`）；面板与工具输出一律区分「已入队」和「已发布」。
4. **类目是硬边界**：网页端支持矩阵 —— ✅ 电子资料 / 学习笔记 / 课业本；❌ 教材教辅 / 语言与兴趣培训 / 学习资料定制 / 文学 / 考研咨询。命中「网页版暂不支持发布此分类」立即 `VALIDATION`，不做绕过尝试。

## 4. 本次施工（第一刀，只做这三件）

| 编号 | 做什么 | 文件 | 验收 |
| --- | --- | --- | --- |
| A1 | 侧边栏面板内「自动发布」tab（`PANEL_TABS` 第一项、默认选中）：流水线说明 + 草稿集粘贴 + 发布前校验 + 产出请求 JSON（不联网、不执行） | `packages/plugin-ops/client.js`（面板内模块 tab） | 桌面端 GUI 实拍点开看到面板；`plugin-ops` 测试全绿 |
| A2 | `xy_publish_batch`：批量校验 + 幂等入队 + 逐条状态汇总；`mode=dry-run` 默认 | `packages/plugin-ops/src/batch.js`、`tools.js`、`gate.js` | 单测（假 daemon client）+ 全量测试；写类工具走审批门禁 |
| A3 | 真机小批量试验：1 条 dry-run → 1 条真发 → 观察队列/截图/itemId | 无代码（用已导入的账号，默认 dry-run，真发须用户点头） | 见 §5 验收口径 |

后续（不跨步）：B1 批量 pacing（任务间隔、夜间不跑）→ B2 批次汇总端点/面板进度 → B3 类目矩阵补测（A3 扫码兜底）→ B4 一条命令跑 10 件并回归。

**已落地**：
- **A1 ✅**：`packages/plugin-ops/client.js` 的 `PANEL_TABS` 第一项 = 自动发布（点侧边栏「BigFish 闲鱼运营」进面板即默认这个分区）。面板 = 流水线四步说明 + 草稿集 textarea（每行内联 JSON 或 `.json` 路径）+ 发布前校验（JSON 合法性、缺字段、类目矩阵提示）+ 模式 chips（dry-run / enqueue，默认 dry-run）+ 「生成批量发布请求」产出 `xy_publish_batch` 参数 JSON + 发布命令清单。纯客户端：不联网、不调模型、不执行写操作。**2026-10-21 曾注册成会话顶部 tab（`conversation.view`），用户要求主页面在侧边栏面板里，已收回面板内**。
- **A2 ✅ 单测**：`packages/plugin-ops/src/batch.js`（`normalizeBatchArgs` / `prepareBatch` / `runBatch` / `formatBatchResult`）+ 第 11 个工具 `xy_publish_batch` + `gate.js` 审批口径（仅 `mode=enqueue` 需确认）。单条与批量共用 `publish-flow.js` 的 `buildPublishEnqueueInput`，幂等键同口径（`publish:<8hex>`）。
- **A3 🟡 半程**：单件 dry-run（含类目 + 地址）与**单件真提交**均已真机通过，见 §5.1；**批量（≥2 条）与「含不支持类目」还没跑**。
- **A4 失败收尾 ✅ 单测**：`core/src/queue.ts` 的 `requeue`（failed / needs_review → queued，attempts 归零、清租约与 lastError、保留 dedupeKey/payload）+ `POST /tasks/:id/retry` + 工具 `xy_task_retry`（写类、挂审批，理由写明 `BF_PUBLISH_SUBMIT=1` 下会真重放）。**未真机重放发布。**
- **A5 账号级 pacing ✅ 单测**：`core/src/limiter.ts` 的 `resolvePublishMinIntervalMs`（默认 180s，夹 30s..3600s）与 `nextPublishAvailableAt`；`plugin-ops/src/batch.js` 批量按账号逐条预约 `availableAt`，支持 `BF_PUBLISH_MIN_INTERVAL_MS`，入队失败不占位。**180s 是推导值、未真机校准；单条 enqueue / 直接 `POST /tasks` 不受约束**（写桶 1/60s 兜底）。
- **A6 发布侧风控识别 ✅ 单测**：`channel-cdp/src/risk.ts`（`detectPublishRisk` 探测 URL/文案/验证组件；`withRiskGuards` 每步前/抛错/步后探测，命中抛 `RISK_CONTROL` 带 `details.step`）；daemon 侧任务命中即熔断 600s。**只有单测、未真机故意触发。**

### 4.1 分类选择曾经卡住，已修（真机根因，别再踩）

2026-10-21 带 `category` 的 dry-run 报「点了分类「学习笔记」但下拉显示的是「电子资料」」，fail-closed。真机定位到三条叠加因：
1. 旧 `readOptionPoint` 对下拉选项调 `scrollIntoView`，antd 下拉挂在 body 级 portal，**滚的是主页面**（scrollY 94→29），下拉随之重排，可信点击落空并被当成「点了外面」→ 下拉开始关闭、值不变。
2. 选项查询是全页 `.ant-select-item-option`，没排除 `.ant-select-dropdown-hidden` 的历史 portal，也没断言「分类」下拉真的打开。
3. 点击后 `selection-item` 更新有延迟（6ms 仍是旧值、23ms 才变），"点完立刻回读一次"必然误判。

修法（`channel-cdp/src/category.ts` + 新增 `category-page.ts`）：按 `aria-controls/aria-owns` 绑定当前 Select 的下拉、只认可见下拉、不对选项滚动页面、点击前 `elementFromPoint` 命中测试、用 `.ant-select-open`+`aria-expanded` 判打开、连续 2 次回读一致才算选中（最多重试 3 次），仍不一致就 fail-closed。16 个单测守护（含隐藏 dropdown 同名选项、下拉没开先开、回读不一致重试后成功）。

**批量还缺（daemon 侧，B 阶段做）**：
1. 没有批次概念：批量只是 N 条独立 publish 任务，无 `batchId` / 批次进度 / 批次失败汇总查询。
2. 跨批重复识别不出：`POST /tasks` 对重复 `dedupeKey` 也回 201 + 既有记录、没有 `created` 标志，插件侧只能显示 queued（批内重复才能标 skipped-duplicate）。建议 daemon 返回 `{created:boolean}` 或 200/201 区分。
3. 待审任务已能逐条 retry（`xy_task_retry`，单测级），但仍缺「整批重试/整批放行」。

## 5. 真机试验验收口径（做不到就不算完成）

- [ ] `BF_PUBLISH_SUBMIT=1` 起 daemon，`/status` 的 worker 在轮询、accounts 里有已导入的账号。**未做**：目前的真发走的是 CLI `publish --submit`（单件），没经过队列。
- [ ] 同一批次连续 enqueue 两次：第二次全部 `skipped-duplicate`，`/tasks` 不新增。**未做真机**（批内重复有单测）。
- [ ] 真发成功后 `items` 表有 itemId，截图目录有每一步 PNG。**一半**：真发成功拿到 itemId、每步截图齐；但 CLI 直发**不落 items 表**（items 是 daemon 队列路径才写）。
- [ ] 故意给一条不支持类目的草稿：`VALIDATION`、`needs_review`，同批其他条仍继续，不整批崩。**未做真机**（category 层 fail-closed 有单测）。
- [ ] 失败任务不重试不可重试码（看队列 attempts 不变）。**未做真机**（worker 单测覆盖）。
- [ ] 用 `xy_task_retry` 把 failed 任务重新排队并**真机重放一次发布**。**未做**（`requeue` / 端点 / 工具均有单测）。
- [ ] 账号级 pacing 真机校准：连发两件确认间隔 ≥180s 且不再被风控。**未做**（180s 是推导值，只有单测）。
- [ ] 真机故意触发一次发布侧风控，确认 `RISK_CONTROL` + 熔断 600s。**未做**（只有单测）。
- [x] 全仓测试全绿 + 6 个 TS 包 tsc 0 错误（709 tests / 27 suites / 73 个测试文件；core、daemon、mtop、cdp、guanjia、im 六个包 tsc 0）。

### 5.1 真机记录（2026-10-21/22，用户大号 `2206569289277`——AGENTS §5：这个账号不是测试小号，真发须用户点头、一次一件）

| 动作 | 结果 | 证据 |
| --- | --- | --- |
| dry-run，草稿无 category/address | exit 0，7 张步骤截图；分类空、所在地「请选择地址」→ 说明不带这两项过不了提交前预检 | `.scratch/pubtest/shots-dry/99-dry-run.png` |
| dry-run，草稿带 category=学习笔记 + address | exit 0，13.1s；日志「AI 识别为「电子资料」→ 选为「学习笔记」」，地址候选回填「西北工业大学长安校区星天苑」 | `.scratch/catfix/shots/99-dry-run.png`、`.scratch/catfix/cli-dryrun.log` |
| **真提交**（CLI `publish --submit`） | exit 0，14.5s，**itemId `1091938715735`**，成功页 `https://www.goofish.com/item?id=1091938715735` | `.scratch/pubtest/shots-submit/`（提交各步） |
| 立即下架 | 弹窗「确定要下架这个宝贝吗？」→ 确定 → reload 后页面显示「已下架」 | `.scratch/pubtest/shots-submit/11-item-page.png`、`12-delist-clicked.png`、`13-delist-verified.png`、`trial-result.json` |
| 更早一次真发（人工留档） | itemId `1093817229436`，已下架 | 无 repo 内证据（当时未留脚本产物） |
| 队列路径真发（`POST /tasks` → worker → `operations.publish`） | itemId `1091940243200` 落 items 表，已下架；同账号约 15s 内发第二件被风控（RATE_LIMITED → INTERNAL），由此定为需要账号级 pacing | `.scratch/pubtest/qdata/`、`.scratch/pubtest/queue-trial.mjs` |

**边界（别扩写）**：真发只跑过**单件**（3 次：2 次 CLI 直发 + 1 次队列路径）、只跑过**「学习笔记」**类目；批量、重复去重、不支持类目混批、失败重放都还没真机验证。

## 6. 与 P2（自动发货）的关系

自动发布不动 IM/订单。P2 的三步（P2.0 半自动 → P2.1 IM 接线 → P2.2 全自动）仍按 [STATUS.md](STATUS.md) §4 走，等发布这条线跑顺再切。
