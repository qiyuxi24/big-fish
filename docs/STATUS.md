# 项目状态 — 单一事实源

> **最后更新 2026-10-26 中午（账号模块 v3：**托管浏览器**——扫码/导入/发布共用同一个调试端口 Chrome，扫码登录不再关窗口；新增 `GET /browser` + 面板「托管浏览器」状态行（账号 tab data-role 27 个）；账号模块 v2：切换 / 退出 / 添加账户 / cookie 生命周期 / 定时保活（**已按用户要求真机开启**，300s 间隔，观测到 `source=keepalive`）/ verify 5s 冷却；采集 v3 结构特征 + 市场简报/成色建议价（§4.1.4）；**P2.1 IM 接线已落地（1204 测试基线）**）· 代码基线 `main @ f3acef7`（含 P2.1 全部改动；IM 真机验收待做）。**
> 本文是仓库**唯一**的「现在到哪了 / 下一步做什么」入口。其他文档里的测试数字、工具数量、阶段状态一律以本文为准；
> 若发现别处与本文冲突，以本文为真、并把冲突处改成指向本文。规则看 [AGENTS.md](../AGENTS.md)，实现形态看 [architecture.md](architecture.md)。

---

## 1. 一句话

**能登录、能取品、能单件全自动发布（真机真提交 3 次：2 次 CLI 直发 + 1 次队列路径，都是填表 → 选类目 → 地址 → 提交 → 拿到 itemId → 已下架）；队列批量发布（≥2 条）的 dry-run 已真机跑通（2/2 done，含一次 RATE_LIMITED 退避后成功），**批量真提交还没做过**（要用户点头）；账号只有只读摘要；采集参考到「只读统计 + 市场简报/成色建议价」（真机跑通单件解析 + 自己店 3 件 + 他人店铺 3 件整批采集入库；简报链路真机样本走通）；**IM 已接进 daemon（P2.1：wss 长连 + 收消息落库 + 发文本回复，`BF_IM=1` 才开；单测/集成级证据，真机待验收）**；不能自动发货。**
P0 → P1.2 全部完成并提交。**当前按四模块重构**（用户 2026-10-21 拍板：一个插件、模块 tab 在侧边栏面板内切换、一个一个做）：发布 → 账号 → 发布前处理 → 采集参考，见 §4.1。
P2 自动发货押后到发布这条线跑顺再切。

## 2. 能做什么 / 不能做什么

验证等级：**真机** = 对真实闲鱼跑通过；**单测** = 只有测试覆盖、未对真实接口跑过；**方案** = 只有文档。

