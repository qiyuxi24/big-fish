# 端到端链路：参考仓库怎么做的，我们借鉴了什么

> 目的：把「卖家真实工作流」拆成可落地的链路段，逐段说明 ① 参考仓库/商业工具的做法（含硬证据与许可证）② 我们的实现位置 ③ 差异与取舍理由。
> 证据出处：`research/notes/A-cores.md`（82 行）、`research/notes/B-im.md`（104 行）、`research/notes/C-scraping.md`（95 行）、`research/notes/D-delivery.md`（275 行）、`research/notes/E-repost.md`（407 行）、`docs/xianyu-commercial-tools-analysis.md`、`docs/xianyu-wuli-kit-analysis.md`。
> 本文只描述**已实现**与**明确未实现**，不把 dry-run 结果写成发布成功。

## 0. 一句话结论

整条链路由五段组成：**登录态 → 取数/选品 → 文案 → 发布 → 订单/发货/客服**。参考仓库把每段都验证了一遍，但**没有一家解决「官方发布权限」**：开源派走 mtop 逆向（易漂移）与 IM 协议（协议级自动回复），商业派走自建浏览器（结果是把内核冻在某版）或盗用第三方 ERP 会话（违规且随时失效）。我们的做法是**把确定性动作拆成 invarivariant 的通道包 + 一个不做 LLM 决策的 daemon**，发布用 CDP 接管用户真 Chrome（页内填表，签名为页面自身生成），取数用 mtop 读接口，发货/客服等 P2 走 IM。

## 1. 链路全景

| # | 链路段 | 输入 | 输出 | 关键难点 |
| --- | --- | --- | --- | --- |
| 1 | 登录态 | 手机扫码 / 密码 | `_m_h5_tk`、`cookie2`、`unb`、`tfstk`、`x5sec` | 风控与签名 token；tfstk 由阿里 `et_f.js` 在真浏览器算出 |
| 2 | 取数/选品 | 关键字/店铺/商品 ID | 标题、价格、图片 URL、详情 JSON | 快速改版；同类目属性预测 |
| 3 | 文案 | 商品素材 | 标题 ≤30 字、4 段式描述、话题标签 | 平台去重与违禁词 |
| 4 | 发布 | 草稿（图/文/价/地址/分类） | itemId | 类目路由、图片上传、地址 POI、提交后验证 |
| 5 | 订单/发货/客服 | IM 消息、订单态 | 卡密/话术、发货动作、评价 | WS 保活 + 每条 ACK + 幂等防重复发货 |

## 2. 参考仓库盘点

### 2.1 开源：mtop 路线（取数与写接口）

- **XianYuApis（1591★，无 LICENSE）**——把网页版 mtop 逆向到可用程度：
  - 签名 `sign = md5(token + "&" + t + "&" + 34839810 + "&" + data)`（`static/goofish_js_version_2.js:19-26`、`xianyu/mtop.py:158-171`），token = cookie `_m_h5_tk` 按 `_` 切开的前半段；data 用紧凑 JSON。
  - 发布接口 `POST https://h5api.m.goofish.com/h5/mtop.idle.pc.idleitem.publish/1.0/`，body 顶层含 `itemTextDTO / imageInfoDOList / itemPriceDTO / itemPostFeeDTO / itemAddrDTO / itemCatDTO / uniqueCode`（`goofish_apis.py:612-643`）。
  - 图片上传 `https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat`（multipart，字段 `file`）→ 返回 `object.url` 再拼 `imageInfoDOList` 项。
  - 类目属性预测 `mtop.taobao.kgraph.property.recommend`；地址 POI `mtop.taobao.idle.local.poi.get`。
  - **反面教材**：`uniqueCode` 硬编码 `"1775897582791680"`（`goofish_apis.py:639`），地址经纬度硬编码南京（`118.78248347393424,31.91629189813543`）→ 重复发布判重 + 地址永远是别人的。
  - 许可：**无 LICENSE 文件**，README 自称 MIT 不构成授权 → 只能学事实，不能抄代码。
- **xian-guanjia（MIT，thefreelight）**——唯一可直接移植的实现：签名与 20 个开放平台接口（`sign`/客户端约 447 行 python）。这是官方合规通道的基础。
- **XY-Agent（无 LICENSE）**——网页 RPA 思路，另有 mtop 逆向笔记。

### 2.2 开源：IM 路线（发货与客服）

