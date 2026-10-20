# 闲鱼自动化工具：四问调研（2026-10-20）

> 配套文档：[xianyu-ops-agent-design.md](./xianyu-ops-agent-design.md)（架构设计）
> 证据来源：本机已解压的 11 个仓库 `research/repos/`，笔记 `research/notes/{A-cores,B-im,C-scraping}.md`（全部带 `文件:行号`）。
> 结论只对"技术是否成立"负责；涉及平台协议的部分见 Q4-1，建议不要对外售卖工具。

---

## 0. 四问速览

| 问题 | 一句话结论 |
|---|---|
| Q1 这些开源能做到什么程度 | 抓取：成熟，可 1–2 天做出 demo。发布：**单规格能跑通**，多规格/部分类目是硬缺口；官方开放平台是唯一合规全功能通道，但有资质门槛。 |
| Q2 "封控"是什么 | 不是单一机制，而是**设备指纹 + 行为特征 + 内容/交易特征 + 接口频率**四层打分，对应三级响应：静默限流 → 滑块挑战（x5sec）→ 处罚。可观测的触发点已整理成表（Q2.2）。 |
| Q3 需不需要浏览器插件 | **不需要作为主体**。DSH 插件 + 本地 daemon + CDP 已覆盖；扩展只在"零安装桥/跨域 iframe/浏览器内签名"这类边缘场景有价值，建议 P2 再做且只做只读。 |
| Q4 还有什么坑 | 16 项，按 P0/P1/P2 分级。最致命的三个：多规格 SKU、类目网页端上限、发布幂等（uniqueCode）。合规上是"工具自用/给合作商家用"与"对外售卖"两条完全不同的风险线。 |

三条通道的成熟度（★=可产品化程度）：

| 通道 | 成熟度 | 覆盖 | 账号风险 | 门槛 |
|---|---|---|---|---|
| A 官方闲管家开放平台 | ★★★★ | 全（含多规格 SKU、批量、订单、售后、回调） | 无（合规） | 鱼小铺 + 订购 ERP（专业/铂金版），有发布数量上限 |
| B mtop 直连（逆向签名） | ★★★ | 单规格发布、详情、类目、IM 全通 | 高 | 无 |
| C 网页自动化（CDP 真 Chrome） | ★★☆ | 单规格、**部分类目被"请使用 APP 发布"拦住** | 中低 | 无 |

推荐组合（与设计文档一致）：**读走 B，发布主走 C，有资质走 A**；B 的发布能力默认关闭、灰度开启。

---

## Q1 仓库技术分析：能做到什么，哪些能抄

### 1.1 全部仓库清点（star/许可是 2026-10 实测）

| 仓库 | ★ | License | 形态 | 能力 | 可复用性 |
|---|---|---|---|---|---|
| cv-cat/XianYuApis | 1.6k | **无 LICENSE 文件**（README 自称 MIT） | Python + httpx | sign/tfstk、扫码登录、详情、**发布**、类目、地址、IM | 只能**按事实重写**，代码不可抄 |
| shaxiu/XianyuAutoAgent | 9.4k | GPL-3.0 | Python | LLM 自动客服 | 传染，禁抄 |
| zhinianboke/xianyu-auto-reply | 7.8k | AGPL-3.0 | FastAPI + WS | 自动回复/发货/评价/擦亮，多账号 | 传染，禁抄 |
| 23Star/xianyu-super-butler | 1.3k | AGPL-3.0 | Python + 浏览器 | 自动过滑块、发货、擦亮、45 张表 | 传染，禁抄 |
| xiaolu-ai26/XY-Agent | 27 | **无 LICENSE** | DrissionPage | **网页端自动上架**（含类目/计价/所在地/违禁词/去重） | 事实可参考，代码不可抄 |
| superboyyy/xianyu_spider | 885 | **无 LICENSE** | httpx | 搜索 + 扫码登录 | 同上 |
| thefreelight/xian-guanjia | 30 | **MIT** | Python | 闲管家开放平台客户端，20+ 接口 | **唯一可直接复用代码的仓库** |
| NanmiCoder/MediaCrawler | 67k | NON-COMMERCIAL | Playwright + httpx | 采集架构范式（混合传输、浏览器内签名三范式） | 禁商用，架构可学 |
| fancyboi999/goofish-cli | 331 | **Apache-2.0** | Python CLI + MCP + 5 Skills | 17 命令（发布/下架/图片/类目/地址/IM）+ **内置风控护栏** | 可参考，许可友好 |
| dameng2026/xianyu-pilot-pro | 100 | **Apache-2.0** | TS monorepo（4 app） | 商业版全开源：多规格发布、x5sec 缓存、任务调度、管理台 | 可参考，**信息量最大** |
| avehub/ai-goofish | — | — | Playwright + AI | 搜索结果 AI 筛选监控 | 思路参考 |
| webxiaoyou/xianyucaiji | — | 无 | MV3 扩展 | 详情页 DOM 采集/滚动/导出 | 扩展可行性实证 |
| huwangkeji/Xianyu-Smart-Customer- | 2 | MIT | MV3 扩展 | 自动回复（含跨域 iframe 注入、限流器） | 扩展可行性实证 |