| 能力 | 状态 | 证据与限制 |
| --- | --- | --- |
| 登录态导入（CLI / `POST /accounts/import` / `xy_import_account`） | ✅ 真机 | 从带 `--remote-debugging-port` 的 Chrome 读 goofish cookie，AES-256-GCM 加密落盘；Cookie 读取按 `Storage.getCookies` → `Network.getAllCookies` 降级 |
| 扫码登录（`npm run daemon:login` / `POST /accounts/login`） | ✅ 真机（拉起/保留已验证；**扫码成功本身仍未见留档**） | 轮询 cookie，`unb` + `_m_h5_tk` 齐备才算成功（默认超时 180s）。2026-10-23 v3：daemon 有**托管浏览器**（`managed-browser.ts`）——端口没人听就拉起一个 headful Chrome（profile `<dataDir>/chrome-profile`，端口 `BF_CHROME_PORT`/9222），**登录结束后不再关它**（会话要靠这个真浏览器续期）；端口上已有 DevTools 就复用、且不接管生命周期。真机证据：`GET /browser` 初始 `running:false` → `POST /accounts/login`（不扫码，8s 超时）→ `GET /browser` 变 `running:true, owned:true`，窗口保留、进程不残留（daemon 退出时才 `stop()`）；日志只出现一次「拉起托管浏览器」，重复点不重复开窗。**真实人工扫码成功仍未留档** |
| 令牌自动刷新 | ✅ 真机 | `_m_h5_tk` 约 2h 过期；`FAIL_SYS_TOKEN_EXOIRED` 时合并响应 Set-Cookie、重签重试**一次**并回写凭据 |
| 取商家 ID + 全量商品 | ✅ 真机 | `user.page.head` + `xyh.item.list` 分页（每页 ≤20）；CDP 抓包与 mtop 直读双验证 |
| `probe` 商品详情落库 | ✅ 真机 | mtop 详情 → `items.upsert` |
| `polish` 擦亮 | ✅ 真机 | mtop 擦亮 2.0 |
| 采集他人商品做参考（R1 只读统计） | ✅ 单测 + 真机（单件） | `channel-mtop/src/reference.ts`（`parseItemReference` / `extractTitleKeywords` / `summarizeReferences`）+ `daemon/src/reference.ts` + `POST /reference` + 工具 `xy_reference_collect` + 面板「采集」分区。只出统计（价格带 / 标题长度 / 类目分布 / 卖点词 / 商家量级），**绝不返回图片直链、不落他人商品图**。真机 2026-10-21：真实凭据目录起 daemon，`POST /reference` 200/241ms，单件「AI工作流咨询」priceCents 10000 / categoryId 50023914 / seller 西安·在售 7 件。限制：卖点词要求出现 ≥2 次，只采 1 件时为空；**多件/商家主页整批、面板点击都未真机**；「自有商品搬家」（R2）未实现、待拍板（§4.3） |
| 市场简报 + 定价建议（`POST /market/brief` / 工具 `xy_market_brief` / `xy_copy_plan` 注入） | ✅ 单测 + 隔离端到端（24 件种子数据）+ 真机采集自己店 3 件 + **他人店铺 3 件（2026-10-23，卖家 2221178314956）** 各出简报 | `core/src/market-brief.ts`：`summarizeMarketBrief(items)`（价格带 p25/p50/p75/min/max、标题长度、标题均段数、描述均句数、带标签占比、行动号召占比、平均图片数、主图构成分布）+ `suggestPriceCents(brief, condition)`（`suggested = p50 × 成色系数`，系数 new 12000 / like-new 10000 / light-wear 8500 / visible-wear 7000 / flawed 5000 万分比，整数分；分位用最近秩不插值；`basis` 给出可复核的算式）。daemon `routes-market.ts` 的 `POST /market/brief`：`{categoryId | sellerId, limit 1..500, condition}`（两者不能同时给）→ 从 `seller_items` 取数（`listItemsByCategory` / `listItems` / `listAllItems`，默认 200 上限 500）→ `{brief, priceSuggestion, sampleSize, keywords}`；空样本 200 + `brief:null`（不是错误）。插件：第 15 个工具 `xy_market_brief`（只读）+ `xy_copy_plan` 新增 `marketCategoryId`/`marketSellerId`（先取简报再注入提示词，失败直接抛不静默降级）+ rpc `market.brief` + 面板「文案」tab 传入。隔离 e2e（2026-10-23）：隔离数据目录 + 24 条 `seller_items` 种子 → 真 HTTP `POST /market/brief` 200（p50 ¥28.00、建议价 `light-wear` ¥23.80、主图 24/24 方图）→ 简报注入 `xy_copy_plan` 提示词（45 行，含「不得照抄原句/原图」）→ 草稿 → CLI dry-run 发布 6.7s（分类「学习笔记」、¥28、包邮、地址回填、未点提交）。真机 2026-10-23（自己店 3 件）：真 mtop `POST /sellers/collect` → 3 件入库（只标题/价格/类目/计数/结构特征）→ `POST /market/brief` 200（p50 ¥100.00、`light-wear` 建议 ¥85.00、主图 portrait 1/mixed 2）→ 提示词注入 → CLI dry-run 5.7s。**红线**：只给统计与建议价，不返回任何他人原文/图片地址 |
| `publish` 单件发布（CDP 步骤机，真提交） | ✅ 真机（4 次） | CLI 直发 3 次：`1093817229436`（2026-10-21 首次）、`1091938715735`（分类修复后，14.5s 拿到 itemId）、`1095534136427`（2026-10-23，CSAPP 旧书 ¥39，用户要求**先不下架**，当前 live）；队列路径 1 次：`1091940243200`（`POST /tasks` → worker → `operations.publish`，落 items 表）。前 3 次已下架留档。**4 次都是单件、都是「学习笔记」类目**。第 4 次暴露一个误判：提交成功后商品页被风控弹层盖住，终态步骤的 post-风控检查把成功翻成 `RISK_CONTROL`（CLI exit 1），已用 `PublishStep.postRiskCheck` 修掉（`packages/channel-cdp/src/steps.ts` + `risk.ts`，`test/risk.test.ts` 覆盖）。真提交需 `--submit` / `BF_PUBLISH_SUBMIT=1`；类目受网页端支持矩阵限制（电子资料/学习笔记/课业本 ✅；教材教辅/语言培训/学习资料定制/文学/考研咨询 ❌）。itemId 是人工试验的产物，仓库代码里没有痕迹 |
| `publish` dry-run（填表不提交） | ✅ 真机 | 发布页 → 传 2 图 → 文案 → 选类目 → 价格/包邮 → 地址 → 必填预检 → 收尾，每步截图。**不带 category/address 时能填表但过不了提交前预检**。两条路径都真机过：CLI `publish`（单件）+ **daemon 队列批量**（2026-10-22，批次 `b-e2e-mvj3aedp`，2 条同批 → 2/2 `done`，第 2 条先 `RATE_LIMITED`（写桶满）退避后成功，两轮各 7 张截图在 `.scratch/e2e3/shots/`） |
| 草稿指定类目 + 不支持即失败 | ✅ 真机 | **网页端分类不是全量类目树**：候选来自 `mtop.taobao.idle.kgraph.property.recommend`（入参标题/描述/图片，一次约 10 个），**不可搜索、不可手输**，文案与图片会重新触发推荐。`channel-cdp/src/category.ts`（+ `category-page.ts`）：按 `aria-controls` 绑定当前下拉、点前 `elementFromPoint` 命中测试、**不对 portal 选项 scrollIntoView**（会滚主页面导致点击落空）、候选在可视区外时只滚下拉内部 `.rc-virtual-list-holder`、连续 2 次回读一致才算选中；目标不在候选里时关下拉等推荐刷新再重开（`REFRESH_WAIT_MS`，受步骤预算约束），仍不在就 fail-closed 并在报错里列出当前候选；命中「网页版暂不支持」立即 `VALIDATION`。真机：上传图片 → 填文案 → 分类从「电子资料」按文案刷新出「学习笔记」并选中（`86ca47e`） |
| 面板内模块 tab（切换） | ✅ 真机（桌面端 GUI 实拍；实时数据改用兼容路由后待重启桌面验证） | 插件只注册 `sidebar.panellist` + `main`；面板内 `PANEL_TABS` 切 6 个分区（2026-10-23 按功能重排为三组：监控=概览（默认）；准备=账号/采集/文案；作业=发布/商品），`PanelBody` 分发；概览是驾驶舱（状态卡 + 待办提醒 + 工作流）＋系统区，不再是占位。新面板入口**只有单测**（未真机重跑）。面板本身不联网、不执行写操作，但 daemon 状态是**真实数据**：`ctx.connection.rpc.call('/bigfish', endpoint)` 每 3 秒轮询 7 个只读端点（多一个是托管浏览器状态 `browser.status`）（`health`/`status`/`accounts`/`settings.get`/`tasks.list`/`batches.get`）、另用 `events.list` 增量拉工作流树（失败单独降级，不拖垮 daemon 状态行），daemon 状态任一失败整块降级成「未连接后台」一行（降级时宿主会**自动拉起 daemon**，见 §5 与 `plugin-ops/src/daemon-supervisor.js`）；账号 tab 是动态表格（7 列：当前/账号/登录状态/登录态剩余/最近检测/凭据更新/操作；进 tab 自动 `accounts.verify`、10 分钟缓存（自动检测真调 mtop head，风控敏感）、行内「检测」强制重打；切换 / 退出登录 / 添加账户（导入+扫码，端口只对导入生效）/ 保活开关全部两次确认，共 27 个 `data-role`（新增托管浏览器状态行 `account-browser`）；保活是**一个开关按钮** + 状态行，间隔 60–3600s）；**发布页写操作本轮接上**：草稿集下方「校验并入队」→ `batch.enqueue`、任务表 `failed`/`needs_review` 行「重试」→ `tasks.retry`、设置摘要改成可保存表单 → `settings.put`（全部两次点击，第二次才带 `confirm:true`），任务表按 3 秒轮询跟随 daemon 推进的状态（`docs/client-plugin-sidebar.md` §1.1）。**宿主 bug 已由插件侧绕过（2026-10-22）**：DSH 0.1.5-rc.2 的 `connection` 插件用自己 ctx 注册 `webServer`（`rpc-host.ts:80`/`:178-181`），外部插件的 `rpc.handle` 必抛 `cannot get property "webServer" without inject`；插件现在「官方通道优先 → 失败自动回退到自建 `webServer` prefix 路由 `/bigfish`」（`plugin-ops/src/host-route.js`，信封/状态码/fail-closed 鉴权 1:1 复刻宿主，ADR 0004）。dev host 真机探针已 200；**桌面端需重启 DSH 才加载新代码，重启后应显示「在线」而非「未连接后台」**（§5 风险表）。面板底部新增「进程管理」区（`data-role=daemon-manage`）：**启动 daemon / 停止 daemon 两个按钮**，并写明「daemon 是常驻后台监听进程——worker 按固定间隔轮询本地队列执行发布/擦亮/探针，面板只是看板，关掉面板 daemon 照旧运行」；`daemon.start` 走 supervisor 的 `force` 拉起（跳过 30s 冷却），`daemon.stop` 是写端点（要求 `confirm:true`，面板第一次点只上膛、第二次点才发），停止后 daemon 收到 `POST /shutdown` 走优雅退出（先停 worker 释放租约再关 HTTP/SQLite）。**不回退到会话顶部 tab**（`conversation.view`：点侧边栏后 main 换成 bigfish，会话与 tab 条一起离开 DOM） |
| 自有商品快照 + 擦亮/探测入口（面板「商品」tab） | ⚠️ 只单测（2026-10-23 新增） | `items.list` 读本地快照（probe 探测或发布成功后落库）+ 勾选后经 `batch.enqueue` 入队 `polish`（擦亮，写）/ `probe`（详情探测，读）；幂等键 `polish:<itemId>:<日期>`（同一天不重复入队，第二天可再擦）。执行器本身此前已真机跑通，**但「面板 → 入队 → 执行」这条路径没真机跑过** |
| 账号列表摘要（`GET /accounts` / `xy_accounts_list`） | ✅ 真机 | daemon 只读摘要：accountId / updatedAt / savedFieldCount / ready（`unb`+`_m_h5_tk` 齐备）/ ageMs / `active`（设置里的当前账号，必填）/ `loginExpiresAt` + `source`（`browser` = 导入时 CDP 给的 `_m_h5_tk` 过期时间；`estimated` = 最近真刷新时间 + 2h；都没有则缺省，面板显示「—」）/ `lastCheckedAt` / `lastOnline` / `lastCode`（最近一次检测结果，落 `<data>/account-state.json`）；单个凭据损坏标 `broken` 不拖垮整表；不带任何 cookie 值。工具只读、不挂门禁。真机：真实数据目录起 daemon（pid 30436），`GET /accounts` 200 = 1 个账号（`ready:true`、savedFieldCount 23、`active`、`loginExpiresAt`/`source`、`lastCheckedAt`/`lastOnline`/`lastCode`）；`xy_accounts_list` 仍只有单测 |
| 登录态校验（`POST /accounts/:id/verify` / rpc `accounts.verify` / 面板「检测」） | ✅ 真机（单账号） | 真调一次 `user.page.head`：成功 → `{accountId, online:true, checkedAt, refreshed}`；`_m_h5_tk` 过期会合并 Set-Cookie 重签重试**一次并回写凭据**，回写成功才置 `refreshed:true`；失败仍 200 + `online:false` + `code`（AUTH_EXPIRED / RISK_CONTROL / RATE_LIMITED / NETWORK / VALIDATION / INTERNAL）+ 固定中文短句；账号不存在 → 400 VALIDATION；缺失登录态 → 200 `VALIDATION`。真机 2026-10-23：隔离副本凭据目录起 daemon，`POST /accounts/2206569289277/verify` → 200 `online:true, refreshed:true`（过期 token 确实被刷新并回写副本），`does-not-exist` → 400。**限制**：不占限流桶/熔断（连点会直接打 `head`，靠 5s 冷却兜）；同账号单飞 + 5s 冷却（命中返回上次结果 + `cached:true`，失败不缓存）；检测来源 `manual`/`keepalive` 记进 `account-state.json` |
| 多账号切换（`POST /accounts/activate` / rpc `accounts.activate`） | ✅ 真机 | 只改本地 `settings.activeAccountId`（不碰闲鱼、免 `confirm`）：空串/空白 → 400 VALIDATION「切换账号请求体 缺少非空字符串字段 accountId」，账号不存在 → 400「账号不存在：<id>」，成功 → 200 `{activeAccountId}`；主导入/登录成功后为空时自动选中。真机：`{accountId:'2206569289277'}` → 200，`GET /settings` 回读到同一值 |
| 退出登录（`POST /accounts/:id/logout` / rpc `accounts.logout`） | ✅ 真机 | **只删本地凭据，绝不注销闲鱼网页会话**；删的是当前账号则清空 `activeAccountId`；账号不存在 → 400；面板两次确认（第一次只改文案 + 提示不注销网页会话）。真机：面板 e2e 里假号退出后表格回到 1 行、`GET /status` 账号列表同步刷新（runtime 的 `/status` 是启动快照，退出后必须重取） |
| 添加账户（`accounts.import` / `accounts.login`，可带端口） | ✅ 真机 | 面板「添加账户」区：账号 id（留空 = 从 Chrome 读 unb）+ Chrome 调试端口（1..65535，默认 9222）→ 导入 / 扫码登录，均两次确认；导入成功后若当前账号为空自动切换过去。真机 e2e：填端口 9333 从 Chrome 导入假号 `8888888888888` → 表格两行、假号显示「1 小时 59 分」剩余、老凭据显示「—」 |
| 账号定时保活（`settings.keepAliveEnabled` / `keepAliveIntervalMs`） | ✅ 真机（已开启） | daemon 侧 `account-keepalive.ts`（`setInterval().unref()`、上轮未完跳过、`stop()` 幂等，picker 优先当前账号否则第一个 ready）+ runtime 包装 settings 变更后 reconcile。**2026-10-23 19:10 按用户要求对真实 daemon 开启**：`keepAliveEnabled:true`、`keepAliveIntervalMs:300000`（5 分钟一档）；临时 60s 观察一轮 → `account-state.json` 的 `source` 由 `manual` 变 `keepalive`、`lastCheckedAt` 前进 ~52s，证明定时器真的在打 `user.page.head`。面板：**一个开关按钮**（「开启保活/关闭保活」，点一次只上膛变「确认开启/确认关闭」）+ 状态行「已开启：每 300 秒校验一次当前账号登录态」+ 间隔输入 60–3600s。限制：进程内定时器、daemon 重启后由 settings 自动恢复；失效没有推送/标红 |
| 批量入队 `xy_publish_batch` + 批次层 | ✅ 工具单测 / 队列批量真机（dry-run） | `plugin-ops/src/batch.js`：逐条校验 + `draftDedupeKey` 幂等 + `mode=dry-run` 默认；按账号逐条预约 `availableAt`（默认 180s，`BF_PUBLISH_MIN_INTERVAL_MS` 可调，失败不占位）；写类工具挂审批门禁（仅 enqueue 需确认）。daemon 侧已有批次层：`EnqueueInput.batchId` / `batchStats` / `GET /batches/:id`（五状态计数 + items）。真机 2026-10-22：HTTP 直接入队 2 条同 `batchId` → 2/2 `done`。**仍缺**：`POST /tasks` 不给 `created` 标志（跨批重复只能显示 queued）、批次真提交未跑、180s pacing 未真机校准 |
| 批量上架调度 | 🟡 链路通，真提交未做 | 批次层（batchId / `GET /batches/:id` 汇总）+ 单账号串行 + 账号级 pacing 已就位；队列批量 dry-run 真机 2/2；**一条命令真机验收已就绪**：`pnpm accept:publish`（`scripts/publish-acceptance.mjs`，自起 dry-run daemon、同批塞一条支持类目 + 一条不支持类目、轮询到终态、落证据 JSON；只能在非沙箱终端跑，沙箱里 CDP 渲染进程起不来）；**批量真提交仍未跑**，面板尚无批次进度消费 |
| `deliver` 自动发货 | ❌ `UNSUPPORTED` | 规则引擎已就绪，缺订单/消息源与执行接线 |
| `reply` / IM 收发 | 🟡 代码+测试（真机待验收） | 四层已接：`channel-im`（帧/状态机；新增 `sendFrame` + `buildSendMessageFrame`）→ `daemon/im-token.ts`（mtop 取 accessToken，风控/失效分类）→ `im-transport.ts`（内置 WebSocket 适配器）→ `im-client.ts`（`/reg` → 1s 后 ackDiff → 15s 心跳；先 ACK 再落库；`sendReply` 组帧）→ `im-runtime.ts`（按账号管理连接）。消息落 `core` 的 `im_messages` 表（`messageId` 唯一键去重）。开关 `BF_IM=1`（默认关）；`operations.sendReply` 未注入网关时仍 `UNSUPPORTED`（任务转 `needs_review`，不假成功）。**未做**：自动发货、多账号并行、图片/语音、重连补拉历史、真机验收 |
| 文案 skill（改写 + 合规审核） | ✅ 2 个 skill | `.agents/skills/xianyu-listing-copy`、`.agents/skills/xianyu-listing-audit`；**已被 DSH 自动发现**（provider 只扫 `.dsh/skills` / `.agents/skills`，2026-10-22 实测），可被 agent 直接调用 |
| 文案风格注入（面板 + `xy_copy_plan`） | ✅ 真机（面板）/ 单测（工具） | 面板内「文案」分区（`PANEL_TABS` 六分区之一）：5 档语言风格（plain/warm/professional/urgent/story）、填商品名/价格/成色，组出 `xy_copy_plan` 参数 JSON；工具把风格约束渲染成提示词。**都只产出请求/提示词，不调模型** |
| 品类模板 + 字段勾选（「打印机」面板） | ✅ 单测（面板 + 模板守卫） | `plugin-ops/src/category-templates.js`：6 个品类（数码/电脑/服饰/家居/图书资料/其他）各带规格字段，通用字段 10 项；rpc `copy.templates` 下发（client 不复刻副本），面板「文案」tab 改为「选品类 → 勾字段 → 填值 → 选风格 → 生成参数」。勾选语义：必填锁定、品类规格默认选中可取消、**未勾选/未填的字段不进提示词**；`reason` / `usedMonths` 已补进 skill `input-schema.json` 与 `xy_copy_plan`（第 2 段的事实来源）。**未真机验证（纯前端 + 纯常量，无写路径）** |
| AI 生图 | 📝 方案 | 选型与管线见 [copywriting-and-imagegen-plan.md](copywriting-and-imagegen-plan.md)，未实现调用 |
| 地址库 / 别名匹配 | ❌ 未做 | CDP 下地址搜索候选不回显，只能匹配「常用地址/附近地址」；匹配不到就失败回显候选 |
| 闲管家开放平台 | 📝 客户端在 | `channel-guanjia`（MIT 移植）无消费者、缺凭证 |
| daemon 异常唤醒会话 | ✅ 单测（host 侧） | 发布任务落到 `failed`/`needs_review` 时，插件 10s 轮询 `/events` 并用 `agent.followup` 往当前会话推一条 notice（任务 id / 批次 / 错误码 / 下一步建议），同一事件不重复推、连续离线只记一条 warn；配置 `enableAlerts: false` 可关。**面板未读角标、真机 failed 场景验证未做** |
| Web GUI 侧边栏面板 | ✅ 真机（隔离 dev host + 真实浏览器） | 侧边栏面板内 6 个 tab（概览 / 账号 / 采集 / 文案 / 发布 / 商品，分监控·准备·作业三组）；概览页（默认）读 daemon 实时状态（3 秒轮询）+ 工作流树（`events.list` 增量）+ 写操作按钮（批量入队 / 任务重试 / 设置保存 / daemon 启停，均两次确认）；账号表进 tab 自动 `verify` |

