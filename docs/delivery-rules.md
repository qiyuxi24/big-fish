# 自动发货规则引擎（P2 设计依据）

> 状态（2026-10-21）：规则引擎**已就绪**（`packages/core/src/delivery.ts`，21 个单测），但 daemon `deliver` 仍为 `UNSUPPORTED`（`operations.ts:160-166`）；当前状态见 [STATUS.md](STATUS.md)。
> 目标：把「闲鱼自动发货助手 v4.8.2」的逆向结论落成我们自己的规则引擎设计，作为 P2「虚拟商品自动发货」的实现依据。`research/repos/` 里仍是 A/B 两套商业包（651MB，不入 git，2026-10-21 实测；开源仓库与雾里套件已删），删除须按 [AGENTS.md §6](../AGENTS.md) 前置清单：列未完成项 → 标未还原靶点 → 用户确认；事实全部固化在 docs/。
> 上游材料：`research/notes/D-delivery.md`（275 行，带文件偏移的逆向证据）、`docs/xianyu-commercial-tools-analysis.md` §2、`research/notes/B-im.md` §2/§4。
> 标注：✅ 证实（有静态证据/已在仓库落地）｜🟡 推测（合理推断，无直接证据）｜❓ 不可得（原工具全节加密 + 禁运行，需脱壳或抓包）。
> 边界：只写设计与契约，不改代码；数据表为建议，落地以 core 的迁移数组为准。

## 0. 结论速览

原工具真正可抄的只有一个很小的内核：规则外置成两张用户可编辑的表 → 浏览器里监听消息 → 命中后发文本 → 记本地库。它没有签名算法、没有接口逆向，所有"智能"都在表里。我们因此有三条硬立场：

| 决定 | 内容 | 理由 |
| --- | --- | --- |
| 触发源取**订单**不取消息 | 以 `trade.merchant.sold.get` 轮询出的「已付款待发货」订单为准，IM 消息只做加速 | 消息会漏（离线/撤回/未读），订单是平台侧唯一真源；原工具把触发压在 DOM/消息上，正是它脆弱的地方（🟡 反推） |
| 发卡动作归 **daemon 执行器**，走 `kind=deliver` | 复用已有队列/租约/退避/熔断，不新建调度 | `packages/core/src/store.ts` 的 `tasks.kind` 已含 `deliver`，`TaskExecutor` 契约已抽好 |
| **幂等键 = orderId + specId** | 库层唯一约束 + 发送前二次查 + 发送后写回执 | 自动发货最贵的错误是重复发卡密（钱货两失 + 纠纷），比漏发严重得多 |

不做的事：不内嵌浏览器内核（用 CDP 接管真 Chrome）、不加密业务逻辑（可审计）、不把卡密明文落盘、不接第三方卡密供应链的自动代发。

## 1. 原工具的工作流还原（证据分层）

### 1.1 链路（拆成可证与不可证两段）

    [买家付款 / 发消息]
      │  ← ✅ 触发源在 WebView2 里：包内自带 WebView2 runtime 安装器，目录名「登录闪退 (白屏)打开这个」
      ▼
    EdgeView 注入 JS（✅ 能力已证：AddHookScript / CallCDPMethod / GetResponseBodyData）
      ├─ MutationObserver 盯 IM 会话 DOM（🟡）
      └─ 或 CDP Network.responseReceived → 读 mtop 响应体（🟡）
      ▼ window.chrome.webview.postMessage（✅ WebMessageReceived 存在）
    易语言宿主：规则匹配（✅ 规则表在包内，格式已逐字节解析）
      ▼
    页面内发消息（🟡：填输入框点发送，或复页面上下文调 mtop 发送）
      ▼
    data.db 记录（✅ 有 sqlite3.dll + 0 字节 data.db；schema ❓）

证据：`research/notes/D-delivery.md:118-160`（工作流与不可得项）、`:104-116`（EdgeView/HPSocket 职责）。

### 1.2 两个规则文件（✅ 逐字节解析，格式可直接复刻）

| 文件 | 结构 | 语义 | 对多规格的支持 |
| --- | --- | --- | --- |
| `发货文件.xlsx` | 单 sheet，A1:B4，两列：`匹配标题` ｜ `发货内容` | 一列"键"、一列"要发出去的整段文本"，同一列既发卡密也发话术 | 无（只有标题维度） |
| `多规格发货列表.txt` | 123B，GBK+CRLF，5 个连字符分 4 段：`规格ID` ｜ `商品ID` ｜ `卡密标题:规格` ｜ `发货内容` | 同商品不同 SKU 的卡密隔离 | 有，`规格ID + 商品ID` 双键 |