**许可结论**：真正能碰代码的只有 `xian-guanjia`(MIT)、`goofish-cli`/`pilot-pro`(Apache-2.0，注意 NOTICE 与专利条款)。AGPL/GPL 三项（auto-reply、super-butler、AutoAgent）如果做本地自用不构成分发，但一旦交付给商家就触发传染；无 LICENSE 的项目法律上是"保留所有权利"，只能读事实、不能抄代码。

### 1.2 抓取：已经解决

底层只有一件事——**mtop 签名**：

```
sign = md5(_m_h5_tk 里 "_" 之前的半段 + "&" + t + "&" + 34839810 + "&" + dataJson)
t = 毫秒时间戳，dataJson = 紧凑 JSON（无空格）
```

- 证据：`research/repos/XianYuApis/static/goofish_js_version_2.js:19-26`、`goofish_apis.py:741`。Node 用 `crypto` 直接实现，不需要仓库里的 `execjs` 子进程。
- 反面教材：`goofish_apis.py:741` 用 `int(time.time())*1000`，秒级精度导致 `t` 末三位恒 0，是匿名度的损失；`goofish-cli` 的 `mtop.py` 已改为 `int(time.time()*1000)` 并在注释里点名。
- `tfstk` **不是算法**：是阿里 et_f.js 反爬 SDK 在真实浏览器环境算出的 cookie（`utils/gen_tfstk.js:344-386` 用 vm + deep Proxy 补环境）。结论：**从用户已登录浏览器读 cookie** 最稳，别在 Node 里重新实现补环境。
- 请求固定参数：`jsv=2.7.2`、`appKey=34839810`、`v=1.0`、`type=originaljson`、`accountSite=xianyu`、`sessionOption=AutoLoginOnly`；headers 必须带 `Origin`/`Referer=https://www.goofish.com` + Chrome UA。
- 实测接口：搜索 `mtop.taobao.idlemtopsearch.pc.search`、详情 `mtop.taobao.idle.pc.detail`、类目属性 `mtop.taobao.kgraph.property.recommend`(v2.0)、所在地 `mtop.taobao.idle.local.poi.get`、传图 `POST https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat`。
- 登录可纯 HTTP 完成：`mini_login.htm` → `qrcode/generate.do` → `query.do` 轮询 → `login_token/login.do` → 空 sign 打 `idle.web.user.page.nav` 刷新 `_m_h5_tk`。
- 坑：httpx/undici 会按 Domain 丢弃 passport 的 Set-Cookie，必须手工重写到 `.goofish.com`（`xianyu_spider/xianyu/mtop.py:184-211`）。

### 1.3 发布：单规格通了，多规格是分水岭

**B 通道（mtop 直连）** `POST /h5/mtop.idle.pc.idleitem.publish/1.0/`：

