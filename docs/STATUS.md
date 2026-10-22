# 项目状态 — 单一事实源

> **最后更新 2026-10-21（四模块改造：发布 / 账号 / 采集 R1 已落地，预处理只有文案部分）· 代码基线 `main @ 5ffda24`。**
> 本文是仓库**唯一**的「现在到哪了 / 下一步做什么」入口。其他文档里的测试数字、工具数量、阶段状态一律以本文为准；
> 若发现别处与本文冲突，以本文为真、并把冲突处改成指向本文。规则看 [AGENTS.md](../AGENTS.md)，实现形态看 [architecture.md](architecture.md)。

---

## 1. 一句话

**能登录、能取品、能单件全自动发布（真机真提交 3 次：2 次 CLI 直发 + 1 次队列路径，都是填表 → 选类目 → 地址 → 提交 → 拿到 itemId → 已下架）；批量发布只有工具、没做真机试验；账号只有只读摘要；采集参考只到「只读统计」（R1，真机跑通一次单件解析）；不能自动发货、IM 未接进 daemon。**
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
| `publish` dry-run（填表不提交） | ✅ 真机 | 发布页 → 传 2 图 → 文案 → 选类目 → 价格/包邮 → 地址 → 必填预检 → 收尾，每步截图。**不带 category/address 时能填表但过不了提交前预检** |
| 草稿指定类目 + 不支持即失败 | ✅ 真机 | `channel-cdp/src/category.ts`（+ `category-page.ts`）：按 `aria-controls` 绑定当前下拉、点前 `elementFromPoint` 命中测试、**不对 portal 选项 scrollIntoView**（会滚主页面导致点击落空）、连续 2 次回读一致才算选中（最多重试 3 次）；命中「网页版暂不支持」立即 `VALIDATION` |
| 面板内模块 tab（切换） | ✅ 真机（桌面端 GUI 实拍） | 插件只注册 `sidebar.panellist` + `main`；面板内 `PANEL_TABS` 切 6 个分区：自动发布（默认）/ 账号 / 文案 / 采集 / 概览 / 诊断，`PanelBody` 分发。纯 UI、不联网、不执行。**不回退到会话顶部 tab**（`conversation.view`：点侧边栏后 main 换成 bigfish，会话与 tab 条一起离开 DOM） |
| 账号列表摘要（`GET /accounts` / `xy_accounts_list`） | ✅ 真机 | daemon 只读摘要：accountId / updatedAt / savedFieldCount / ready（`unb`+`_m_h5_tk` 齐备）/ ageMs；单个凭据损坏标 `broken` 不拖垮整表；不带任何 cookie 值。工具只读、不挂门禁。真机：真实数据目录 `%LOCALAPPDATA%/bigfish` 下起 daemon，`GET /accounts` 200 返回 1 个账号（`ready: true`、savedFieldCount 21）；`xy_accounts_list` 仍只有单测 |
| 批量入队 `xy_publish_batch` | ✅ 单测（未真机批量） | `plugin-ops/src/batch.js`：逐条校验 + `draftDedupeKey` 幂等 + `mode=dry-run` 默认；按账号逐条预约 `availableAt`（默认 180s 间隔，`BF_PUBLISH_MIN_INTERVAL_MS` 可调，失败不占位）；写类工具挂审批门禁（仅 enqueue 需确认）。缺 daemon 批次概念与 `created` 标志；180s 是推导值、未真机验证 |
| 批量上架调度 | ❌ 未做 | 缺「批次 → 串行 pacing → 批次汇总」的批次层；批量只是 N 条独立 publish 任务 |
| `deliver` 自动发货 | ❌ `UNSUPPORTED` | 规则引擎已就绪，缺订单/消息源与执行接线 |
| `reply` / IM 收发 | ❌ `UNSUPPORTED` | `channel-im` 已提交（帧解析/归一化/会话状态机，32 tests），**未接 daemon**；websocket 长连、发送、握手未实现 |
| 文案 skill（改写 + 合规审核） | ✅ 2 个 skill | `.agents/skills/xianyu-listing-copy`、`.agents/skills/xianyu-listing-audit`；**已被 DSH 自动发现**（provider 只扫 `.dsh/skills` / `.agents/skills`，2026-10-22 实测），可被 agent 直接调用 |
| 文案风格注入（面板 + `xy_copy_plan`） | ✅ 真机（面板）/ 单测（工具） | 面板内「文案」分区（`PANEL_TABS` 六分区之一）：5 档语言风格（plain/warm/professional/urgent/story）、填商品名/价格/成色，组出 `xy_copy_plan` 参数 JSON；工具把风格约束渲染成提示词。**都只产出请求/提示词，不调模型** |
| AI 生图 | 📝 方案 | 选型与管线见 [copywriting-and-imagegen-plan.md](copywriting-and-imagegen-plan.md)，未实现调用 |
| 地址库 / 别名匹配 | ❌ 未做 | CDP 下地址搜索候选不回显，只能匹配「常用地址/附近地址」；匹配不到就失败回显候选 |
| 闲管家开放平台 | 📝 客户端在 | `channel-guanjia`（MIT 移植）无消费者、缺凭证 |
| Web GUI 侧边栏面板 | ✅ 只读 | 静态快照 + 手动刷新；按钮 disabled 是刻意的（DSH 无「面板按钮调 host 工具」公开 API） |