样例（原文）：`2-----1072903926162-----腾讯会员:电脑7天-----AAAAAAAAAAAAAAAA`。第三段冒号后跟的是规格描述（"电脑7天"）而不是卡密本身——这暗示实际匹配更依赖规格文本而不是那个 `2`（🟡 推测，`2` 是什么编号无从证实），直接影响 §2.2 的模型。生成方是 `wijmo.xlsx`(GrapeCity)、被 WPS 12.1 保存：作者把模板当"表格工具"发，用户零学习成本是它唯一的护城河。

### 1.3 记录层：`data.db`

0 字节、无 `SQLite format 3` 头 → 建表在加密后的 exe 里，schema ❓（`research/notes/D-delivery.md:43`、`:188-192`）。🟡 推断四类记录：账号/登录态、卡密池（含已用）、发货记录、配置。我们不复刻它的表，只复刻"记录必须能证明发过"（见 §4）。

## 2. 我们的规则模型

### 2.1 商品/标题匹配：归一化 + bigram Jaccard

原工具是标题包含（或精确相等）匹配（🟡）。我们升级成三级判定，前两级确定性、第三级模糊：

| 级别 | 规则 | 命中后动作 |
| --- | --- | --- |
| L1 | `itemId` 精确相等 | 直接命中，不做文本比较 |
| L2 | 归一化标题精确相等 | 命中 |
| L3 | 归一化后 **bigram Jaccard ≥ 阈值** | 命中，记 `match_score` 供审计 |

归一化管线（顺序固定，便于单测）：全角→半角、大小写折叠、去 emoji/装饰符（`【】〔〕★☆✅` 等）、去空白与常见分隔符、**数字保留**（型号/容量是关键区分符）。

为什么用 bigram Jaccard 而不用子串/编辑距离：① 子串会误配（规则"手机"命中"手机壳""手机支架"，虚拟商品发错卡密即直接损失），只在键 ≥ 4 字符且边界干净时留作补充；② 编辑距离对中文同义改写不敏感（"腾讯视频会员7天"→"腾讯会员·7天卡"位置大改但 bigram 重合度高）；③ Jaccard 有界 0–1，可直接落 `match_score`、阈值可配。

阈值取舍（写进配置，不硬编码）：0.70 召回高但"会员7天"↔"会员30天"也会过线（不推荐）；**0.85** 是中文短标题的平衡点，改价改标点仍命中、跨规格不误中（默认）；0.95 改一个字就漏发（只给高客单价商品）。

模糊匹配必须加两道闸：① 命中多条规则且最高分与次高分差 < 0.05 → 不猜，进 `needs_review`；② 分数 < 阈值但 > 0.6 → 记"疑似未匹配"事件，供卖家补规则/补别名。

### 2.2 规格双键：specId + itemId，文本兜底

多规格是这类工具真正解决痛点的部分。键的优先级：

1. **itemId + specId**（平台订单明细里的 SKU 标识）——唯一可靠，必须优先；
2. **itemId + 规格文本归一化相等**（"电脑7天"）——原工具 txt 里那个 `规格ID` 是 1/2 的小序号，很可能只是本地序号，真实匹配靠文本（🟡），我们要同时收两种输入；
3. 只有 itemId 一条规则且该商品在平台侧只有 1 个规格 → 直接用（防"卖家忘填规格"导致漏发）；
4. 以上都不中 → `needs_review`，**不退款、不猜发**。

导入格式兼容原工具：`规格ID-----商品ID-----卡密标题:规格-----发货内容`（5 连字符、GBK/UTF-8 自动探测、CRLF/LF 均可）。解析失败要断行报错（第几行第几个字段），不能整批丢。

### 2.3 卡密库存模型

两种售卖形态必须都支持，否则卖家会自己拿 Excel 凑（等于没解决）：**一次性卡密**（`quantity = 1`，发完即 `used`，一卡一售）与**多份卡密**（`quantity = N` 或 `NULL`=无限，同一串可反复发，如固定话术/通用激活码）。