- data 顶层：`freebies`、`itemTypeStr:"b"`、`quantity:"1"`、`simpleItem:"true"`、`imageInfoDOList`、`itemTextDTO{title,desc,titleDescSeparate:false}`、`itemLabelExtList`、`itemPriceDTO{priceInCent,origPriceInCent}`、`itemRightsProtocols`、`itemPostFeeDTO`、`itemAddrDTO`、`defaultPrice`、`itemCatDTO`、`uniqueCode`、`sourceId=bizcode=publishScene="pcMainPublish"`。
- 图片先传 `stream-upload.goofish.com`，返回 `object.url`/`pix`，再拼 `imageInfoDOList[{extraInfo:{isH,isT,raw:"false"},isQrCode,url,widthSize,heightSize,major:true,type:0,status:"done"}]`。
- 运费 4 选 1：包邮 / 按距离 `templateId:-100` / 一口价 `postPriceInCent+templateId:0` / 无需邮寄 `templateId:0`。
- **两个必须自己修的坑**：`uniqueCode` 在 `goofish_apis.py:639` 是硬编码常量（会触发商品判重/覆盖）；`can_self_pickup` 写在了 `data.onlyTakeSelf` 而不是 `itemPostFeeDTO` 里（`:684-685`），导致自提设置不生效。
- **多规格**（鱼小铺）走另一套接口：`mtop.idle.pc.backend.idleitem.publish/1.0`（编辑 `.edit`、编辑详情 `.editdetail`），data 是**双层 JSON 序列化**：内部对象 → JSON 字符串 → 包成 `{inputJson:"..."}` → 再序列化 → 最终 data 字符串，签名用最终字符串。证据：`research/repos/pilot-pro/`（`automation-service` 内 publish 模块）。普通账号仍走 `mtop.idle.pc.idleitem.publish`。

**C 通道（网页自动化）** 流程（`XY-Agent/src/services/product_service.py:1724-1826`）：导航到发布页 → `input[type=file]` 传图（失败回退）→ 描述（绝对 XPath 三策略兜底）→ 分类+成色 → 价格+包邮+所在地（搜地名点 auto-item）→ 点 `button[contains(@class,"publish-button")]`，成功判据=10s 内 URL 含 `goofish.com/item` 或页面出现"发布成功"。

**A 通道（官方闲管家）** `POST https://open.goofish.pro/api/open/product/create`：

- 签名 `sign = md5(appKey + "," + md5(bodyString) + "," + timestamp(秒) + "," + appSecret)`，query 带 `appid/timestamp/sign`（商务对接再加 `seller_id`），全部参数**强校验**。
- 关键字段：`item_biz_type`（商品类型）、`sp_biz_type`（行业）、`channel_cat_id`（类目 ID，来自「查询商品类目」）、`channel_pv`（属性，来自「查询商品属性」）、`price` / `original_price` / `express_fee`（**单位：分**）、`stock`（1..399960）、`outer_id`（≤64，一个中文算 2 字符）、`stuff_status`（成色）、`publish_shop` 数组（每项含 `content` 5..5000 字、不支持 HTML、用换行符分行；`province`/`city`/`district` 为数字码；`user_name` 为闲鱼会员名）。
- 文档明确：`item_biz_type`、`sp_biz_type`、`channel_cat_id` **三者有依赖关系**；商品类型=24（特卖）时 `original_price` 必填。
- 配套资源：省市区 xlsx/sql（`file.goofish.pro/doc/闲管家省市区-20261019.xlsx`）、商品异常状态码 xlsx、虚拟货源标准接口。
- 官方文档可被 LLM 直接读：`https://s.apifox.cn/3ac13d69-5a38-4536-ae9b-a54001854ef8/llms.txt`（每个接口一个 `.md`，OpenAPI YAML 片段）。
- 门槛：鱼小铺账号 + 订购"闲管家 ERP 专业版/铂金版"，有发布数量上限，图片必须是**公网可访问 URL**。

### 1.4 IM（客服/消息）：协议已完全摸清，可照搬

- WS：`wss://wss-goofish.dingtalk.com/`，钉钉 lwp 协议：`/reg`（headers: `app-key`+`token`+伪钉钉 UA+`dt=j`+`wv="im:3,au:3,sy:6"`+`sync`+`did`+`mid`）→ `/r/SyncStatus/ackDiff` → **15s 心跳 `lwp:"/!"`** → 每条下行必须回 ACK`{code:200,headers:{mid,sid,app-key,ua,dt}}`，漏回会被踢。
- 发消息：`/r/MessageSend/sendByReceiverScope`，`body[0]` 里 `content.contentType=101`、`custom.data=base64(JSON{contentType:1,text:{text}})`，`body[1].actualReceivers=[toid@goofish, myid@goofish]`。
- 解码：先 base64→JSON；失败再 base64→MessagePack（Node 用 `@msgpack/msgpack`，不用移植三家仓库手写的 decoder）。
- accessToken 只在 `/reg` 用一次，换 token 必须重连重注册；`令牌过期`(FAIL_SYS_TOKEN_EXOIRED) 可恢复，`Session过期` 只能重登；**同账号多端在线互踢**。
- 三家实现（AutoAgent / auto-reply / super-butler）协议完全一致，可交叉验证字段。

### 1.5 结论