## 3. 质量基线（可复现）

```
node scripts/test-all.mjs     # 1204 tests / 1204 pass / 67 suites / 112 个测试文件 / ~23s
```

| 范围 | 用例数 | 备注 |
| --- | --- | --- |
| core | 196 | 队列（含 batchId/批次统计/requeue）、仓储、策略、限流熔断、账号级发布间隔、凭据、脱敏、配置、settings 存储、发货规则引擎、**商家行情快照（含结构特征列 v5）**、**IM 消息表 v6（`im_messages`：`messageId` 唯一键去重 / lastPeer / count）** |
| daemon | 376 | HTTP、CLI、执行器、worker、路由、账号导入、账号摘要、**登录态校验（`online` 判定 / 错误分类 / 固定中文文案 / cookie 线索脱敏）**、**账号生命周期（`account-state.ts` 状态文件 / `account-session.ts` 单飞+5s 冷却 / `account-lifecycle.ts` 切换与退出 / `account-keepalive.ts` 定时器与 picker / 导入时写 `meta.expires`）**、参考采集、settings 路由、批次统计、CDP 发布、dry-run 开关、发布侧风控、任务事件流、**IM（token 解析 / ws 适配器 / 客户端握手与重连 / 运行时装配 / `BF_IM` 开关 / 集成：默认关 + 开启后 blocked 不影响 /status）** |
| channel-mtop | 110 | 纯函数（含参考解析、卖点词、**文案结构 / 主图构成特征**） |
| channel-cdp | 108 | 假连接与假页面回放（分类下拉按 AI 推荐刷新/虚拟列表滚动、风控探测） |
| channel-guanjia | 62 | 纯函数 |
| channel-im | 38 | 帧解析 / 归一化 / 状态机 / **发送帧（`sendFrame` + `buildSendMessageFrame`）** |
| plugin-ops | 280 | 插件契约、**工具注册中间件（spec 校验 / read-confirm 分桶 / 按参数判定写 / 统一 ask 门禁）**、草稿校验、批量入队与 pacing、文案风格注入、账号摘要、**账号表 7 列（切换 / 退出 / 添加 / 登录态剩余 / 保活；verify 徽标、10 分钟缓存、5s 冷却 cached）**、参考报告渲染、host rpc 桥（19 端点，含 `accounts.activate` / `accounts.logout`）、**webServer 兼容路由回退**、**daemon 自动拉起（冷却/单飞/回环守卫）+ 面板内启停（停止需二次确认）**、**异常唤醒（事件去重/合并/提示语、游标定基线、无 agent 不轮询、失败不刷屏）**、client bundle（面板内 6 个模块 tab、**工作流树 `events.list` 增量轮询**、**发布页写操作（入队/重试/设置保存，两次确认）+ 任务表 3 秒轮询**、**账号表 7 列 + 切换/退出/添加/保活（27 个 data-role：保活一个开关按钮 + 状态行 + 托管浏览器状态行；自动检测 10 分钟缓存）**） |
| scripts | 31 | daemon 常驻服务（参数/状态机/日志尾）16 + 发布真机验收脚本（参数/草稿/批次判定/PNG 生成）15 |
| integration | 3 | 插件 client ↔ 真 daemon 端到端；**采集链路（解析 → confirm 门禁 → 入库 → 读回）** |
| **合计** | **1204** | ops-bundle 无测试（只声明组合） |

- 类型检查：**6 个 TS 包** tsc 0 错误（core / daemon / channel-mtop / channel-cdp / channel-guanjia / channel-im）。
  **plugin-ops 与 ops-bundle 是纯 ESM JS，无 tsconfig，不在类型检查覆盖内**——改这两个包只能靠测试。
- 运行时零第三方依赖；`TODO/FIXME/HACK` 只剩 1 处（`src/client-bundle/07-daemon.part.js` 的 `TODO(metrics)`：面板只能报当前态、没有 7 日趋势——生成产物 `client.js` 里是同一处，不算新增）。
- 仓库 8 个包、daemon 22 条 HTTP 路由（含 `POST /shutdown`、`GET /events`、`POST /accounts/:id/verify`、`POST /accounts/activate`、`POST /accounts/:id/logout`）、插件 15 个 `xy_*` 工具（由 `src/tool-middleware.js` 统一校验注册并挂审批门禁，`src/gate.js` 已删）、5 个 TaskKind（probe/polish/publish/deliver/reply）、面板内 6 个模块 tab。
- 账号登录态：**能登录、能自动续期、能按需校验、能切换/退出/添加、有 cookie 生命周期展示，保活已真机开启（5 分钟一档），扫码/导入/发布已统一到同一个托管浏览器**；缺的是失效推送、保活降频（现在每档都真打 `head`）、密钥绑 DPAPI/Keychain。

## 4. 下一步

### 4.1 主线：拆成四个模块，一个一个做（用户 2026-10-21 拍板）

**产品结构（2026-10-21 纠正）**：仍然是**一个插件**；插件入口只在侧边栏（`sidebar.panellist` + `main`），**六个模块 tab 在侧边栏面板内部、按功能分三组**（`client-bundle/01-head.part.js` 的 `PANEL_TABS` + `08-panel.part.js` 的 `PanelBody` 分发），不占会话顶部；加模块 = `PANEL_TABS` 追加一项（带 `group`）+ `PanelBody` 补一行分支 + 新片段（模块组件之间互不依赖）。**2026-10-23 重排为**：概览（默认）/ 账号 / 采集 / 文案 / 发布 / 商品。

| 模块 | 模块 tab（面板内） | 现在到哪 | 下一步 |
| --- | --- | --- | --- |
| **发布** | 发布（`PANEL_TABS[4]`）+ 商品（`PANEL_TABS[5]`，自有商品快照/擦亮/探测） | 单件真提交真机 3 次（均已下架）；**队列批量 dry-run 真机 2/2 done**（批次层 + `GET /batches/:id` 已落地）；失败收尾（retry）、发布侧风控识别、账号级 pacing 仍只有单测；**daemon 常驻化已落地**（`pnpm daemon:start/stop/restart/status/logs`）；**真机验收已脚本化**（`pnpm accept:publish`，含同批混不支持类目）；**面板写操作已接**（草稿集「校验并入队」→ 任务表「重试」→ 设置保存，均两次确认；隔离 daemon + 真实浏览器 e2e 通过，见 §4.1.2 验收） | 在普通终端跑一次 `pnpm accept:publish`（dry-run，无需授权，补上「同批混不支持类目」真机证据）→ 用户点头后跑批量真提交（1 条，发完立即下架） |
| **账号** | 「账号」tab | **v2 做完并真机验证**：只读摘要 `GET /accounts`（含 `active` / `loginExpiresAt`+`source` / `lastCheckedAt`+`lastOnline`+`lastCode`）+ 登录态校验 `POST /accounts/:id/verify`（真机 `online:true, refreshed:true`，5s 冷却 `cached:true`）+ 多账号切换 `POST /accounts/activate` + 退出登录 `POST /accounts/:id/logout`（只删本地凭据）+ 添加账户（导入/扫码带端口）+ cookie 生命周期（导入存 `meta.expires`，面板倒计时）+ 保活（`keepAlive*` settings，**2026-10-23 真机开启 5 分钟一档**）；rpc 20 端点；面板账号表 7 列、27 个 data-role、保活一个开关按钮、托管浏览器状态行（扫码/导入/发布共用同一个调试端口 Chrome，扫码后窗口保留）；隔离 daemon + 真实浏览器 e2e 20/20 + 真实 daemon 保活 tick | 多账号并发检测与绑定发布；凭据备份恢复；保活失效推送 |
| **发布前处理** | 「文案」tab（部分） | 文案 skill 2 个（`.agents/skills/`，**已被宿主自动发现**）+ `xy_copy_plan` 风格注入（只产提示词）；**P1 打印机面板已落地**：6 个品类模板 + 字段勾选 + `reason`/`usedMonths` 契约扩展（rpc `copy.templates`，纯前端/纯常量，单测 250 项通过）；core settings 存储已有（`settings.ts`）；面板设置表单已接读写（保存两次确认）；无生图实现、无素材库 | P2 素材库（v4 迁移 `products`/`product_images`/`product_copy_versions` + 只读面板）→ P3 图片与文案入库（门禁）→ P4 草稿导出接 `xy_publish_draft`；生图选型 |
| **采集参考** | 「采集」tab（`PANEL_TABS[2]`，id `research`；含行情简报） | **R1 已落地**：只读统计（价格带/标题长度/类目/卖点词/商家量级）+ `POST /reference` + `xy_reference_collect` + 面板「采集」分区；真机跑通一次单件解析。**市场简报/成色建议价已打通**（`POST /market/brief` + `xy_market_brief` + `xy_copy_plan` 注入，§4.1.4）：隔离端到端 ✅；真机采集自己店 3 件 + 他人店铺 3 件 ✅（2026-10-23） | R2「自有商品搬家」范围待拍板（§4.3）；多件/商家主页整批真机；R3 自摄图片处理 |