抢占用单事务 + 原子 UPDATE：`BEGIN IMMEDIATE` → `UPDATE card_keys SET state='reserved', reserved_order_id=? WHERE id=(SELECT id FROM card_keys WHERE ... AND state='available' ORDER BY id LIMIT 1)` → 检查 `changes()==1`（SQLite ≥3.35 可用 `RETURNING`，但 `changes()` 更保守，node:sqlite 各版本一致）。`node:sqlite` 是同步 API，无并发竞态，但事务边界必须显式（复用 `packages/core/src/store.ts` 的 `withTransaction`）。

### 2.4 幂等与防重发（本文最重要的约束）

- **幂等键**：`deliver:<orderId>:<specId>` 进队列 `dedupeKey`；同订单同规格重复入队只返回既有任务。
- **库层唯一**：`delivery_logs` 上 `UNIQUE(order_id, spec_id)`；插入冲突即视为"可能已处理"，转查状态而非重发。
- **发送前二次查**：执行器拿任务后先查 `delivery_logs.state ∈ ('sending','sent')` → 直接 ack（幂等短路）。
- **发送后写回执**：IM 返回的 `mid` / 时间戳落 `sent_at + msg_ref`，是纠纷时唯一的证据。
- **重试语义**：`sending` 超时（默认 120s）视为未知——不自动重发，先查 IM 最近 N 条是否已含该卡密文本；查到 → 标 `sent`；查不到 → 一次重发；再失败进 `needs_review`。**自动发货允许漏、不允许重。**

### 2.5 失败与人工复核

    pending ──抢到卡密──► sending ──回执──► sent
       │                    ├─ 网络/429 ──► pending（退避重试，≤3 次）
       │                    └─ 超时/风控 ──► needs_review（不自动重试）
       └─ 无规则/无库存/多义匹配 ──► needs_review（人补规则或补卡）

`needs_review` 一律不自动重试（与 `docs/architecture.md` §5 队列语义一致），由插件 `xy_tasks_list` 暴露给模型/用户，人工处理后 `release`。

### 2.6 卡密加密落盘

复用 `packages/core/src/credentials.ts` 的 AES-256-GCM（每目录 32 字节主密钥、权限 0600、`{v,iv,tag,data}` 全 base64）：卡密存 `card_keys.secret_cipher`，不整库加密（要能按 itemId/specId 查询）；固定话术不加密（用户自己写的，要能导出）。脱敏：`redact.ts` 的 `SENSITIVE_KEYS` 增补 `card_key` / `cardKey` / `secret`，日志与 HTTP 响应一律打码。

## 3. 与 IM 通道的衔接

### 3.1 触发源选型

| 触发源 | 延迟 | 可靠性 | 我们的用法 |
| --- | --- | --- | --- |
| `mtop trade.merchant.sold.get` 轮询（`research/notes/B-im.md:47`） | 30–120s | 高（平台侧订单状态） | **主源**：`probe` 执行器每 60s 拉待发货，逐单 `enqueue(deliver)` |
| IM 消息（wss-goofish 下行，`research/notes/B-im.md:22`） | 秒级 | 中（离线/撤回/未读会丢） | **加速器**：收到"已付款"提醒触发一次增量 probe，不直接发卡 |
| 页面 DOM（原工具路线，🟡） | 秒级 | 低（改版即失效） | 只作 diagnosis，不进主链路 |

关键取舍：**看到消息≠该发货**——消息可能来自退款中的订单或只是重复提醒，只有订单 status 才是发卡判据。

### 3.2 发卡动作归谁

| 层 | 职责 | 不做什么 |
| --- | --- | --- |
| `probe` 执行器 | 拉订单 → 过滤"已付款未发货" → 入队 `deliver` | 不匹配规则、不发消息 |
| `deliver` 执行器 | 取任务 → 查规则 → 抢卡密 → 发消息 → 写回执 → ack/fail | 不轮询、不做重试决策（队列管） |
| plugin-ops | 展示待复核、让用户补规则/补卡、审批高危开关 | 不直接发消息 |