- **XianyuAutoAgent（GPL-3.0）/ xianyu-auto-reply（AGPL-3.0）/ xianyu-super-butler（AGPL-3.0）** 三仓把 IM WS 协议验证到一致：
  - `wss://wss-goofish.dingtalk.com/`，`/reg` 带 `app-key`、IM accessToken、伪造钉钉 UA 串、`dt:j`、`did`；注册后发 `/r/SyncStatus/ackDiff`。
  - **每条下行必须回 ACK** `{"code":200,"headers":{mid,sid,app-key,ua,dt}}`，否则断连（`message_handler.py:573-598`）；应用层 `{"lwp":"/!"}` 每 15s 保活。
  - 发消息 `/r/MessageSend/sendByReceiverScope`：`contentType:101` + `custom.data=base64(JSON)`；文本 `contentType:1`、图片 `contentType:2`。
  - 解码顺序：`syncPushPackage.data[*].data` 先试 base64→JSON 明文，失败再 MessagePack；`message["3"]["redReminder"]` ∈ {等待买家付款, 交易成功/等待卖家发货, 交易关闭} 是发货触发点。
  - 风控事实：**没有一家用打码平台**；Playwright 拖滑块仍判失败（baxia 能识别 CDP 合成的 PointerEvent），判定通过标准是拿到 `x5sec` cookie 且清掉旧 `x5secdata/x5sectag/x5step`。
  - 许可：GPL/AGPL 会传染 → 只借鉴协议事实，不拷代码。

### 2.3 开源：采集路线

- **xianyu_spider / ai-goofish（无 LICENSE）**、**MediaCrawler（禁商用）**：都是「登录态直连读接口」，节奏保守（MediaCrawler `Semaphore(1)` + 每请求 sleep 2s；ai-goofish 每商品 15–30s、翻页 25–50s）。三仓都**没有显式限流代码**——说明节奏必须自己定，这也支撑我们把限流/熔断做进 core。

### 2.4 商业工具三家

| | A 自动发货助手 v4.8.2 | B 一键搬运助手 v2.1.9 | C 雾里 3.20 |
| --- | --- | --- | --- |
| 栈 | 易语言 + VMProtect + EdgeView(WebView2) | 易语言 x86 宿主 + 自建 Chromium 131 x64（ACF 进程外 IPC） | Inno + PyInstaller + PyQt6 |
| 读侧 | 无 | 页内 DOM/资源拦截 | 闲鱼 Cookie 直连采集 |
| 写侧 | 无 | 注入 JS 填表 / 页内 fetch 打 mtop | **阿奇索 SaaS 内部接口**（盗用会话） |
| 订单/发货 | IM 监听 + xlsx 规则表 + sqlite3 | 无 | 阿奇索 `/api/Trade/List` + Excel 标题匹配 |
| 许可证/风险 | EdgeView 是 LGPL-2.1，包内无声明；未签名加壳 | 同左 + 341MB 内核 | MV3 抓 Cookie/Authorization；ToS 违规 |

- A 的可抄数据模型：`发货文件.xlsx` 两列 `匹配标题 | 发货内容`；`多规格发货列表.txt` 分隔符 5 个连字符 `规格ID-----商品ID-----卡密标题:规格-----发货内容`（解决同商品多 SKU 卡密不同）。
- B 做对的两件事：**一账号一 `user_data_dir` 的隔离是一等公民**；**用响应拦截取数而不是 DOM 抓数**（免算签名、抗改版）。
- C 的路线是「借已获授权的第三方 ERP 会话」：能跑通但不是我们的合规选项（数据经手第三方、对方改接口即失效、封号风险）。

## 3. 我们的链路映射