## 3. 质量基线（可复现）

```
node scripts/test-all.mjs     # 709 tests / 709 pass / 27 suites / 73 个测试文件 / ~12s
```

| 范围 | 用例数 | 备注 |
| --- | --- | --- |
| core | 144 | 队列（含 requeue）、仓储、策略、限流熔断、账号级发布间隔、凭据、脱敏、配置、发货规则引擎 |
| daemon | 177 | HTTP、CLI、执行器、worker、路由、账号导入、账号摘要、参考采集、CDP 发布、发布侧风控 |
| channel-mtop | 95 | 纯函数（含参考解析与卖点词） |
| channel-cdp | 100 | 假连接与假页面回放（分类下拉 16 例、风控探测） |
| channel-guanjia | 62 | 纯函数 |
| channel-im | 32 | 帧解析 / 归一化 / 状态机 |
| plugin-ops | 97 | 插件契约、门禁、草稿校验、批量入队与 pacing、文案风格注入、账号摘要、参考报告渲染、client bundle（面板内 6 个模块 tab） |
| integration | 2 | 插件 client ↔ 真 daemon 端到端 |
| **合计** | **709** | ops-bundle 无测试（只声明组合） |

- 类型检查：**6 个 TS 包** tsc 0 错误（core / daemon / channel-mtop / channel-cdp / channel-guanjia / channel-im）。
  **plugin-ops 与 ops-bundle 是纯 ESM JS，无 tsconfig，不在类型检查覆盖内**——改这两个包只能靠测试。
- 运行时零第三方依赖；全仓 `TODO/FIXME/HACK` 0 条。
- 仓库 8 个包、daemon 13 条 HTTP 路由、插件 14 个 `xy_*` 工具、5 个 TaskKind（probe/polish/publish/deliver/reply）、面板内 6 个模块 tab。

## 4. 下一步

### 4.1 主线：拆成四个模块，一个一个做（用户 2026-10-21 拍板）

**产品结构（2026-10-21 纠正）**：仍然是**一个插件**；插件入口只在侧边栏（`sidebar.panellist` + `main`），**四个模块是侧边栏面板内部的 tab**（`client.js` 的 `PANEL_TABS` + `PanelBody` 分发），不占会话顶部；加模块 = `PANEL_TABS` 追加一项 + `PanelBody` 补一行分支（模块组件之间互不依赖）。

| 模块 | 模块 tab（面板内） | 现在到哪 | 下一步 |
| --- | --- | --- | --- |
| **发布** | 自动发布（`PANEL_TABS[0]`） | 单件全链路真机跑通（2 次，均已下架）；队列路径 1 次；批量入队 + pacing 工具已有、**未真机批量**；失败收尾（retry）、发布侧风控识别、账号级 pacing 三项硬缺口**代码已补但只有单测**；仍缺批次层与 daemon 常驻 | 补批次层与常驻 → 跑 A3（批量 ≥2 条 + 含不支持类目）；发布三件套各补一次真机 |
| **账号** | 「账号」tab | 只读摘要接口（**已真机** `GET /accounts` 200）+ 第 12 个工具 + 面板内「账号」模块 | 面板内导入/扫码（需 host rpc + ADR）；多账号绑定；凭据备份 |
| **发布前处理** | 「文案」tab（部分） | 文案 skill 2 个 + `xy_copy_plan` 风格注入（只产提示词）；无设置页、无生图实现；**skill 未被宿主发现** | 文案接进 agent 流程；设置页（先走 tab 内自建）；生图选型 |
| **采集参考** | 「采集」tab（`PANEL_TABS[3]`） | **R1 已落地**：只读统计（价格带/标题长度/类目/卖点词/商家量级）+ `POST /reference` + `xy_reference_collect` + 面板「采集」分区；真机跑通一次单件解析 | R2「自有商品搬家」范围待拍板（§4.3）；多件/商家主页整批真机；R3 自摄图片处理 |