发消息原语两条路，按账号配置降级：① **IM 直发**（`lwp: /r/MessageSend/sendByReceiverScope`，`research/notes/B-im.md:27`；需 IM token，且每条下行必须回 ACK 否则断连，`:26`）；② **CDP 页面内发送**（`CdpPage` 注入 + `Runtime.evaluate`，风控最省姿势，原工具即此路）。②只作兜底：页面自动化 5–20s/单且占浏览器实例。确认发货（置订单为已发货）走 `logistic.consign.dummy`（虚拟发货，`research/notes/B-im.md:48`）；有闲管家资质的账号优先走官方通道（`packages/channel-guanjia` 的 `orderCards` / `shipOrder`，见 `docs/component-decomposition.md` §2.2）。

节奏：`probe` 是读（默认桶 30/分钟，够用）。发消息是写：现有 `packages/core/src/limiter.ts` 的 `DEFAULT_BUCKETS` 中 `write = 1/60s` 对发货过严（大促积压），建议新增 `deliver` 桶默认 6/分钟、窗口 60s，失败不退预算（AGENTS 架构不变量 3）。新增桶必须走 ADR，不静默改默认值。

## 4. 数据表建议

统一约束：金额整数分、时间整数毫秒、状态用 `CHECK` 钉死、跨表用 `account_id` 隔离；迁移按 `packages/core/src/store.ts` 的 `MIGRATIONS` 追加（v2 起），一版一事务。

    -- 订单快照：probe 写入；deliver 读它判断该不该发
    CREATE TABLE orders (
      order_id      TEXT PRIMARY KEY,
      account_id    TEXT NOT NULL,
      item_id       TEXT NOT NULL,
      spec_id       TEXT,
      spec_text     TEXT,
      buyer_id      TEXT NOT NULL,        -- 只存 id，不存昵称/头像/聊天记录
      amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
      state         TEXT NOT NULL CHECK (state IN ('paid','delivered','refunding','closed')),
      paid_at       INTEGER NOT NULL,
      delivered_at  INTEGER
    );
    CREATE INDEX idx_orders_pending ON orders(account_id, state, paid_at);

    -- 发货规则：从 xlsx/txt 导入，content_kind 区分话术与"指向卡密池"
    CREATE TABLE delivery_rules (
      id            TEXT PRIMARY KEY,
      account_id    TEXT NOT NULL,
      item_id       TEXT,                 -- 空=仅按标题匹配（xlsx 形态）
      spec_key      TEXT,                 -- itemId+specId 或归一化规格文本
      title_norm    TEXT,                 -- 归一化后的匹配标题
      content_kind  TEXT NOT NULL CHECK (content_kind IN ('text','card')),
      content_text  TEXT,                 -- content_kind='text' 时的整段文本
      priority      INTEGER NOT NULL DEFAULT 0,
      enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uq_rules ON delivery_rules(account_id, item_id, spec_key);

    -- 卡密池：一次性 or 多份；密文列，不存明文
    CREATE TABLE card_keys (
      id                TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL,
      item_id           TEXT NOT NULL,
      spec_key          TEXT,
      quantity          INTEGER,          -- NULL=无限（固定串）
      secret_cipher     TEXT NOT NULL,    -- AES-256-GCM 密文（credentials.ts 同款）
      state             TEXT NOT NULL CHECK (state IN ('available','reserved','used','void')),
      reserved_order_id TEXT,
      created_at        INTEGER NOT NULL,
      used_at           INTEGER
    );
    CREATE INDEX idx_cards_pick ON card_keys(account_id, item_id, spec_key, state);

    -- 发货日志：幂等键落在这里，是审计与纠纷证据
    CREATE TABLE delivery_logs (
      order_id    TEXT NOT NULL,
      spec_id     TEXT NOT NULL,
      account_id  TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      rule_id     TEXT,
      card_key_id TEXT,
      match_score REAL,                   -- 0–1，L3 模糊匹配时才有
      state       TEXT NOT NULL CHECK (state IN ('pending','sending','sent','failed','needs_review')),
      attempts    INTEGER NOT NULL DEFAULT 0,
      msg_ref     TEXT,                   -- IM mid / 页面消息 id，纠纷证据
      error_code  TEXT,                   -- core 的 ErrorCode 之一
      created_at  INTEGER NOT NULL,
      sent_at     INTEGER,
      PRIMARY KEY (order_id, spec_id)
    );

## 5. 风险与红线

1. **合规边界（最重要）**：自动发货是"商家在自己店铺里减少手工操作"，属常规运营；但批量、拟人节奏、默认自动仍可能触碰平台"外挂/自动化"条款。默认策略：单账号、`deliver` 桶限速、每单可在 `delivery_logs` 人工追溯，并给用户"使用风险自担"告知与一键熔断。
2. **绝对不能接入的货源**：盗版课程/软件、共享账号/授权、代充/代下单、他人卡密池、刷量话术。这类订单的"发货内容"本身就是侵权/违约证据，工具不能成为它们的通道——实现上硬拦：规则导入时对已知黑名单关键词（`破解`/`盗版`/`共享账号`/`代充`）给阻断式警告并要求人工确认。
3. **退款与纠纷**：虚拟商品发出即难退回。措施：`sent_at + msg_ref` 留证；`state='refunding'` 的订单立即停发；已发货订单进退款流程时不自动发第二份。
4. **个人信息最小化**：只存 `buyer_id`，不存昵称/头像/聊天全文；`orders` 与 `delivery_logs` 支持按账号物理删除。
5. **供应链风险**：不接第三方"卡密平台自动下单"接口——等于把卖家资金与账号交给外部服务，常伴随洗号/盗刷。

## 6. 落地顺序（P2 拆四步，每步可独立验收）

| 步 | 内容 | 验收 |
| --- | --- | --- |
| D1 | 规则导入（xlsx 两列 + txt 四段）+ 归一化/Jaccard 单测 | 给定样例表，匹配结果与人工判断一致率 ≥ 95%（真实标题集回归） |
| D2 | `orders` / `card_keys` / `delivery_logs` 迁移 + 卡密抢占原子性测试 | 重复入队/中断下无重复发卡（幂等键测试） |
| D3 | `probe` 执行器（订单轮询）+ `deliver` 执行器（假传输） | 端到端用 fake mtop server 跑通全链路，不发真实网络 |
| D4 | IM 直发 + 页面兜底 + 复核面板 | 中断注入（发送前/发送后 kill 进程）不产生重复发卡 |

## 7. 证据索引

| 结论 | 来源 |
| --- | --- |
| 规则是 xlsx 两列（匹配标题→发货内容） | `research/notes/D-delivery.md:18`、`:193-206` |
| 多规格 txt：123B、GBK+CRLF、5 连字符四段 | `research/notes/D-delivery.md:45`、`:207-221` |
| `data.db` 0 字节、schema 不可得 | `research/notes/D-delivery.md:43`、`:188-192` |
| 登录/操作在 WebView2 内（自带 runtime 安装器、白屏病因） | `research/notes/D-delivery.md:120-126` |
| 注入/CDP/读响应体能力（AddHookScript、CallCDPMethod、GetResponseBodyData） | `research/notes/D-delivery.md:104-117` |
| 链路各步"已证实/推测"分层；无 HTTP/WS 组件 → 无本地 HTTP 服务桥 | `research/notes/D-delivery.md:104-160` |
| 订单列表接口 `trade.merchant.sold.get` | `research/notes/B-im.md:47` |
| IM 传输 `wss://wss-goofish.dingtalk.com`（§2 首行）；发消息 `sendByReceiverScope`；每条下行必须回 ACK | `research/notes/B-im.md:22,26-27` |
| 虚拟发货确认 `logistic.consign.dummy` | `research/notes/B-im.md:48` |
| 队列已有 `deliver`、幂等 `dedupeKey`、`needs_review` 不自动重试 | `packages/core/src/store.ts`（`V1_SQL`）、`docs/architecture.md` §5 |
| 执行器契约 `TaskExecutor` / `ExecutorDeps` | `packages/daemon/src/executor.ts` |
| 卡密加密复用 AES-256-GCM + 主密钥 | `packages/core/src/credentials.ts` |
| mtop 只读通道 `callMtop` / `APP_KEY=34839810` / 30s 超时 | `packages/channel-mtop/src/{call,constants}.ts` |
| CDP 读响应体 `CaptureJsonOptions{urlContains, timeoutMs}` | `packages/channel-cdp/src/page.ts` |
| 限流默认桶（write 1/60s、read 30/60s） | `packages/core/src/limiter.ts`（`DEFAULT_BUCKETS`） |
| 闲管家官方通道可查卡密/发货（`orderCards`/`shipOrder`） | `docs/component-decomposition.md` §2.2、`packages/channel-guanjia/README.md:57-60` |
| 商业工具分析与代际对比（不应自建内核） | `docs/xianyu-commercial-tools-analysis.md` §2、§5 |