抓取侧没有技术悬念；发布侧单规格已可产品化，**多规格 SKU 与部分类目是必须承认的能力边界**。要"100% 替代商家手工"只有 A 通道能做，但它有资质门槛——这决定了产品定位（见 Q4 末尾）。

---

## Q2 "封控"到底是什么，哪些情况会触发

### 2.1 定义

"封控"是商家的口语，对应平台的一整套**风险评分 + 分级处置**，不是单一开关。按层拆：

| 层 | 采什么信号 | 典型处置 |
|---|---|---|
| 身份/设备 | 设备指纹、deviceId 漂移、IP 归属、账号注册时长与活跃度、多账号同 IP | 提高评分；限流；要求重新验证 |
| 行为 | 请求间隔、操作序列是否像人、是否 CDP 注入、页面停留、鼠标/触摸事件密度 | 滑块挑战（x5sec）；`RGV587_ERROR` |
| 内容/交易 | 类目与商品是否匹配、图片是否盗图/带水印二维码、价格偏离、描述长度、是否重复铺货、是否刷单/代下单 | 降权/审核/下架/扣分 |
| 接口频率 | 单接口 QPM、单账号日写次数、媒体上传次数 | `FAIL_SYS_FLOW_LIMIT`、限流 |

**两级"封控"要分清**（`goofish-cli/docs/x5sec-recovery.md`）：
1. **本地熔断**：你自己的客户端判定"危险"而停止（如 goofish-cli 的 `GUARD_TRIPPED`，10 分钟冷却，状态存 `~/.goofish-cli/circuit.json`）。这是保护，不是平台处置。
2. **服务端风控**：平台返回风险码/下发挑战/处罚。只有这一级才需要"恢复"。

### 2.2 触发条件清单（可直接当护栏规则）

| 触发项 | 后果 | 证据/来源 |
|---|---|---|
| 短时间连续发布同款/同质化商品 | 判定"批发/重复铺货"，限流或下架 | `goofish-cli/docs/compliance.md` |
| 单账号日写次数过多（其建议 ≤20/日） | 进入人工审核或直接限流 | 同上；`GOOFISH_WRITE_RPM` 默认 1 次/分钟 |
| 媒体上传过于频繁（默认 9 次/分钟） | 媒体域限流，图片挂掉但请求成功 | `GOOFISH_MEDIA_WRITE_RPM` |
| 类目错放 | 轻：曝光 -30%（降权）；重：下架 | `goofish-cli/docs/risk-guard` |
| 价格偏离市场 >70% | 进人工审核 | 同上 |
| 降价同时改标题 = 虚假促销 | 流量 -50%~70%，严重时下架 24h | 同上 |
| 首图非 1:1 / >9 张 / 盗图 / 水印 / 二维码 | 降权或审核不通过 | 同上 |
| 描述 <30 字 | 权重低，流量差 | 同上 |
| 复活已违规下架的商品 | 二次下架 + 账号标记 | 同上 |
| 代下单 / 刷单（`order/place`） | 红线，直接处罚 | `xian-guanjia` 接口注释 |
| 纯 HTTP 高频请求、无页面浏览、固定节奏 | `RGV587_ERROR` / `FAIL_SYS_USER_VALIDATE` | `goofish-cli/mtop.py` 风险关键字表 |
| 用 CDP/Playwright 驱动滑块 | 行为特征被识别，`code=300` 拒绝 | `super-butler/utils/manual_captcha.py:1-13`；`auto-reply/real_mouse_slider.py:1-19`、`win_input.py:1-15`（baxia 用 `PointerEvent.getCoalescedEvents()` 每帧子事件数识别 CDP 注入；改用 Win32 `SendInput` 驱动**物理光标**才能过，代价是占用鼠标 2–3s、需前台窗口、仅 Windows） |
| 对"cookie 有效、WS 正常"的账号主动去解滑块 | **反而触发 Baxia 风控** | `pilot-pro` 注释原文 |
| 拿到 x5sec 后仍保留旧挑战 cookie | token 刷新永远 `FAIL_SYS_USER_VALIDATE` | `super-butler/XianyuAutoAsync.py:2636-2690`、`xianyu_utils.py:72-92` |

### 2.3 滑块/x5sec 的真实机制