### 4.1.1 发布模块（先做，单件已通）

**为什么是它**：单件链路已经真机跑通过一次，缺的不是「能不能发」，而是「一批能不能发得稳、发重了怎么办、发失败了落在哪」——也就是批次层、幂等、可观测。设计见 [auto-publish.md](auto-publish.md)。

**卡点**：①类目矩阵——网页端只支持一小撮类目，这是覆盖面天花板；②真机只成功过 3 次单件（2 次 CLI + 1 次队列），没有批量证据；③面板读 daemon 队列实时状态的通道已调研完（`ctx.connection.rpc.handle('/bigfish')` + client 3s 轮询可行，属灰区，采用前要写 ADR），**未实现**；④daemon 仍无常驻。

| 步骤 | 做什么 | 验收 |
| --- | --- | --- |
| **A1 面板内「自动发布」tab** ✅ | 侧边栏面板默认分区：流水线说明 + 草稿集粘贴 + 发布前校验 + 产出请求 JSON + 发布命令（不联网、不执行） | 桌面端 GUI 实拍 + client-bundle 测试覆盖 |
| **A2 批量入队** ✅ 单测 | `xy_publish_batch`：逐条校验 + `dedupeKey` 幂等入队 + 逐条状态（queued / skipped-duplicate / invalid），默认 `mode=dry-run` | 单测全绿 + 写类工具挂审批门禁；**未做过真机批量** |
| **A3 真机小批量** 🟡 进行中 | 1 条 dry-run → 1 条真发 → 看队列/截图/itemId；再跑 3 条含一条不支持类目 | 单件 dry-run（含类目+地址）✅、单件真发 + 拿到 itemId + 已下架 ✅（`1091938715735`）；**「批量 ≥2 条」与「含不支持类目」还没跑** |
| B1 pacing ✅ 单测 | 账号级任务间隔：`core/src/limiter.ts` 的 `resolvePublishMinIntervalMs`（默认 180s，夹 30s..3600s）+ 批量按账号预约 `availableAt` | 单测（core/test/pacing.test.ts、plugin-ops/test/pacing.test.mjs）；**180s 未真机校准**；单条 enqueue / 直接 POST /tasks 不受它约束 |
| B2–B4（后续） | 批次汇总/面板进度 → 类目矩阵补测（A3 扫码兜底）→ 10 件连发回归 | 不跨步；每步都先小批真机 |

> **未跑通的不得声称成功**：批量发布当前是**未做过**的状态，A3 跑完之前不能说「已支持批量发布」。

### 4.1.2 账号模块（第二个做，只读摘要已通）

**已落地（c01e86e）**：daemon `GET /accounts`（`packages/daemon/src/account-list.ts`）返回只读摘要 `{ accountId, updatedAt, savedFieldCount, ready, unb?, ageMs, broken?, brokenReason? }`——`unb` + `_m_h5_tk` 齐备才算 `ready`，单个凭据损坏只标 `broken` 不拖垮整表，**任何 cookie 值都不出 daemon 进程**；插件第 12 个工具 `xy_accounts_list`（只读、不挂门禁）；面板内「账号」模块 = 登录态来源三张卡 + 两个工具入口 + 三条已知边界，面板不联网、不读 cookie。单测：daemon 12 例（含损坏、load 竞态、ageMs 非负、401/500）+ plugin-ops 1 例。

**没做**：①面板里直接点「导入 / 扫码」——需要 client→host 的 rpc 通道（`ctx.connection.rpc.handle('/bigfish')` + 轮询），属灰区，采用前写 ADR；②多账号切换 / 把账号绑定到发布任务；③凭据备份与恢复（`daemon.token` / 凭据目录的备份脚本）。