### 4.1.1 发布模块（先做，单件已通）

**为什么是它**：单件链路已经真机跑通过一次，缺的不是「能不能发」，而是「一批能不能发得稳、发重了怎么办、发失败了落在哪」——也就是批次层、幂等、可观测。设计见 [auto-publish.md](auto-publish.md)。

**卡点**：①类目矩阵——网页端只支持一小撮类目，且分类候选由 AI 推荐（约 10 个、不可搜索），这是覆盖面天花板；②真提交只成功过 3 次单件（2 次 CLI + 1 次队列），**批量真提交没做过**；③面板通道已落地（`ctx.connection.rpc.handle('/bigfish')`，ADR 0004），面板侧读（6 端点 / 3 秒轮询）与**写**（批量入队 / 任务重试 / 设置保存 / daemon 启停，全部两次确认）都已接；宿主 `webServer` bug 已由插件侧兼容路由绕过，**待重启桌面验证**；④daemon 常驻已补 `scripts/daemon-service.mjs`（未做开机自启），并且**面板打开时宿主会自动拉起 daemon**（rpc 拿到 NETWORK 即拉起，30s 冷却，日志 `<dataDir>/plugin.log`、`daemon.log`）。

| 步骤 | 做什么 | 验收 |
| --- | --- | --- |
| **A1 面板内「自动发布」tab** ✅ | 侧边栏面板默认分区：流水线说明 + 草稿集粘贴 + 发布前校验 + 产出请求 JSON + 发布命令（不联网、不执行） | 桌面端 GUI 实拍 + client-bundle 测试覆盖 |
| **A2 批量入队** ✅ 工具单测 | `xy_publish_batch`：逐条校验 + `dedupeKey` 幂等入队 + 逐条状态（queued / skipped-duplicate / invalid），默认 `mode=dry-run` | 单测全绿 + 写类工具挂审批门禁 |
| **A3 真机小批量** 🟡 dry-run 段完成 | 1 条 dry-run → 1 条真发 → 看队列/截图/itemId；再跑 3 条含一条不支持类目 | 单件 dry-run ✅、单件真发 + itemId + 已下架 ✅（`1091938715735`）、**队列批量 dry-run 2/2 done ✅**（批次 `b-e2e-mvj3aedp`，2026-10-22）；**「同批混一条不支持类目」已脚本化（`pnpm accept:publish`），待普通终端跑一次**；**批量真提交还没跑** |
| B1 pacing ✅ 单测 | 账号级任务间隔：`core/src/limiter.ts` 的 `resolvePublishMinIntervalMs`（默认 180s，夹 30s..3600s）+ 批量按账号预约 `availableAt` | 单测（core/test/pacing.test.ts、plugin-ops/test/pacing.test.mjs）；**180s 未真机校准**；单条 enqueue / 直接 POST /tasks 不受它约束 |
| B2–B4（后续） | 批次汇总/面板进度 → 类目矩阵补测（A3 扫码兜底）→ 10 件连发回归 | 不跨步；每步都先小批真机 |

> **未跑通的不得声称成功**：批量发布目前只真机跑通了 **dry-run**（填表不提交）；批量真提交没做过，不许说「已支持批量发布」。

### 4.1.2 账号模块（第二个做，v2：多账号切换 / 退出登录 / 添加账户 / cookie 生命周期 / 保活）

**① 只读摘要（c01e86e，真机）**：`GET /accounts`（`packages/daemon/src/account-list.ts`）返回 `{ accountId, updatedAt, savedFieldCount, ready, unb?, ageMs, broken?, brokenReason? }`——`unb` + `_m_h5_tk` 齐备才算 `ready`，单个凭据损坏只标 `broken` 不拖垮整表，任何 cookie 值都不出 daemon 进程。**注意 `ready` 只代表本地字段齐备，不代表闲鱼侧在线**（过期 token 也算 ready），在线与否看下面的校验端点。

**② 登录态校验（本轮新增，真机验证）**：`POST /accounts/:id/verify`（`packages/daemon/src/account-verify.ts` + `executors.verifySession`）真调一次 `user.page.head`：`online:true` 即闲鱼侧登录有效；`_m_h5_tk` 过期时走 `callMtop` 的合并 Set-Cookie 重签重试**一次**，经 `onSessionUpdate → credentials.save` 回写成功才置 `refreshed:true`；失败仍返回 200 + `online:false` + 稳定 `code`（AUTH_EXPIRED / RISK_CONTROL / RATE_LIMITED / NETWORK / VALIDATION / INTERNAL）+ 固定中文短句（错误原文里的 cookie 线索被正则剥掉，不落面板）。插件侧：rpc `accounts.verify`（只读、不挂 `confirm`、40s 超时）+ `src/client.js` 的 `verifyAccount()` + 面板「检测」按钮。真机：隔离副本凭据目录起 daemon，`POST /accounts/2206569289277/verify` → 200 `{online:true, refreshed:true}`，`POST /accounts/does-not-exist/verify` → 400 VALIDATION。

**③ 面板账号表格（本轮重做）**：`packages/plugin-ops/client.js` 的 `AccountView` 从静态卡片改成表格——每行 账号 / 状态徽标（在线 · 已过期 · 无法确认 · 检测中 · 未检测）/ 最近检测 / 凭据更新（相对时间 + 字段齐备与否）/ 字段数 / 操作；进 tab 自动 verify（同账号 60s 缓存，手动「检测」强制重打），单个账号失败只落该行不整页降级；导入/扫码走**两次确认**（第一次点只改文案，第二次才带 `confirm:true` 发 `accounts.import` / `accounts.login`，扫码期间显示「等待扫码…（最长 180s）」）。说明文字已按用户要求压掉（原来的三张来源卡与边界说明删除）。

**④ 多账号生命周期（本轮 v2 新增，真机）**：
- 当前账号 = `core/src/settings.ts` 的 `activeAccountId`（空串 = 未选；面板「当前」列 + 「切换」按钮 → rpc `accounts.activate`，免 confirm、只写本地设置）。导入/登录成功后若为空自动选中；退出登录删的正是当前账号则清空。
- 退出登录 `POST /accounts/:id/logout`（rpc `accounts.logout`，写端点、两次确认）：**只删本地加密凭据，绝不注销闲鱼网页会话**；runtime 里退出后必须重新取账号快照（`/status` 的账号列表是启动时快照，不刷新会显示残留）。
- 添加账户：面板「添加账户」区（账号 id 留空 = 从 Chrome 读 unb + 调试端口 1..65535），复用 `accounts.import` / `accounts.login`，导入成功后自动选中。
- 检测状态落盘：`<data>/account-state.json`（`account-state.ts`，`{version:1,accounts}` 原子写 tmp+rename、0600、坏文件返回空表），`GET /accounts` 带出 `lastCheckedAt` / `lastOnline` / `lastCode`。
- 保活：`account-keepalive.ts`（`setInterval().unref()`、上轮未完跳过、`stop()` 幂等、picker 优先当前账号否则第一个 ready）+ runtime 包装 settings store（`keepAliveEnabled` / `keepAliveIntervalMs` 变更后 reconcile）；settings 默认关、间隔 300s（夹 60s..3600s）。**2026-10-23 按用户要求对真实 daemon 开启**（5 分钟一档）：`PUT /settings` 的 body **直接是 patch**（`{keepAliveEnabled:true,keepAliveIntervalMs:60000}`；**不是** `{confirm:true,patch:{…}}` 信封——信封只在插件 rpc 层被拆开，直接发给 daemon 会被当成未知字段静默忽略），临时 60s 观察一轮 → `account-state.json` 的 `source` 从 `manual` 变 `keepalive`、`lastCheckedAt` 前进约 52s，随后间隔回 300000（`settings.json` 落盘）。面板保活改成一个开关按钮（状态行 `keepalive-state` + 间隔输入 60–3600s，与 core 的 60s 下限对齐；原先面板写 600 下限会把默认 300s 判非法、按钮直接禁用）。

**⑤ cookie 生命周期**：导入时把 CDP 给的 cookie `expires`（秒）转毫秒写进凭据 `meta.expires`；`meta.refreshedAt` 只在 verify 真的拿到新 `_m_h5_tk` 并回写成功时更新。面板「登录态剩余」= `refreshedAt + 2h`（标「估算」）或导入时 `_m_h5_tk` 的真实过期时间；两者都没有就显示「—」（老凭据 / 扫码登录路径暂不写 expires）。

**⑥ verify 防抖**：同账号单飞（共享 Promise）+ `VERIFY_COOLDOWN_MS = 5_000` 冷却，命中返回上次结果并带 `cached:true`（失败不缓存）。面板自动检测缓存 10 分钟（每次都是真调 `user.page.head`，账号级风控敏感），行内「检测」强制刷新。

**没做**：①保活只观察了一轮 60s，没有更长的真机运行记录；②多账号进 tab 仍是串行打 mtop，没有并发与限速；③账号绑定发布任务、凭据备份恢复；④扫码登录路径不写 `meta.expires`（要等一次 verify 真刷新才有估算过期时间）；⑤批次进度可视化（`batches.get` 已能读，任务表只显示单条任务）、面板多账号入队（只认当前账号）。

**验收**：全量 1086 全绿 ✅（plugin-ops 257 / daemon 318）；`GET /accounts` 真机 ✅；`POST /accounts/:id/verify` 对**真实凭据目录**的 daemon（pid 4808）真机 ✅：`200 {online:true, refreshed:true}`，`does-not-exist` → `400 VALIDATION`；**面板真机（真实浏览器）** ✅ 2026-10-23 13:0x 用 `scripts/dsh-dev.mjs` 起隔离 DSH（47080，加载当前插件代码）+ headless Chrome 走 CDP：展开侧边栏「BigFish 闲鱼运营」→ 账号 tab 渲染出表格行 `2206569289277 / 在线 / 最近检测 13:02:28 / 1 分钟前 · 字段齐备 / 23 字段 / [检测][重新导入][扫码登录]`，`data-role` 全套命中（截图 `.scratch/panel-account.png`、`.scratch/panel-after-click.png`）。这条路径已固化成一条命令：`pnpm dsh:shot`（6 个 tab 的断言 + 截图 `.scratch/shots/bigfish-sidebar{,-account}.png`，2026-10-23 13:05 实跑 exit 0）。**用户自己的桌面应用仍需重启一次**才能加载同一套代码（当前进程加载的是 12:38 前的旧插件）。