- 判定是否"风险"的挑战 URL 来自 `mtop.taobao.idlemessage.pc.login.token` 的 `data.url`（形如 `...punish?x5secdata=...&x5step=2&action=captcha`），有效期约 1 小时，导航过去才弹滑块。
- `x5secdata/x5sectag/x5step` 是**挑战标记**；`x5sec` 才是**通行证**。拿到 `x5sec` 后必须删掉旧的挑战 cookie，否则后续 token 刷新一直失败。
- 正确恢复姿势（比"自动过滑块"可靠得多）：用真实浏览器登录 → 正常浏览 3–5 分钟让 `x5sec`/`mtop_partitioned_detect` 自然下发 → 从浏览器导出 cookie 给 daemon；仍失败则停写 2–6 小时。
- pilot-pro 的做法值得抄：`x5sec` 按 `unb` 缓存 24h（Redis key `x5sec:{unb}`），每 20h 主动刷新，TTL<4h 时**纯 HTTP GET 闲鱼首页看 Set-Cookie**，绝不主动触发滑块。

### 2.4 对产品的含义

1. 这种风控是**概率性**的：同样的动作，不同账号/时段结果不同。所以工具必须有"熔断 + 人工确认"而不是"重试到成功"。
2. 我们**明确不做**：破解滑块、打码平台、伪造指纹、批量养号。遇到挑战即停、请人工、降频——这既是合规，也是稳定性（pilot-pro 的教训：主动解滑块反而害了正常账号）。
3. 节奏参数建议直接照抄业界保守值：写操作 1 次/分钟、媒体 9 次/分钟、单账号日写 ≤20、发布间隔 ≥60s、动作间 `uniform(1,3)`s、失败退避 `min(60*2^(n-1),1800)`s。

---

## Q3 需不需要浏览器插件辅助

**结论：不需要。** 插件作为"辅助"只在三个边缘场景有价值，且都能被现有方案替代：

| 场景 | 扩展方案 | 替代方案（更优） |
|---|---|---|
| 拿用户登录态 | 扩展读 `document.cookie` / `chrome.cookies` | 直接读浏览器 cookie 库（`browser_cookie3` 同款思路）或让用户粘贴；CDP 也能拿 |
| 页面内签名（算法不可得时） | 扩展 `inject` 脚本 hook 页面函数 | CDP `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate`，能力等价且不用装扩展 |
| 跨域 iframe 里的聊天窗 | `all_frames:true` 注入（`Xianyu-Smart-Customer-` 的 `frame-engine.js` 实证） | CDP `Target.setAutoAttach` 可附着 OOPIF |
| 零安装的 GUI | 扩展 popup 显示进度 | DSH 插件 + 本地 Web 台，体验更好、能力更强 |

扩展的**结构性劣势**：

- MV3 service worker 空闲约 30s 被回收，**做不了常驻 daemon**；要用 `chrome.alarms` 续命，但最小粒度 1 分钟且不稳。
- 分发是硬伤：上架 Chrome Web Store 要审核，且一旦被平台投诉就下架；只能让商家"开发者模式加载"，体验差且每次更新要手动。
- DOM 适配的维护成本与自动化脚本一样高（`Xianyu-Smart-Customer-` 的 `index.js` 37KB 全是选择器），并没有更稳。
- 权限敏感（`<all_urls>` + cookie + 注入）会触发商家安全顾虑，反而不如"本地 daemon + 显式授权"透明。

**建议**：P2 阶段可做一个**只读扩展**（在闲鱼页面上浮层显示"本条已被 Agent 处理/待你确认"，一键接管），仅作为体验增强，**不作为架构依赖**；若要为 C 通道提供"无 `--remote-debugging-port` 的备选接管手"，扩展 + `chrome.debugger` 是唯一路径，可作为 P3 探索项。

---

## Q4 其他问题清单

### P0（不解决就无法交付）