| 链路段 | 参考来源 | 我们落成的模块 | 与参考的差异（为什么） |
| --- | --- | --- | --- |
| 登录态 | XianYuApis 扫码七步；三仓 cookie 事实 | `packages/daemon/src/accounts.ts`（`saveImportedAccount`/`importAccountFromChrome`）+ `packages/channel-cdp/src/cookies.ts`（`Storage.getCookies`，仅方法不存在才降级 `Network.getAllCookies`） | **不自己补 tfstk 环境**：从真浏览器读 cookie（`et_f.js` 自己算）；凭据 AES-256-GCM 加密落盘（core `CredentialStore`），日志一律脱敏 |
| 取数 | XianYuApis 详情/搜索接口；MediaCrawler 节奏 | `packages/channel-mtop`（签名/信封/cookie 归一/ret 分类）+ daemon `probe` 执行器 + `items` 落库 | 签名做成**纯函数无状态**包；probe 只读、走 `read` 桶；不把 UA/设备指纹写死 |
| 文案 | 雾里 `人物设定.txt`（标题≤30 字、4 段式、5 话题标签、纯 JSON） | 未落库（P2 前由 agent 侧生成，daemon 不调 LLM） | 素材工程化模板可进 prompt 库，但生成留在插件/agent 侧 |
| 发布 | XianYuApis 发布 body（学事实）+ A/B 的「真浏览器里干活」 | `packages/channel-cdp/src/publish.ts` 步骤机 + `daemon/src/cdp-publish.ts` 装配 + CLI `daemon:publish` | **确定性步骤机是唯一写路径，LLM 不进热路径**（ADR 0003）；默认 dry-run；`uniqueCode` 每次生成、绝不复用；提交后必须解析到 itemId 或「发布成功」否则按失败，且不自动重试 |
| 订单/发货 | B-im 的 IM 协议；A 的规则表数据模型 | `packages/core/src/delivery.ts`（`matchDeliveryRule`，priority 排序、缺上下文 fail-closed、红线词硬拦 38 条）+ `packages/channel-im`（进行中，未提交） | 规则引擎是**纯函数 + 手写窄化校验**，可脱网单测（21 例）；daemon `deliver/reply` 仍 `UNSUPPORTED`（宁可失败不留假成功） |
| 官方通道 | xian-guanjia（MIT） | `packages/channel-guanjia`（签名 + 20 接口，**不含 placeOrder**） | 合规首选通道，需鱼小铺 + 订购 ERP；作为通道矩阵 A 位 |
| 控制面 | ——（自研） | `plugin-ops` 9 个 `xy_*` 工具 + 审批门禁 + 侧边栏；`daemon` HTTP/队列/worker | daemon 与插件**互不 import**，只靠 HTTP 契约；写类工具挂 `tools/pre-execute` 审批 |

### 3.1 我们的不变量（参考仓库里没有的）

1. **daemon 不调 LLM**：所有模型判断在插件/agent 侧，daemon 只做确定性动作（登录保活、队列、发布、订单、发货、限流）。
2. **写操作幂等**：`dedupeKey` 入队去重 + 发布用自生成 `uniqueCode`（直接对着 XianYuApis 的硬编码反例设计）。
3. **单账号写串行**：worker 同 `payload.accountId` 串行，写桶 QPS ≤ 1，失败不退还预算；熔断状态原子持久化。
4. **凭据只加密落盘**：Windows DPAPI / macOS Keychain；日志脱敏（`cookie`/`_m_h5_tk`/`tfstk`/`x5sec`/`Authorization` 永不打印）。
5. **不复制 GPL/AGPL 代码**：三套 IM 实现只取协议事实；可移植的只有 MIT 的 xian-guanjia。
6. **金额整数分、时间整数毫秒**：mtop 字段本来就是分。

## 4. 实测状态矩阵（2026-10-21）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| mtop 读接口（probe/擦亮） | ✅ 真机通 | `packages/daemon/src/operations.ts`，执行器矩阵 §6 |
| 登录态导入 | ✅ 真机通 | Edge 155 + CDP 9222，测试小号 `unb=2206569289277` 导入 21 字段 |
| CDP 发布填表（dry-run） | ✅ 全绿（约 5.1s） | 截图 `.scratch/pubtest/shots-addr3/`；选择器表见 `docs/architecture.md` §13 |
| CDP 发布真提交 | ❌ 卡住 | 闲鱼按图/文案 AI 识别类目，落到「网页版暂不支持发布此分类，请使用闲鱼APP扫码继续发布」；步骤机按失败处理、不重试、截图 `.scratch/pubtest/shots/07-failed.png` |
| 发货/回消息 | ⛔ `UNSUPPORTED` | P2；`packages/channel-im` 有半成品（未提交） |
| 闲管家官方通道 | 🟡 代码就绪未接装配 | `packages/channel-guanjia` 62 测试 |

## 5. 破局真发布的三个选项

- **A1 换素材**：用实物图/合规文案，让类目识别落到网页支持类目 → 最快验证链路，但只证明「某些类目能发」。
- **A2 加「分类」下拉选择**：步骤机显式选类目再提交 → 通用，但要维护类目枚举与前端交互，且分类是否对网页端开放不可控。
- **A3 走 APP 扫码续发**：页面给的「点击展示二维码」是官方半自动兜底 → 覆盖面最大，但不再是全自动（需人工扫一次）。

推荐顺序 A1（先证链路）→ A2（通用化）→ A3（兜底），且始终用测试小号、验证通过前不声称发布成功。

## 6. 风险与边界

- 平台协议：CDP 与 mtop 都属于非官方自动化，有封号风险；**业务红线**（不搬他人商品、不刷单、不代下单、不倒卖数据）在 `checkListing` 与 `validateDeliveryRules` 里有硬拦。
- 供应链：不引入第三方 SaaS 会话（C 的路线），不集成打码平台，不打包自建浏览器。
- 法律：GPL/AGPL 代码不拷；MediaCrawler 禁商用；xian-guanjia MIT 需保留声明。