**面板写操作真机 e2e（2026-10-23 下午，隔离环境）**：隔离 daemon（数据目录 `.scratch/e2e-write/state`，凭据为真实账号的副本）+ `scripts/dsh-dev.mjs`（47080）+ headless Chrome 走 CDP 真实点击：①填两条内联草稿 →点两次「校验并入队」→ `已入队 b-mvkiube1-ul2qzh · 2 条`，daemon `GET /tasks` 拿到两条 `publish`（dedupeKey 幂等、batchId 一致）；②任务表出现 `failed` 行 → 点两次「重试」→ `已重试 <taskId>`；③设置表单改「发布间隔 300s / 默认类目 学习笔记」→ 点两次「保存设置」→ `设置已保存`，回读表单为 `300 / 学习笔记`；④轮询验证：从 Node 直接 `POST /tasks` 入队一条，面板任务表**无任何交互**在 3 秒内从 5 行变 6 行（证明任务表跟随 daemon 状态，不是只拉一次）。截图 `.scratch/e2e-write/panel-write.png`。隔离环境的 daemon 未设 `BF_PUBLISH_*`，任务按预期落到「发布通道未开启」的 `failed`——正好给了重试用例。

**账号 v2 真机 e2e（2026-10-23 傍晚）**：隔离 daemon（47001，数据目录 `.scratch/account-v2/state`，真实凭据副本）+ `scripts/dsh-dev.mjs`（47080）+ headless Chrome（9333，注入假 goofish cookie）**20/20 断言全过**：表格出现 / 初始 1 行 / 填端口 / 「从 Chrome 导入」两次点击（第一次只上膛）/ 导入成功「登录态已导入 · 8888888888888」/ 两行 / 假号剩余「1 小时 59 分」（browser 来源）/ 真号老凭据「—」/ 切换后当前标记迁移 / 假号「无法确认 · 后台错误」不影响真号「在线」/ 退出两次确认后回到 1 行 / 切回真号 / 保活保存两次确认 / `settings.json` 落盘 `{keepAliveEnabled:true,keepAliveIntervalMs:900000,activeAccountId:2206569289277}`；截图 `.scratch/account-v2/panel-accounts-2rows.png`。**收回隔离环境后**（`Stop-Process` 32160 / 30556、删除 `.scratch/account-v2` 与 `.scratch/e2e-write`）用**真实数据目录**复验：daemon 重启为 pid 30436，`POST /accounts/2206569289277/verify` → 200 `{online:true,refreshed:false}`，紧接着再调 → 同 `checkedAt` + `cached:true`；`POST /accounts/activate` 空串/不存在均 400 VALIDATION、真实账号 200；`GET /settings` 回读到 `activeAccountId` / `keepAliveEnabled:false` / `keepAliveIntervalMs:300000`。

### 4.1.3 采集参考模块（第三个做，R1 只读统计已落地）

**已落地（5ffda24）**：
- 解析层 `packages/channel-mtop/src/reference.ts`：`parseItemReference`（itemId / title / desc / priceCents / categoryId / properties / imageCount / 浏览·想要·收藏·卖出 / publishedAt / seller / siblingItems；兼容 `{data:{itemDO}}`、`{data:{itemCardDO}}`、扁平三形态，缺 itemId 或 sellerId → VALIDATION）、`extractTitleKeywords`（CJK 整段 + 3 字以上才切 2-gram + 英文数字 ≥2 字符，`STOP_CHARS` 过滤虚词，出现 ≥2 次才进榜）、`summarizeReferences`（价格带 min/median/max/avg、标题长度、平均图片数、有描述占比、类目分布、卖点词）。**只给 imageCount，绝不返回图片 URL**（测试断言 JSON 里不含镜像域名）。
- 采集器 `packages/daemon/src/reference.ts`：`parseReferenceRequest`（accountId、itemIds ≤20 去重、sellerId，后两者至少一个）+ `createReferenceCollector`（给 sellerId 先 `user.page.head` → `xyh.item.list`，再逐件详情；单件失败进 `skipped`，只有 AUTH_EXPIRED / RISK_CONTROL / UNAUTHORIZED 中止整批；带 `onSessionUpdate` 回写刷新后的 cookie）。
- `POST /reference`（daemon 自己从 CredentialStore 取凭据）+ 工具 `xy_reference_collect`（只读、不挂门禁、超时 100s）+ 面板第 6 个分区「采集」（输入形态、产出说明、红线、工具入口）。
- 真机：2026-10-21 `POST /reference` 200 / 241ms（数据见 §2 表）。

**v2「链接 → 商家商品入库」（本轮新增，只有单测 + 检查过类型，没真机跑过）**：
- 链接解析 `packages/channel-mtop/src/link.ts` 的 `parseXianyuLink`：商品链接取 `id`（带 `categoryId`）、商家主页取 `userId`、支持 App 分享文案（正则抠 URL）、短链 `m.tb.cn` → `UNSUPPORTED`、纯数字 → `VALIDATION`（分不清商品/商家）、非 goofish/taobao 域名拒绝。daemon `POST /resolve` 只做这层解析（不联网）。
- 落库：`core/src/store.ts` v4 迁移建 `seller_items` + `sellers`（**不存 desc、不存图片地址**，只留 `image_count`）；仓储 `core/src/seller-items.ts`（upsert / 按商家列表 / 计数 / 商家概览）。
- 采集器 `packages/daemon/src/seller-collect.ts`：`parseSellerCollectRequest`（maxItems 1..60）+ `createSellerCollector`（head → 翻页 ≤3 页 → 逐件详情 → upsert）；`isOwnShop` 用 `sellerId === accountId || unb` 判定（`page.head` 的 `self` 抓包固定 false，不能用），**他人店铺必须 `acknowledgeOther:true`**，否则 `UNAUTHORIZED` 且一个请求都不发。
- 路由 `POST /sellers/collect`、`GET /sellers`、`GET /sellers/:id/items`（`packages/daemon/src/seller-routes.ts`）+ rpc `reference.parseLink` / `seller.collect`（写端点，须 `confirm:true`）/ `sellers.list` / `seller.items` + 面板「采集」tab 重做（贴链接 → 解析 → 选账号/件数/他人店铺确认 → 两次确认采集 → 商品表）。
- daemon `requestTimeout` 从 30s 调到 180s：采集最多 60 件串行，原来的 30s 会先掐断连接（扫码登录同样受益）。
- **端到端已由集成测试覆盖**（2026-10-23 补）：`integration/collect-chain.test.mjs` 走真实 daemon HTTP + 真实 SQLite 文件 + 真实 rpc 桥，只把 mtop 网络换成假 transport，断言「解析 → 无 confirm 被拒且不调接口 → 采集入库 2 件 → `sellers.list`/`seller.items` 读回 → 换连接查库仍是 2 行 → 他人店铺未勾确认 `UNAUTHORIZED` 且零请求」。
- **仍没真机验证**：真实账号 + 真实商家主页的 `/sellers/collect` 一次都没跑过（沙箱不能直连闲鱼，见 AGENTS §5），别声称「已支持采集全店」。

**v3「结构特征」（2026-10-23，用户在「要原图和全文给 LLM 学」被拒后改为只学结构）**：
- 提取层 `packages/channel-mtop/src/features.ts`（新文件，纯函数）：`analyzeCopyStructure(title, desc)` 产出 `SellerItemCopyFeatures`（标题段数/字符数/数字组、描述段落/句数/平均句长/清单行数、有无标签符、emoji 数、行动号召词命中数）；`analyzeImageFeatures(imageInfos)` 产出 `SellerItemImageFeatures`（张数、方/竖/横/混排/未测比例、拿到宽高的张数）。**两者都只返回数字与开关**——不返回标题/描述原文，不返回任何图片地址或文件。
- 落库：`core/src/store.ts` v5 迁移给 `seller_items` 加 `copy_features` / `image_features` 两列（JSON 文本，ALTER 前先探测列，幂等）；类型与窄化在 `core/src/seller-features.ts`（外部输入走 VALIDATION，库里列被改坏走 STORAGE）；采集器逐件 upsert 时带上。
- 统计与展示：`ReferenceSummary` 新增 `imageAspect` 分布与 `copyStructure`（标题均段数 / 描述均句数 / 带标签占比 / 有行动号召占比）；`xy_reference_collect` 文本输出多一行「结构：主图 方/竖/横/混/未测…」；面板采集表新增「结构」列（`方图 · 3 段 · 2 句`，老数据退化显示 —）。
- 为什么是这套：平台图片**不是**写进库的素材，只记「几张、什么比例」；文案只记「多少段/多少句/有没有标签」。LLM 拿到这些能学「怎么写、怎么拍」，但库里没有任何可直接复用的原件——不给搬运留接口。

**没做**：①多件 / 商家主页整批只有单测（真机只跑过 1 件）；②卖点词要求出现 ≥2 次，样本 <2 件时为空（符合预期，不是 bug）；③**R2「自有商品搬家」**（把自己商品从 A 号搬到 B 号 / 多店铺同步）——技术上就是同一条采集+发布链路，但属「跨账号复制」灰区，**必须你拍板**（§4.3）；④R3 自摄图片处理（缩放/水印/白底）、R4 多账号并行（要先解 `assertSameAccount` 的单 Chrome 单账号约束）；⑤**主图内容分类**（白底/场景/手持/文字贴纸）需要看像素，当前不下载图片所以只到「比例 + 张数」；⑥P2 自有素材库（`products` / `product_images`）仍未做——那才是「能让 LLM 看真实图片」的合法来源。

**红线（写进代码注释与测试）**：只做统计参考；不下载他人图片、不照抄文案、不跨账号复制他人商品。

### 4.1.4 「参考采集 → 市场简报 → 文案/定价 → 发布」链路（2026-10-23 打通；自己店 + 他人店铺真机采集 → 简报 → dry-run 已验）

这是用户 2026-10-23 指定的**唯一本轮链路**（自动发货 + 面板押后）。三步走：

1. **看同行**（已有，R1 只读统计）：`xy_reference_collect` / `POST /reference` / 面板「采集」tab 取他人商品的**统计**（价格带、标题长度、类目、卖点词、商家量级、主图构成、文案结构）。落库的是 `seller_items` 的数值特征，**不存他人原文、不下载他人图片**。
2. **形成知识与定价**（本轮新增）：`POST /market/brief` 把 `seller_items` 聚合成市场简报 + 成色修正后的建议价；`xy_market_brief` 直接读，`xy_copy_plan` 传 `marketCategoryId`/`marketSellerId` 时自动把简报注入文案提示词（价格带/建议价/结构/图片规格/高频词 + 一行「只学结构与价格带，不得照抄原句/原图」+ 一条「偏离建议价 >30% 要写 warnings，不许偷偷改价」的硬约束）。
3. **自动发布**（已有）：草稿 → `xy_publish_draft`（默认 dry-run）→ 入队 → daemon CDP 步骤机。同一轮修掉了**标题与描述粘连**的真机 bug（`pressEnter` 不带 `text` 时 Lexical 不插换行；现在 `Input.dispatchKeyEvent` 带 `text: '\r'`，并且 `fillRichText` 回读不到换行就 fail-closed 抛 INTERNAL）。