**验收**：全量 709 全绿 ✅；真机 `GET /accounts`（daemon + 真实凭据目录）✅ 2026-10-21 实测 ready=true / ageMs 可用；面板内 `xy_accounts_list` 走工具层仍需在 GUI 里点一次（未做）。

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
4. **账号面板要不要自己做导入/扫码按钮**：要就得补一条 client→host 的 rpc 通道（灰区，需 ADR 说明为何绕过「面板按钮不调 host 工具」的现状）；不做的话面板只读、导入继续在对话里让 agent 调工具。
5. **「自有商品搬家」做不做**：要不要支持「把自己 A 号的商品（含图片）发到 B 号」或「多店铺同步同一批货」？这是搬运助手最核心的能力，但踩 AGENTS §1.6「不跨账号复制他人商品」的边——如果只限**你自己名下**的账号之间，可以做成 R2；如果含他人商品，一律不做。
6. （已拍板，存档）首发主打：**自动发布**——用户 2026-10-21 决定「先做自动发布，其他功能一个一个来」。
7. （已拍板，存档）**一个插件 + 四个模块**，模块 tab 在侧边栏面板内切换，插件入口只在侧边栏——用户 2026-10-21 定。


## 5. 已知风险（别对外宣称）

- **发布真机只成功过 3 次，都是单件、都是「学习笔记」类目**（2 次 CLI 直发 + 1 次队列路径）；批量发布没做过任何真机验证。任何「已稳定支持批量发布」的说法都是假的。
- **失败收尾已补代码、但未真机重放**：`core/src/queue.ts` 的 `requeue`（failed/needs_review → queued，attempts=0、清租约、保留 dedupeKey/payload）+ `POST /tasks/:id/retry` + 工具 `xy_task_retry`（写操作，走审批门禁）。仍是单测级证据；重放会真的再发一次，第一次用必须 `BF_PUBLISH_SUBMIT=1` + 人工盯着 + 发完立刻下架。
- **发布侧风控识别只有单测**：`channel-cdp/src/risk.ts` 每步前/抛错/步后探测 URL、页面文案、验证组件，命中抛 `RISK_CONTROL`（带 `details.step`）→ daemon 熔断 600s。但**没有真机故意触发过**，页面特征清单是 best-effort，改版会失效；截图+人工过的流程仍靠人。
- **daemon 无常驻**：`npm run daemon` 前台阻塞，仓库没有服务化/开机自启/日志文件配置；关终端即丢现场。
- **地址搜索在 CDP 下不可用**（候选不回显），只能匹配常用/附近地址。
- **插件层没有类型门禁**：plugin-ops / ops-bundle 是纯 JS，改动只能靠 97 个测试兜。
- **账号面板不联网**：`GET /accounts` 已在真实凭据目录真机验证，但面板还只是静态说明 + 工具入口，没有实时数据、没有导入/扫码按钮（要 rpc 通道 + ADR）。
- **pacing 未真机校准**：默认 180s 是推导值（同账号 15s 连发被真机风控拦过一次），单条 enqueue 与直接 `POST /tasks` 绕过它，只剩 daemon 写桶 1 次/60s 兜底。
- **账号风控**：策略是「遇到 x5sec/滑块不硬刚，停队列 + 截图 + 人工过」；识别代码有了但未真机验证，真人验证只用用户自己的账号，且默认 dry-run（AGENTS §5 账号纪律）。
- **第三方材料删除流程**：`research/repos/` 仍在，删之前必须走 AGENTS §6（列清单 → 标靶点 → 等确认），不要「facts 已吸收」就删。

## 6. 这两周踩过的坑（读代码前先看）

- **风控码被丢掉两次（发布熔断一直不触发的根因）**：`channel-cdp/src/steps.ts` 原来只回 `{ok,step,error}`、`daemon/src/cdp-publish.ts` 又统一包 `INTERNAL`，worker 永远看不到 `RISK_CONTROL`。改通道错误码时要一路传到 worker，别在中间层吞掉 `code`。
- Edge 155 移除了 `Network.getAllCookies`，cookie 读取要按 `Storage.getCookies` 降级。
- 发布页描述是 `div[contenteditable=true]`；分类是 antd Select，**`el.click()` 打不开，必须 `Input.dispatchMouseEvent`**；价格是 3 个同 placeholder 输入框取第 1 个。
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