1. **多规格 SKU**：普通发布接口不支持，需 `backend` 段接口 + 双层 JSON。没有它就只能服务"单规格小卖家"，服装/数码配件的商家直接不可用。
2. **类目上限**：网页端部分类目提示"网页版暂不支持发布此分类，请使用 APP"，C 通道无法 100% 覆盖；需在发布前"类目预检"，不支持的直接转人工/走 A 通道。
3. **发布幂等**：`uniqueCode` 必须每次业务唯一生成（`itemId+时间戳+随机` 或业务单号），并做本地"发布中"锁；超时未知结果一律标 `needs_review`，**禁止盲目重试**（会重复铺货 → 触发批发判定）。
4. **合规红线**：逆向接口 + 自动发布违反平台协议，账号可能被封；对外售卖工具可能构成不正当竞争甚至触及刑法 285 条（提供侵入/非法控制计算机信息系统程序）。建议定位为"商家自己的运营助手"（用户自带账号、本地运行、不开 SaaS），并且**不做**验证码破解、不做批量养号、不做数据倒卖。
5. **登录态与凭据安全**：cookie 等价于账号，必须加密落盘（Electron `safeStorage` / Windows DPAPI），永不外传；扫码登录不落密码明文；多端互踢要处理（IM 被踢 → 只停 IM，不停发布）。
6. **许可证传染**：AGPL/GPL 仓库代码一行都不能进我们的包；MIT 的 `xian-guanjia` 可以，但保留版权声明；Apache-2.0 项目注意 NOTICE。

### P1（影响可用性与信任）

7. **接口漂移**：签名参数、字段名、接口名都会变（已有先例：接口从 `mtop.taobao.idle.*` 到 `mtop.idle.pc.*` 并存）。需要：适配层版本化 + 每日探针（用一条只读详情接口） + 失败自动降级/告警。
8. **图片处理**：首图强制 1:1、≤9 张、禁水印/二维码；本地要 `sharp` 做裁剪/压缩；上传接口无公开文档，返回的 URL 是否长期有效需实测。
9. **订单/库存/价格同步**：B/C 通道只能轮询，A 通道有回调。超卖是商家最痛的投诉，需要"发布后 5 分钟内回读库存"的校验闭环。
10. **可观测性**：每个写操作留证（请求/响应/**页面截图**），既便于调试，也是封号申诉的唯一材料。
11. **IM 稳定性**：心跳 15s、必须回 ACK、30s 内不重连会被判离线；消息要按 `msgId` 去重（重连会补发历史）。
12. **AI 客服合规**：不得承诺、不得诱导线下/站外交易、不得泄露他人信息；AI 回复必须有"人工接管"开关。
13. **性能**：daemon 常驻（50–90MB）、浏览器仅发布时起（+200–400MB，20–60s），优先 CDP 接管用户已开的 Chrome；LLM 日 token 硬上限。详细预算见设计文档。

### P2（体验与规模化）

14. **多账号**：一账号一 WS + 独立 deviceId；同 IP 多账号是明确风险，需代理隔离与"每账号独立节奏"。
15. **时间/指纹一致性**：`t` 用毫秒、时区/UA/分辨率与账号历史一致；deviceId 生成后持久化，不要每次变（变化本身是风险信号）。
16. **更新与迁移**：插件签名、自动更新、SQLite schema 迁移、崩溃自恢复；商家不会看日志，错误信息必须"人话 + 下一步该点哪里"。

---

## 5. 建议的路线（相对设计文档的调整）

| 阶段 | 内容 | 调整理由 |
|---|---|---|
| P0（3–5 天） | 登录态导入（浏览器 cookie / 扫码）、daemon + SQLite、`xy_status`/`xy_items` 工具、GUI 商品列表 | 不变 |
| P1（1.5–2 周） | **C 通道**发布（CDP 接管真 Chrome）+ 类目预检 + 幂等 | 把"最稳但最慢"的通道放前面，先拿到可用的发布闭环 |
| P1.5（1 周） | **A 通道**适配器（有资质的商家） | 官方通道是唯一能覆盖多规格+批量+订单的路，越早验证越好 |
| P2（1.5–2 周） | 运营：IM 客服、擦亮、评价、库存校验、只读扩展浮层 | 不变 |
| P3 | **B 通道**发布灰度（多规格 backend 接口）、无端口接管手 | 高风险能力最后开，且默认关闭 |

一句话：**抓取已经不是问题，发布的能力边界和风控节奏才是产品定义**。先做"单规格 + C 通道 + 人工兜底"，跑通 20 个真实商品，再决定要不要碰多规格和后端接口。

---

## 6. 需要你拍板的三件事（沿用设计文档的问题，尚未回答）

1. **目标商家**：只服务纯个人卖家（无需资质，走 C 通道），还是也服务有鱼小铺/ERP 资质的商家（可上 A 通道）？
2. **首发主打**：批量上架（价值密度高、风险也高），还是客服 + 擦亮 + 库存（风险低、日活高）？
3. **运行形态**：DSH 插件 + daemon 自启（贴合你现在的使用方式），还是纯后台 + 独立 Web 台（更像产品）？