**本轮一起修的五个问题**（端到端 / 真机跑出来才看见）：
- 卖点词里混进「研数 / 学笔 / 数笔」这类跨词边界的 2-gram（来自「考研数学笔记」「高数笔记」片段内部）。`extractTitleKeywords` 现在只保留出现在**片段首尾**的 2-gram，片段内部的当噪声丢弃；整段片段与英文/数字串不受影响。
- 市场参考段最后一行「定价：…」原本直接粘在【输入契约】前面，现在补一个空行。
- **主图构成真机永远是「未测」**：mtop 详情里的字段是 `imageInfos[*].widthSize/heightSize`（实测主图 512×512），而 `analyzeImageFeatures` 只认 `width/height` → 三件真实商品全 unknown。现在两种字段都认（`readDimension(record.widthSize) ?? readDimension(record.width)`），真机重采后变成 `portrait 1 / mixed 2 / unknown 0`。
- **真提交成功后又被判失败**：2026-10-23 真发 CSAPP 旧书（itemId `1095534136427`）时，提交已跳转到商品页、商品也确实上架了，但页面立刻被滑块/punish 弹层盖住，`withRiskGuards` 的**终态 post 检查**把成功翻成 `RISK_CONTROL`（CLI exit 1、队列会标失败，人工以为没发出去）。现在 `PublishStep.postRiskCheck`（`packages/channel-cdp/src/steps.ts`）允许终态步骤关掉 post 检查：只记一条「提交已完成，页面出现风控弹层（不影响已生成的上架）」，执行前检查照旧（真被风控挡住的发布仍会被拦），`test/risk.test.ts` 有对应用例。
- **类目简报把电子版和实体货混在一起算中位**：笔记类目里 ¥3.88 的 PDF 与 ¥150 的实体笔记同池，p50 被拉到 ¥4.88，建议价看着便宜但根本不是同类货的行情。现在 `priceSpreadNote`（`packages/plugin-ops/src/tool-format.js`）在「最高价 ≥ 最低价 × 3」时额外输出一行「样本价格跨度 N 倍（¥a ~ ¥b），可能混了不同形态/成色的货，建议价只当量级参考，落地前按同款再核一遍」，`xy_market_brief` 与 `xy_copy_plan` 提示词都会带上（`readMarketHints` 同步保留 min/max）。真机类目样本实测 38.7 倍（¥3.88 ~ ¥150.00）。

**验收**（全部本机可复跑）：
- 全量 `node scripts/test-all.mjs`：**1151 tests / 1151 pass / 0 fail / 56 suites / 104 个测试文件**（本轮 1115 → 1151，净增 36 条：市场简报聚合/建议价/`/market/brief` 路由/插件市场工具与提示词注入/主图宽高真机字段/价格跨度提示/截图重试；另外 `channel-cdp/test/richtext.test.ts` 把换行用例改成多行回读断言）；6 包 tsc 全绿（plugin-ops 无 tsconfig，靠单测与 `build-client --check` 兜）；`node scripts/build-client.mjs --check` 1465 行同步；`node scripts/dsh-dump.mjs` 装配正确。
- 隔离端到端脚本（`.scratch/chain/run.sh` + `e2e.mjs`，不进仓库）：隔离数据目录复制真实凭据 → 种 24 条 `seller_items` → 起 daemon 于 47899 → 真 HTTP `POST /market/brief` → 简报注入提示词 → 落草稿 → CLI dry-run 6.7s，截图确认描述四段各自换行（`.scratch/chain/shots/03-text.png`）。
- **真机采集（2026-10-23，自己店）**：隔离 daemon（47901 + 复制凭据）→ 真 mtop `POST /sellers/collect` `{accountId:2206569289277, sellerId:2206569289277, maxItems:10}` → 200，采到 3 件在售（价格 ¥30/¥100/¥150，类目 50023914，标题 7–30 字），全部 upsert 进 `seller_items`（只标题/价格/类目/计数/结构特征，无 desc 列、无图片地址列）→ `GET /sellers`、`GET /sellers/:id/items` 正常 → 真 HTTP `POST /market/brief` 200（p50 ¥100.00、建议价 `light-wear` ¥85.00、标题 3 段/描述 5 句、主图 mixed 2 + portrait 1）→ `.scratch/chain3/e2e-real.mjs` 注入提示词（47 行，含空行后的【输入契约】）→ 草稿 → CLI dry-run **5.7s**（分类「学习笔记」、¥28、包邮、地址回填、未点提交，截图 `.scratch/chain3/shots/`）。
- **真机采集他人店铺（2026-10-23）**：`POST /reference` 先只读解析 3 个公开链接（笔记类目）拿到卖家 2221178314956 → `POST /sellers/collect {sellerId:2221178314956, maxItems:3, acknowledgeOther:true}` → 200（卖家「慕沐学姐」，itemCount 1114，`truncated:true` 符合 maxItems 截断语义），3 件入库（¥3.88/¥4.66/¥4.88，类目 50023914，标题 25–31 字，主图 square 1 + mixed 2，标题 4 段、描述 13 句、带标签/含 CTA 均 100%）→ `POST /market/brief {sellerId}` 200（p50 ¥4.66，`like-new` 建议 ¥4.66）→ 类目简报（6 件 = 自己店 3 + 他人 3）p50 ¥4.88 / min ¥3.88 / max ¥150 → `.scratch/chain4/e2e-other.mjs` 注入提示词（含新加的「价格跨度 38.7 倍」提醒）→ 草稿 → CLI dry-run **4.7s**（截图 `.scratch/chain4/shots2/`）。同轮还修了「截图偶发超时把整条 dry-run 判失败」的抖动：`shot()` 先重试一次，仍失败才抛「截图重试后仍失败（表单已填写，请人工确认页面）」。红线：只落数值特征列（无 desc、无图片地址），不下载图片、不照抄文案。
- **真机真提交（2026-10-23，用户点名「发一本 CSAPP，先不下架」）**：草稿 title「深入理解计算机系统 第3版 华章 Pearson」/ ¥39 / 学习笔记 / 包邮 / 西北工业大学长安校区星天苑，封面用用户给的实物照（1773×2364，735KB）→ CLI `publish --submit` 提交后跳到 `item?id=1095534136427`，但账号紧接着进入滑块验证（mtop 读接口同时返回 `FAIL_SYS_USER_VALIDATE` / RGV587），CLI 因此误判失败（见第 5 个修复）→ 「我发布的」确认**商品 live**：「包邮 深入理解计算机系统 第3版 华章 Pearson ¥39」，封面已上传到 alicdn（`.scratch/live-csapp/card-zoom.png`）。按用户要求**未下架**；再次自动发布前需要人工过滑块 + 冷却。

**没做 / 等拍板**：①建议价系数只有成色一维（无类目/品牌分档，无一档以上成色细修），偏保守；②分位用最近秩不插值，小样本会给库里真实出现过的价格，但可能不是最优点；③`titleLength` 用码点计数，与 channel-mtop 的 `titleChars`（UTF-16）在 emoji 上可能差 1；④高频词只来自标题（库里不存描述原文，这是红线决定的）；⑤真机样本量仍小（自己店 3 件 + 他人店 1 家 3 件），建议价锚点弱；要更稳就得多采几家/多件（每次 ≤60 件、串行，注意账号风控）；⑥`xy_copy_plan` 的市场简报目前靠调用方传 `marketCategoryId`，没有「按草稿类目自动找样本」的默认推断；⑦类目简报仍会把不同形态的货（PDF 电子版 vs 实体笔记）混在一个池子里——现在只在跨度 ≥3 倍时给提醒，没有自动按形态/价格分池（需要先有「形态」字段或价格区间参数）。

### 4.2 下一步：P2 自动发货（P2.1 IM 已接线；P2.2 未做）

**P2.1 已完成（2026-10-26，代码 + 测试；真机待验收）**：`packages/daemon/src/im-{token,transport,client,runtime}.ts` + `core/src/im-messages.ts`（表 v6，`messageId` 唯一键去重）+ `channel-im` 的 `sendFrame` / `buildSendMessageFrame`。接线点：`operations.sendReply` 委托注入的 IM 网关（未注入仍 `UNSUPPORTED`，任务转 `needs_review` 而不是假成功）；`runtime.ts` 装配 `imRuntime`，`refreshAccounts()` 后 `startAll`，`close()` 先停 IM 再停 worker；CLI `BF_IM=1`/`true` 才开（默认关：避免测试/离线/只跑发布时主动连 wss、暴露登录态与风控面）。协议细节见 [im-protocol.md](im-protocol.md) §9。

**P2.1 已知缺口（别当成已完成）**：①重连后不按 `pts` 续传，断线期消息没有补拉（候选接口 `mtop.taobao.idlemessage.pc.user.query`，未验证）；②不做「收包静默判死」——内置 WebSocket 不能设 `ping_interval`，服务端空闲时也不保证回包，半开连接只能等下次发送失败/close 事件再退避重连；③只落文本消息，图片/语音/卡片更新不解析；④单账号无代理（内置 WebSocket 的 per-call dispatcher 被忽略，分账号代理要换 `ws@8` + `https-proxy-agent`）；⑤**真机只验到一半**：2026-10-26 用隔离数据目录（`.scratch/im-live`，复制真实凭据）真跑了一次握手，mtop token 返回 `FAIL_SYS_SESSION_EXPIRED::Session过期`，被正确归类成 `AUTH_EXPIRED` → `blocked`、不重试（错误分类这条算真机验过）；但 cookie 已过期，`ready` + 收消息 + 发回复仍未在真实环境跑过，要用户重新扫码登录后才能复验（见 §5 的 `login` 子命令）；⑥面板与 `xy_*` 工具还没有「回复」入口，reply 任务目前只能经 `POST /tasks` 手工入队。

**P2.2 自动发货的卡点**：①订单源仍无依据——`docs` 里「订单」0 命中，订单列表/确认发货接口未抓包（调研给出候选端点：`mtop.taobao.idle.trade.merchant.sold.get` 已售单分页、`mtop.taobao.idle.logistic.consign.dummy` 无需物流发货、闲管家开放平台 `/api/open/order/ship`，**均未验证**）；②发货幂等与「崩溃中断绝不重发」的状态机未写（调研已给出可照抄的状态机：`pending/message_sending/message_sent/platform_confirming/unknown/failed/success` + `retry_safe`/`lease_until`，**崩溃中断且租约过期必须强制 `unknown` + `retry_safe=0`，绝不自动重发**）。

| 步骤 | 做什么 | 验收 |
| --- | --- | --- |
| **P2.0 半自动** | 规则命中 → 面板展示建议动作与文案 → 人工确认 → 入队 | 手填买家消息能出命中规则与建议文案；确认后队列有任务 |
| **P2.1 IM 接线** | websocket 长连（15s 应用层心跳、逐帧 ACK、token 过期分流）+ 消息落库 + 发送帧 | **代码/测试已绿（1204 tests）**；待真机：真实小号能给买家发一条文本、消息表唯一键去重 |
| **P2.2 自动发货** | 订单源（先 CDP 读「我卖出的」兜底）+ 发卡 + 状态回写 + 幂等 `uniqueCode` | 一个测试订单从付款到发货全自动，重复触发不双发 |

> 不建议跳过 P2.0：**发货是写操作且直接触达买家**，先让人确认一轮，把文案与规则调对再放开。

### 4.3 需要你决定的事

1. **发布主打哪些类目**：目前只有电子资料 / 学习笔记 / 课业本网页端可发。要不要花时间试「期刊杂志 / 生活百科」等旁支（见 4.1 B3），还是就锁定这三类做量？
2. **目标商家形态**：纯个人号，还是要覆盖鱼小铺 / 闲管家（有企业资质）？后者才需要接 `channel-guanjia`。
3. **发货接受「半自动」多久**：先人工确认跑一段，还是必须一步到全自动？（全自动要先逆向订单接口）
4. （已落地）客户端→宿主 rpc 通道（ADR 0004，`/bigfish`，20 端点）；面板写操作全部接成按钮并挂两次确认（`accounts.import` / `accounts.login` / `accounts.activate` 免确认 / `accounts.logout` / `tasks.retry` / `batch.enqueue` / `settings.put` / `daemon.stop`）。
5. **「自有商品搬家」做不做**：要不要支持「把自己 A 号的商品（含图片）发到 B 号」或「多店铺同步同一批货」？这是搬运助手最核心的能力，但踩 AGENTS §1.6「不跨账号复制他人商品」的边——如果只限**你自己名下**的账号之间，可以做成 R2；如果含他人商品，一律不做。
6. **批量真提交用哪个账号**：现有凭据只有 `2206569289277`（你的大号，2026-10-21 已用它真发过 3 次并全部下架）。批量真提交第 1 条要你点头：用大号发 1 条「自动发布测试」并立刻下架，还是等你导入一个测试小号再跑？（AGENTS §5：真人验证优先测试小号）
7. （已拍板，存档）首发主打：**自动发布**——用户 2026-10-21 决定「先做自动发布，其他功能一个一个来」。
8. （已拍板，存档）**一个插件 + 四个模块**，模块 tab 在侧边栏面板内切换，插件入口只在侧边栏——用户 2026-10-21 定。
9. **（需要你动手两件）** ①**重启 DSH 桌面应用**（关掉再开，会话不丢）让面板新插件代码生效（账号 v3：托管浏览器状态行 + 扫码不传端口，`browser.status` rpc；以及 v2 的切换 / 退出 / 添加 / 登录态剩余 / 保活）。daemon **已经由我这轮重启**（pid 32616，`GET /browser` 可用、已拉起一个托管 Chrome 在 9222 等扫码；旧实例 30904 已优雅停掉）。②在**普通终端**（不是 DSH 沙箱）跑一次 `pnpm accept:publish` 补「同批混不支持类目」的真机证据；它自己起 dry-run daemon、跑完即停，**不会真发**。
10. **（仍未答）批量真提交授权**：见第 6 条——等你点头才能动真格。
11. （已按你的要求落地）**账号保活已开启**：daemon 定时器 + 面板一个开关按钮（2026-10-23 19:10 真机开启，间隔 5 分钟；真实 tick 已落到 `account-state.json` 的 `source=keepalive`）。还想请你定两件小事：①要不要把间隔调到 10–30 分钟（每次都是真调 `user.page.head`，账号级风控敏感）②要不要做「失效时面板标红 + 推 notice」。
12. **老凭据 / 扫码登录的登录态剩余显示「—」**：要补齐有两个办法——①再导入一次（写 `meta.expires`）②daemon 启动时对当前账号自动 verify 一次（会真打一次 `head`）。选 ② 我可以做成启动预热，代价是每次开机多一次 mtop 调用。


### 4.4 施工队列（2026-10-23 凌晨讨论产出，按依赖排序）

> 口径：**daemon 不调 LLM、插件不直接调 LLM、会话/agent 是唯一 LLM 主体**（见 §4.5）。T4/T7 属白名单外扩展点，动工前先补 ADR。

| # | 事项 | 做什么（关键点） | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| T1 ✅ | **daemon 步骤事件流（2026-10-23 已落地）** | 新表 `task_events`（taskId / batchId / step / status / at / seq）；worker 执行时把 `channel-cdp/src/steps.ts:36-51` 已有的每步回调落库；新增 `GET /events?since=<seq>&limit=`（增量） | 单测（写入顺序、增量、越界）+ 真机 dry-run 一批后能拉到 step 级事件 | 无 |
| T2 ✅ | **面板工作流树（2026-10-23 已落地）** | 新增 rpc 端点 `events.list`（白名单 `since`/`limit`/`taskId`/`batchId`，`limit≤1000`）+ daemon 客户端 `listEvents`；client 侧 `useWorkflowEvents`（3s 增量、闭包 `since` 游标、缓冲 300 条）→ `groupEventsByTask` 聚合成「任务→步骤」→ `WorkflowTree`（挂在「自动发布」页 daemon 状态块之后，最近 6 任务 × 6 步，`data-role='workflow-tree'/'workflow-task'/'workflow-step'`）；失败只降级工作流区、不影响在线状态行 | client-bundle 4 条（树结构/游标推进/端点缺失降级/空流）+ rpc 2 条（白名单/非法参数）+ client 1 条；全量 887 绿。**桌面目视仍需用户重启 DSH 后看一眼** | T1 |
| T3 ✅ | **daemon 异常唤醒 DSH 并回消息（2026-10-23 已落地，host 侧）** | 不走 `ctx.jobs.start`（常驻轮询会被当成长任务），改 `setTimeout` 链 + `unref()`：`alerts.js`（纯函数：`isAlertEvent` 只认 `task.state` 的 `failed`/`needs_review`、按 id 去重、合并成一条中文摘要、风控/登录态/待复核三类下一步建议、`source.form='notice'` 的 user message）+ `alert-watch.js`（10s 轮询 `/events`，启动时先翻页定基线**不把历史失败当新告警**，无活着的 agent 不 arm 只等 `agent/created`，推送成功才清队列，连续失败只记一条 warn）；`agent.followup()` 用宿主公开扩展点，插件名走 `ctx.get('agents').roots()` 取最新会话；配置 `enableAlerts`（默认开） | 26 条单测（去重/合并/提示语/基线/agent 消失补推/失败不刷屏/stop 后不再 tick）+ 全量 913 绿；**面板未读角标未做**（下一步）；真机验证需 daemon 里真跑出一条 failed | T1 |
| T4 | **面板 AI 按钮（发布前处理）** | 按钮 → 输入 JSON → `ctx.subagents` 跑 `xianyu-listing-copy` skill → agent 调新写工具 `xy_draft_save` 落草稿 → 面板草稿列表 → 人审 → `xy_publish_draft` 校验入队（LLM 输出必须过工具落盘，不从会话文本抠 JSON） | 一次走通「原图+原话 → 草稿 → 人审 → 入队 dry-run」；ADR 0006 写清 subagents 用法与审批门禁（ADR 0005 已被账号管理占用） | 可与 T1 并行 |
| T5 | **只读「相机」（闲鱼浏览器画面）** | daemon `GET /camera?taskId=` → CDP `Page.captureScreenshot`（只在发布任务运行时截，不常开）→ 面板 `<img>` 刷新；第一版**只读**，可交互（转发鼠标）留第二步 | 真机 dry-run 时面板看到发布页画面 | Chrome 调试端口 |
| T6 | **工具层重切** | 一 HTTP 端点一工具 → 一业务动作一工具；读类一次拿全并返回 `nextAction`；合并 `publish_draft` / `publish_batch` / `task_enqueue` 的重叠语义 | 工具数从 14 收敛到 ≤10、每个返回带 `nextAction`、测试与文档同步 | T4 |
| T7 | **browser-skill 评估（bsk_*）** | 评估用它替代 CDP 做「找货源 / 看页面 / 截图回会话」；再评估能否当发布执行器（**登录态不用带调试端口重启 Chrome** 是最大收益） | 一次真机 dry-run 用 bsk_* 走完发布页填表；写 ADR 定 CDP vs bsk 分工 | 需 ADR |
| T8 | **定时任务** | 复用 DSH schedule（cron → `agent.followup`，白名单内）或 daemon `availableAt` + 面板编辑；先做「每天定时擦亮 N 件」 | 面板能建/停定时擦亮，到点真跑一次（dry-run 可） | T3 |

**T1 + T2 + T3 均已落地并测试全绿（1086）**；T4–T8 是下一轮队列。T2/T3 的桌面目视验收需用户重启一次 DSH 桌面应用（面板 host 侧代码在插件启动时加载；重启后异常唤醒也会一并生效）。

> **现场根因已实锤（2026-10-23 01:0x）**：桌面壳 23:24 启动时加载的是当时的旧 host 插件，T2 的 `events.list` 与 T3 的告警 watcher 都还没写（文件 mtime 00:36–00:43）。在渲染进程 DevTools Console 里 `fetch('/bigfish/events.list', …)` 返回 `200 {"ok":false,"error":{"code":"UNSUPPORTED","message":"不支持的 rpc endpoint：events.list"}}`，而同一时刻 5 个老端点全部正常 → 面板 daemon 状态块正确、只有工作流区报错。已在面板里把这种情况和其它失败分开：`UNSUPPORTED` → 「重启 DSH 桌面应用后自动恢复」，`NETWORK` 等 → 「启动 daemon 后恢复」（`client.js` 的 `callRead` 现在带回 `error.code`）。**重启桌面应用是本条的解法，不是 daemon 的问题。**

### 4.5 分层分工（方向性拍板基线，2026-10-22 深夜讨论）

- **daemon**：确定性动作（队列、发布步骤、限流、熔断、凭据）。**绝不调 LLM**（AGENTS §1.1）。
- **插件 host 侧**：不持有 loop、不直接拿 `ctx.llm` 发请求（否则绕过 `tools/pre-execute` 审批、成本记账、会话审计）。只能经三个公开入口：`ctx.agent.followup(msg)`（注入主会话）、`ctx.agents.create`（新会话）、`ctx.subagents`（隔离子 agent，需 ADR）。
- **会话 / agent**：唯一 LLM 主体；日常操作在面板，开放式探索（找货源、论证文案）在会话。
- **面板**：看板 + 一次性可结算动作按钮（启动/停止 daemon、生成草稿、重试任务）；**不做自建 chat UI**。

## 5. 已知风险（别对外宣称）

- **发布真机真提交只成功过 4 次，都是单件、都是「学习笔记」类目**（3 次 CLI 直发 + 1 次队列路径；前 3 次已下架，第 4 次按用户要求留着 live）；**批量只跑过 dry-run**（2026-10-22 队列路径 2/2 done，没点提交）。任何「已稳定支持批量发布」的说法都是假的。
- **失败收尾已补代码、但未真机重放**：`core/src/queue.ts` 的 `requeue`（failed/needs_review → queued，attempts=0、清租约、保留 dedupeKey/payload）+ `POST /tasks/:id/retry` + 工具 `xy_task_retry`（写操作，走审批门禁）。仍是单测级证据；重放会真的再发一次，第一次用必须 `BF_PUBLISH_SUBMIT=1` + 人工盯着 + 发完立刻下架。
- **发布侧风控识别只有单测**：`channel-cdp/src/risk.ts` 每步前/抛错/步后探测 URL、页面文案、验证组件，命中抛 `RISK_CONTROL`（带 `details.step`）→ daemon 熔断 600s。但**没有真机故意触发过**，页面特征清单是 best-effort，改版会失效；截图+人工过的流程仍靠人。
- **daemon 常驻已补脚本、未做开机自启**：`pnpm daemon:start/stop/restart/status/logs`（`scripts/daemon-service.mjs`，detached + pid 文件 + 日志重定向 + `/health` 就绪等待），2026-10-22 全生命周期真机验证通过；**插件宿主侧已能自动拉起**（面板 rpc 拿到 NETWORK → detached spawn 同仓 `cli.ts`，20s 轮询 `/health`，30s 冷却、并发单飞、只认回环地址；真机 e2e 拉起 560ms 就绪、`/health` 200；实现在 `plugin-ops/src/daemon-supervisor.js` + `daemon-watch.js`，17 例单测）；**开机自启/崩溃后由系统级服务拉起仍未做**（需要服务管理器或计划任务，另开一题）。
- **地址搜索在 CDP 下不可用**（候选不回显），只能匹配常用/附近地址。
- **插件层没有类型门禁**：plugin-ops / ops-bundle 是纯 JS（无 tsconfig），改动只能靠 plugin-ops 的 280 个测试兜。
- **面板实时数据**：宿主 bug 仍在（DSH 0.1.5-rc.2 `connection` 插件用自己 ctx 注册 `webServer`，`rpc-host.ts:80`/`:178-181` → 外部插件 `rpc.handle` 必抛 `cannot get property "webServer" without inject`），但插件已自行绕过：官方通道失败即回退到自建 `/bigfish` prefix 路由（信封/状态码/fail-closed 鉴权与宿主一致，ADR 0004）。dev host 上真实 cookie 探针 `/bigfish/health`、`/bigfish/status` 均 200。**桌面端要重启 DSH 才生效**，重启后若仍降级看 server.log 是否出现「webServer 兼容路由」。daemon 没起不再需要手动 `pnpm daemon:start`：面板轮询第一次 NETWORK 时宿主会自动拉起（冷却 30s；日志 `<dataDir>/plugin.log` / `daemon.log`）。写类端点已接：`daemon.start` / `daemon.stop`（进程管理，停止两次确认）、`accounts.import` / `accounts.login` / `accounts.activate` / `accounts.logout`（账号 tab，除切换外都两次确认）、`tasks.retry` / `batch.enqueue` / `settings.put`（发布页）；**批次进度视图、多账号入队、面板未读角标仍未接**。
- **pacing 未真机校准**：默认 180s 是推导值（同账号 15s 连发被真机风控拦过一次），单条 enqueue 与直接 `POST /tasks` 绕过它，只剩 daemon 写桶 1 次/60s 兜底。
- **账号风控**：策略是「遇到 x5sec/滑块不硬刚，停队列 + 截图 + 人工过」；识别代码有了但未真机验证，真人验证只用用户自己的账号，且默认 dry-run（AGENTS §5 账号纪律）。
- **账号在线状态是「按需校验」，不是「持续在线」**：`POST /accounts/:id/verify` 只在打开面板/手点检测（或保活开关打开时按间隔）时打一次，`ready:true` 只说明本地凭据字段齐备（过期 token 也算 ready）。**保活已真机开启**（5 分钟一档，观测到 `source=keepalive` 的真实 tick），但只有一轮 60s 的运行记录；失效没有推送/标红。verify **不占限流桶、不触发熔断**，靠「同账号单飞 + 5s 冷却」兜连点，冷却是进程内状态、重启即失效。
- **账号 v2 的三处已知缺口**：①超 400 行通规的 src 文件已清零（`daemon/src/routes.ts` 2026-10-23 拆成 `routes-*.ts`；`plugin-ops/src/rpc.js` 540 行、`batch.js` 417 行 2026-10-24 拆成 `rpc-schema.js` / `rpc-endpoints.js` / `batch-format.js`）；②扫码登录路径不写 `meta.expires`，登录态剩余只能等一次 verify 真刷新；③`account-state.json` 与 `settings.json` 是两个文件，极端断电时可能不同步（都是本地展示态，不影响发布/凭据）。
- **面板只用隔离 dev host + headless Chrome 验过，用户桌面应用尚未重启**：2026-10-23 13:0x 用 `scripts/dsh-dev.mjs`（47080）+ headless Chrome（CDP，1680×1050）真实渲染了「自动发布」与「账号」两个 tab，daemon 状态行与账号表格都对（截图在 `.scratch/panel-account.png` / `.scratch/panel-after-click.png`）。用户桌面应用（64113）里加载的是 12:38 前的旧插件，重启后才会一致。
- **分类只能选 AI 推荐的那 10 个左右**：候选由图片+文案决定、不可搜索，推荐接口偶发「目标不在候选里」→ fail-closed。批量时若某条文案把类目推荐带偏，那条会失败待审（不拖垮整批），但**覆盖面取决于文案质量**，这是产品级天花板，不是 bug 修补能绕过的。
- **第三方材料删除流程**：`research/repos/` 仍在，删之前必须走 AGENTS §6（列清单 → 标靶点 → 等确认），不要「facts 已吸收」就删。

## 6. 这两周踩过的坑（读代码前先看）

- **风控码被丢掉两次（发布熔断一直不触发的根因）**：`channel-cdp/src/steps.ts` 原来只回 `{ok,step,error}`、`daemon/src/cdp-publish.ts` 又统一包 `INTERNAL`，worker 永远看不到 `RISK_CONTROL`。改通道错误码时要一路传到 worker，别在中间层吞掉 `code`。
- **宿主 rpc 失败信封缺 `details` 会把真实原因整段吞掉（2026-10-23 导入/登录只剩「connection: invalid server-response failure」）**：宿主 client 的 `parseConnectionResponse` 要求 `error.details` 是对象，否则直接抛 TypeError，面板上看到的就只是这句话。`plugin-ops/src/rpc-schema.js` 的 `failEnvelope`/`errorEnvelope` 现在恒带 `details`（无内容时 `{}`），改动 envelope 形状时先看这条。
- Edge 155 移除了 `Network.getAllCookies`，cookie 读取要按 `Storage.getCookies` 降级。
- 发布页描述是 `div[contenteditable=true]`；分类是 antd Select，**`el.click()` 打不开，必须 `Input.dispatchMouseEvent`**；价格是 3 个同 placeholder 输入框取第 1 个。
- **闲鱼发布页「分类」不可搜索、候选只有 ~10 个**（2026-10-22 真机）：候选来自 `mtop.taobao.idle.kgraph.property.recommend`，入参是标题/描述/图片；先把图传完、把文案写进描述区，推荐才会按文案刷新（实测「学习笔记」会在填完「高数笔记…」后出现）。顺序反了就只能拿到图片猜出来的类目（如「女士包」）。
- **antd 下拉的两个坑（2026-10-21/22 真机定位）**：①选项在 body 级 portal，关闭后节点不销毁（只加 `ant-select-dropdown-hidden`），全页扫 `.ant-select-item-option` 会点到旧/别的 Select 的选项；②**对选项 `scrollIntoView` 会滚动主页面**（实测 scrollY 94→29），下拉随之重排，可信点击被当成「点了外面」→ 值没变。取坐标时页面不能滚；判「已打开」只认 `.ant-select-open` + `aria-expanded=true`（本机 appear 动画永远停在 prepare）。③点击后 `selection-item` 更新有延迟（6ms 还是旧值、23ms 才变），回读要等。
- DSH 沙箱造的 workspace junction 是坏的（`realpathSync` 返回链接自身）；重建用 `fs.rmdirSync` + `fs.symlinkSync(...,'junction')`，**删 node_modules 下链接绝不能用 `rm -rf`**（会跟随 junction 删真源码，已发生过一次）。
- **node:test 用例漏关长连接 = 进程被定时器吊住，表现为 `exit 1` + 零输出**：`packages/daemon/test/im-runtime.test.ts` 首版就是这样——断言失败路径没走到 `stop()`，ImClient 的心跳/退避定时器让测试进程不退出，最后被工具超时杀掉，输出缓冲全丢，看起来像「测试文件根本没跑」。修复模式固定为 `it('...', async (t) => { const setup = createSetup(); t.after(() => setup.runtime.stop()) })`（失败路径也必然关连接），定位时先 `node --test --test-name-pattern=...` 单跑。
- **不要用 `read` 读出整文件再 `write` 回去**：2026-10-23 下午 `packages/plugin-ops/client.js`（783 行）这样操作后被截成 609 行，尾部整段丢失、`node --check` 报 `Unexpected end of input`。改文件只用 `edit` / `ops_replace` 或 Node `fs` 读 + 局部替换；真丢了可以从 DSH 会话日志恢复（`~/.dsh/sessions/--D-Github-big~0020fish--/<sessionId>/session.v4.jsonl.zstd` 是多帧拼接 zstd，Node 的 zstd 只解第一帧，得按 `scanZstdFrames` 逐帧解）。
- `scripts/typecheck.mjs` 在本沙箱因 `spawnSync node.exe EPERM` 报错，用 DSH checkout 的 tsc 直接跑（命令见 [handoff.md](handoff.md) §4）。
- Hindsight 本机不可用（daemon 起不来、Python 无网），不要调 `hindsight_*`。

## 7. 文档怎么读

| 层 | 文档 | 什么时候读 |
| --- | --- | --- |
| **必读** | 本文（现状+下一步） · [AGENTS.md](../AGENTS.md)（硬规则） · [architecture.md](architecture.md)（已实现形态 + 发布页真机校准 §13） | 每次开工 |
| 参考 | [module-architecture.md](module-architecture.md)（四模块边界 + 可用度 A/B/C/D 判定） · [auto-publish.md](auto-publish.md)（自动发布施工设计 + 真机验收口径） · [dev-setup.md](dev-setup.md)（怎么跑） · [component-decomposition.md](component-decomposition.md)（包边界） · [im-protocol.md](im-protocol.md) / [delivery-rules.md](delivery-rules.md)（P2 施工规格） · [client-plugin-sidebar.md](client-plugin-sidebar.md) · [p1.3-plan.md](p1.3-plan.md)（方案，执行状态看本文） · [dashboard-plan.md](dashboard-plan.md)（看板/图表方案，待拍板） · [adr/](adr/) · [end-to-end-chain-and-borrowing.md](end-to-end-chain-and-borrowing.md) · [repost-feature-parity.md](repost-feature-parity.md)（搬运助手逆向与功能覆盖/红线） | 做对应模块时 |
| 历史（只作证据，不必读） | [xianyu-ops-agent-design.md](xianyu-ops-agent-design.md) · [xianyu-4q-research.md](xianyu-4q-research.md) · [xianyu-commercial-tools-analysis.md](xianyu-commercial-tools-analysis.md) · [xianyu-wuli-kit-analysis.md](xianyu-wuli-kit-analysis.md) · [asset-extraction.md](asset-extraction.md) · [tool-failure-analysis.md](tool-failure-analysis.md) · [copywriting-and-imagegen-plan.md](copywriting-and-imagegen-plan.md)（选型） | 需要溯源时 |
