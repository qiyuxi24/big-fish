# B-im · 闲鱼 IM 三仓只读分析（XianyuAutoAgent / xianyu-auto-reply / xianyu-super-butler）

> 目标：为 DSH（插件 + 本地 daemon，TypeScript/Node）提取可复用协议事实。所有结论带 仓库内相对路径:行号。
> 方法：只读 read/grep，未 clone、未装依赖、未运行仓库代码、未真实登录。

## 0. 速览

| 仓 | License | 规模 | 栈 | 形态 |
|---|---|---|---|---|
| XianyuAutoAgent | GPL-3.0（LICENSE:1） | 4 个核心文件，main.py 778 行 | asyncio + websockets + OpenAI 兼容 SDK | 单进程脚本 + SQLite + Dockerfile |
| xianyu-auto-reply | AGPL-3.0（LICENSE:1） | 1021 文件 | FastAPI + SQLAlchemy + MySQL/Redis + React | 5 服务 docker-compose（:9-295）+ launcher 离线发行版 |
| xianyu-super-butler | AGPL-3.0（LICENSE:1） | XianyuAutoAsync.py 约 9000 行单文件 | asyncio + FastAPI + Playwright | 单进程 + 8080 Web 面板 + Dockerfile |

## 1. 架构与入口

- **XAA**：`XianyuAutoAgent/main.py:19 class XianyuLive`，:778 `asyncio.run(xianyuLive.main())`；单协程闭环：WS 推送 → XianyuApis(mtop) → XianyuReplyBot(AI) → context_manager(SQLite)。AI 侧 `XianyuAgent.py:8 XianyuReplyBot`、:148 IntentRouter、:201 BaseAgent + Price/Tech/Classify/Default 四子类（:234/:257/:283/:291）。
- **SB**：`xianyu-super-butler/XianyuAutoAsync.py:179 class XianyuLive` 一个实例承载一个账号的全部状态；入口 `Start.py:758 main()` → :770 建 CookieManager → :776-787 按 DB 启用 cookie 逐个 `_ensure_cookie_task_async` → :802-805 兼容老 `COOKIES_STR` 作 default 账号 → :809 起 API 线程。Web 面板 `app/reply_server.py:358 app = FastAPI(` + `:368-379 include_router`。
- **AR**：微服务。WS 网关 `websocket/app/services/xianyu/`：`xianyu_async.py:58 class XianyuAsync`（3360 行）、`message_handler.py:21 MessageHandler`、`connection_manager.py`、`auto_delivery_handler.py:44`；调度独立进程 `scheduler/`；账号/订单/AI 配置在 backend-web。

## 2. 传输方式（IM WebSocket，三仓协议一致）

- 地址统一 `wss://wss-goofish.dingtalk.com`（XAA main.py:615-627；AR xianyu_async.py:33 可由 WEBSOCKET_URL 覆盖；SB app/config.py:97）。握手 header：Cookie + 浏览器 UA + `Origin: https://www.goofish.com`。
- 注册 `lwp: "/reg"`，headers `cache-header: "app-key token ua wv"`、`app-key: 444e9908a51d1cb236a27862abc769c9`、`token: accessToken`、`ua` 伪造钉钉串（…Chrome/133.0.0.0 Safari/537.36 DingTalk(2.1.5) OS(Windows/10) … IMPaaS DingWeb/2.1.5）、`dt: j`、`wv: "im:3,au:3,sy:6"`、`sync: "0,0;0;0;"`、`did: device_id`、`mid: generate_mid()`（SB XianyuAutoAsync.py:6869-6883 最完整；AR xianyu_async.py:588-601 逐字同构）。
- 注册后 sleep(1) 发 `lwp: "/r/SyncStatus/ackDiff"`：body pipeline/channel/topic 均 `sync`、`tooLong2Tag:"PNM,1"`、`pts = now_ms*1000`（SB :6885-6902；AR :606-623）。
- 保活双保险：应用层 `lwp:"/!"` 每 15s（AR xianyu_async.py:34 HEARTBEAT_INTERVAL=15、:35 超时 30s；SB app/config.py:98-99）；库层 `ping_interval=20, ping_timeout=15, open_timeout=30`（AR connection_manager.py:197-215，注释解释默认 10s 会把 TLS 抖动误判成 token 失效并触发人脸验证）。
- **每条下行必须回 ACK**，否则服务端断连：`{"code":200,"headers":{mid, sid, app-key, ua, dt}}`（AR message_handler.py:573-598；XAA main.py:655-667）。
- 发消息 `lwp: "/r/MessageSend/sendByReceiverScope"`：body[0] `cid=f"{chat}@goofish"`、`conversationType:1`、`content={contentType:101, custom:{type:1, data: base64(JSON{contentType:1,text:{text}})}}`、`uuid`、`ctx:{appVersion:"1.0",platform:"web"}`、`msgReadStatusSetting:1`；body[1] `{actualReceivers:[toid@goofish, myid@goofish]}`（XAA main.py:112-156；SB :6676、6817-6829；AR :2008、:2769）。建会话用 `/r/SingleChatConversation/create` 取 cid（AR :2354、:2392）。
- 解码：`body.syncPushPackage.data[*].data` 先当 `base64 → JSON` 明文试，失败才 `decrypt()` = ascii 清理 → base64（补 padding）→ **标准 MessagePack**（XAA utils/xianyu_utils.py:287-335 + 自写 decoder :72-284；SB utils/xianyu_utils.py:358-399 + :151-355）。**对 Node：用 `@msgpack/msgpack` 即可，无需移植那份纯 Python decoder。** AR 还判 `bizType=='IDLE_SPACE_PRICING'` 与 `is_system_tip_message` 丢弃系统提示（message_handler.py:602-638），并按 message_id 去重（:644-649）。
- 消息结构：`message["1"]["10"]`={reminderContent, reminderTitle, senderUserId, reminderUrl(内含 itemId=)}；`["1"]["5"]` 毫秒时间戳；`["1"]["2"]` chat_id；`["3"]["redReminder"]` ∈ {等待买家付款, 交易成功/等待卖家发货, 交易关闭}（XAA main.py:409-451；SB :10048-10060 用它触发发货）。

## 3. 签名 / 登录态

- mtop 前缀 `https://h5api.m.goofish.com/h5/<api>/<ver>/`，统一表单 `jsv=2.7.2`、`appKey=34839810`、`v=1.0`、`type=originaljson`、`dataType=json`、`sessionOption=AutoLoginOnly`（XAA XianyuApis.py:152-171）。
- 签名 `sign = md5(f"{token}&{t}&{appKey}&{data}")`，`t`=毫秒时间戳（XAA utils/xianyu_utils.py:61-69；SB :140-148 同式）。token = Cookie 里 `_m_h5_tk` 的 `'_'` 前段（XAA XianyuApis.py:189,284）。
- 登录态判定 `passport.goofish.com/newlogin/hasLogin.do`，需 `unb/cookie2/XSRF-TOKEN/cna`（XAA XianyuApis.py:96-122）。IM accessToken 走 `mtop.taobao.idlemessage.pc.login.token`（SB app/config.py:4、utils/manual_captcha.py:97；AR common/services/im_token_api.py）。
- **token 只在建连的 /reg 头里用一次**，换 token 必须重连重注册：AR `_reconnect_with_new_token()` 先刷新、拿不到新 token 就不动现有连接（xianyu_async.py:2417-2458）。
- `device_id` 由 `generate_device_id(user_id)` 稳定派生（SB utils/xianyu_utils.py:115）；同账号多端同时在线会互踢。
- 错误码语义必须分开：`FAIL_SYS_TOKEN_EXOIRED/EXPIRED::令牌过期` 可恢复（响应自带 set-cookie，重签即可）；`FAIL_SYS_SESSION_EXPIRED::Session过期` 只能重登（SB XianyuAutoAsync.py:2412-2462）。

## 4. 关键接口与字段（mtop 清单）

| api | 用途 | 出处 |
|---|---|---|
| idlemessage.pc.login.token | 取 IM token / 风控返回 punish URL | SB utils/manual_captcha.py:97 |
| idle.pc.detail | 商品详情（标题/价/描述） | SB XianyuAutoAsync.py:4204-4228；AR xianyu_detail_client.py:5 |
| idle.item.polish (2.0) | 擦亮 | SB utils/item_polish.py:6-8,21-23 |
| trade.merchant.sold.get | 卖家订单列表 | SB utils/xianyu_seller_api.py:264；AR order_service.py:1140 |
| logistic.consign.dummy | 虚拟发货/确认发货 | SB app/secure_confirm.py:110,133 |
| merchant.rate.create / idlemessage.red.flower | 评价 / 小红花 | SB :650-679；AR rate_service.py:97、:171 |
| trade.merchant.close.by.seller | 主动关单 | SB XianyuAutoAsync.py:1095-1110 |
| idlemtopsearch.pc.search | 搜索 | AR xianyu_search_client.py:5 |
| trade.order.render / order.create / logistic.address.list.query | 买家侧下单链路 | AR xianyu_order_client.py:27-33 |

- 卖家端与买家端同名字段语义/取值不同，迁移时须逐接口核对（SB utils/xianyu_seller_api.py:410-414 起多处注释，如 consign.page.render:445、refund.list:565）。

## 5. 风控 / 自动过滑块（最重要结论）

**没有一家用打码平台；自动过滑块 = 真实浏览器自动化。SB 与 AR 给出相反结论，差别在「鼠标事件注入方式」而不是轨迹质量。**

- **XAA 直接放弃**：命中 RGV587_ERROR /「被挤爆啦」就 print 指引 + `input()` 让用户手动过滑块后贴新 Cookie（XianyuApis.py:204-236），全程无浏览器。
- **SB 判死**：Playwright（优先 patchright）开阿里 NC 组件，选择器 `#nc_1_n1z`(滑块)/`#nc_1_n1t`(轨道)；轨迹 = 贝塞尔 + 物理模型 + 历史成功轨迹自学习（utils/xianyu_slider_stealth.py:958-1093、:637-697）。必须 `headless=False`（注释：无头 0/2 通过、有头 1/3 通过，服务器上 Xvfb；XianyuAutoAsync.py:2606-2611）。但 utils/manual_captcha.py:1-13 明写「自动拖到误差 0.3px 内服务端仍判失败，拦的是行为特征，继续加自动重试不会有结果」→ 失败即熔断 trip，冷却 300s→600s（:2350-2359）。
- **AR 给出了 SB 失败的机制解释**（这节是本仓最有价值的部分）：baxia「能区分 CDP 注入的鼠标事件与真实硬件鼠标事件」——Playwright(CDP) 回放真人轨迹仍 code=300（拒），pyautogui 驱动物理光标回放同一条轨迹 code=0（通过）（common/services/captcha/real_mouse_slider.py:1-19）。原因：`PointerEvent.getCoalescedEvents()` 每帧子事件数，SetCursorPos 每帧 ~1 个、真人硬件 2~8 个；Win32 `SendInput` 背靠背连发多个移动被 Chrome 合并后逼近真人密度（common/services/captcha/win_input.py:1-15）。代价：接管物理光标 2~3s、需前台窗口、全局串行、仅 Windows 有桌面（windows_foreground 保证前台）。
- 引擎编排顺序：远程解法 → 真实鼠标 → Playwright（Playwright 失败直接返回，不再走 DrissionPage 兜底）（common/services/captcha/orchestrator.py:1-6）；判定通过的唯一标准是拿到 `x5*` cookie（`_has_x5sec`，:20-28）。
- 「远程过滑块」≠ 打码平台，是自建浏览器农场当服务：POST `{secret_key, account_id, url, browser_timeout, cookies_str, device_id}`，返回 `ok/fail/url_expired/fallback`（orchestrator.py:41-72、remote_solver.py:26-45、websocket_solver.py:25-36，内部调用带 `build_internal_auth_headers`）。真人通过轨迹以 `common/services/captcha/human_trails/human_trail_pass_*.json`（18 个）随仓分发复用。
- **决定成败的是 Cookie 不是滑动**：只有 `x5sec` 是通行凭证，`x5secdata/x5sectag/x5step` 是挑战标记；拿到 x5sec 后必须删旧挑战 cookie，否则 token 刷新永远 `FAIL_SYS_USER_VALIDATE`（SB XianyuAutoAsync.py:2636-2690；utils/xianyu_utils.py:72-92 `drop_stale_captcha_challenge`）。
- 惩罚 URL 来源：`idlemessage.pc.login.token` 的 `data.url` 返回 `…punish?x5secdata=…&x5step=2&action=captcha`，有效期约 1h；只有导航到它才会弹滑块（SB utils/manual_captcha.py:33-42,70-141；scripts/get_punish_url.py）。人工兜底：Playwright 开 punish 页 → 截容器图 → WebSocket 推前端 `/static/captcha_control.html?session=<id>`（1s 刷新）→ 用户拖 → 回放鼠标 → `context.cookies()` 拼回（utils/captcha_remote_control.py:13-96、app/api_captcha_remote.py、utils/manual_captcha.py:144-360）。
- 风控特征串：`RGV587_ERROR / FAIL_SYS_USER_VALIDATE / 哎哟喂 / 被挤爆 / FAIL_SYS_FLOW_LIMIT / 请稍后重试`（SB XianyuAutoAsync.py:531-538）；滑块判定还看 `punish?x5secdata`、`data.url` 含 punish/captcha/validate（:2546-2571）。退避 `min(60*2^(n-1), 1800)` 秒（:546-567）；trip 后不要再 trip 一次（会跳级，:2353-2359）。
- **干扰项澄清**：SB 的 utils/geetest/geetest_lib.py 是「极验」SDK，只用于它自己 Web 面板登录（app/reply_server.py:957-1024），与绕过闲鱼滑块无关。

## 6. 节奏与限流

- 心跳 15s；库层 ping 20s（§2）。AR token 续期任务扫「未来 1 小时内到期」且无处理中风控日志的 token，命中挤爆时调 WS 滑块（scheduler/…/token_renewal_task.py:1-11）。
- SB：`TOKEN_REFRESH_INTERVAL` 默认 72000s=20h（app/config.py:100）。`cookie_refresh_interval = 1200` 但注释写「1小时 = 3600秒」（XianyuAutoAsync.py:801）——注释与常量不符，实际 20 分钟，属可踩的坑。
- 擦亮：默认关闭、最短 1h（`interval = max(3600, interval)`，XianyuAutoAsync.py:7314-7325）；单商品每日次数平台限，超限返回业务错误而非异常（utils/item_polish.py:6-8）。
- 评价：按订单冷却 `ORDER_COOLDOWN_SECONDS=600`（AR scheduler/…/rate_task.py:32-36）。
- 发送拟人化：XAA 打字延迟 = U(0,1)+len(reply)*U(0.1,0.3)，上限 10s（main.py:537-546）；AR 按账号配 `reply_delay_seconds`（common/models/xy_account.py:70），消息过期 `message_expire_time` 默认 3600（:67）。
- 浏览器并发：SB 进程内全局信号量（不按账号各建，避免多账号刷新撞车），槽位按机器配置推算、弱机强制单开（utils/browser_limit.py:1-30，环境变量 `MAX_CONCURRENT_BROWSERS` 可覆盖）；AR 有并发管理器 + 账号级互斥锁（common/services/captcha/concurrency.py、drissionpage_slider.py:94-118）。

## 7. 数据库与多账号

- **XAA**：SQLite `data/chat_history.db`，表 messages/chat_bargain_counts/items；上下文 `max_history=100`；议价次数塞成 role=system 伪消息「议价次数: N」回灌上下文（context_manager.py:16,40-96,239-243）。
- **SB**：SQLite 约 45 张表（app/db_manager.py:82-932），关键组：账号 cookies:120/cookie_status:158、AI ai_reply_settings:168/ai_conversations:190/ai_item_cache:207、交易 orders:264/cards:218/card_shipments:244、发货规则 delivery_rules:659/item_delivery_configs:679/product_variants:694/delivery_sku_*:745-761、风控 risk_control_logs:880、过滤 message_filters:895、日志 auto_reply_message_logs:932。
- **多账号**：SB 一个账号一个 `XianyuLive` + 一组定时协程（心跳/token/cookie 刷新/擦亮/订单同步/发货超时/买家互动，任务挂在 XianyuAutoAsync.py:520-527）；AR 用 `xy_accounts` 表（common/models/xy_account.py:24-120）存 cookie/代理/各类开关（reply_delay_seconds:70、auto_polish:82、scheduled_redelivery:76、scheduled_rate:79、auto_red_flower:94、auto_close_order:103、proxy_*:50-54），并让 WS 走与 HTTP 相同的账号代理以保 IP 一致（connection_manager.py:217-292，python-socks）。
- **议价三法对比**：XAA temperature = `min(0.3+轮次*0.15, 0.9)` 注进 system prompt（XianyuAgent.py:237-254）；SB 本地关键词+正则判意图（省钱省延迟）+ 底价 `min(百分比优惠, 固定金额)` 取更严格者（app/ai_reply_engine.py:460-545）；AR 用 DB 计数 + prompt 内嵌「当前议价次数/最大轮数/最大优惠百分比 10%/最大优惠金额 100 元」四元组（websocket/…/ai_reply_engine.py:820-908）。
- **议价两坑**：SB 侧「167」这类裸数字不算报价导致计数永远 <3（实测 AI 从 196 一路让到 168 而 count 仅 3，ai_reply_engine.py:485-494）；SB 自述「未修复 P0-1 议价竞争条件」，并发下轮次计数可能被绕过（ai_reply_engine.py:9）。
- **部署**：AR = MySQL+Redis+5 服务（docker-compose.yml:9-295 各自扩缩，backend 连接池 800）；SB = 单容器 8080（Dockerfile:72-77）+ 可选 nginx；XAA = 单容器脚本。

## 8. 许可证（合规）

- XianyuAutoAgent：GPL-3.0（LICENSE:1）；xianyu-auto-reply：AGPL-3.0（LICENSE:1）；xianyu-super-butler：AGPL-3.0（LICENSE:1）——**三仓全部 copyleft**。
- 结论：DSH 侧不可逐字复制这三仓代码进闭源产品（AGPL 两仓即使只做网络服务也须开源）。可复用且不受版权约束的是「协议事实」（端点、字段名、sign 公式、消息结构），必须独立重写实现，不搬注释、不搬轨迹 JSON、不搬 prompt 文案。

## 9. 对 DSH（插件 + 本地 daemon，TS/Node）的可复用结论

1. **传输层可 1:1 复刻**：ws 地址 + Cookie/UA/Origin + /reg(/ackDiff) + 15s `/!` + 每条 ACK，全是明文 JSON，Node `ws` 够用；注意 ACK 漏发会被服务端断开（§2）。
2. **解码别移植 Python**：base64 → 标准 msgpack（`@msgpack/msgpack`）。顺序必须是「先 JSON 明文、失败再 msgpack」，因为明文消息与加密消息混在同一 data 字段（§2）。
3. **token 是两套要分开建模**：`_m_h5_tk`（HTTP mtop 签名）与 IM accessToken（/reg）独立；accessToken 只在建连时用一次，换 token 必重连重注册；且 `令牌过期` 与 `Session过期` 处理路径不同（§3）。daemon 建议显式状态机 `valid | expiring | challenge | relogin`，这是最容易做错的地方。
4. **滑块不要做成「自动通过」能力**：三仓里两家最深的实现一致指向「行为特征识别」。对 daemon 的正确抽象是 `ChallengeEvent` + 本地有头浏览器 helper + 人工确认回填 Cookie；可选物理输入（SendInput）作为进阶，但需前台窗口、Windows 桌面、全局串行，CI/服务器不可用（§5）。
5. **挑战 cookie 清洗是必做小步骤**：保留 `x5sec`、清除 `x5secdata/x5sectag/x5step`，否则永远 `FAIL_SYS_USER_VALIDATE`（§5）。
6. **风控要有账号级状态位 + 指数退避 + 熔断**，并把「风控中/需人工」暴露给插件 UI（§5）。
7. **AI 层：本地关键词+正则先行分流，只对 price/default 调 LLM**（省成本降延迟）；议价轮次必须落库计数、必须识别裸数字报价；prompt 用「商品信息 + 最近 10 条上下文 + 议价四元组」（§7）。
8. **接口清单（§4）已足够映射插件功能**：发/收消息、商品详情、发货确认、评价、擦亮、订单、搜索；注意版本号混用（擦亮是 2.0，多数是 1.0）。
9. **多账号 = Map<accountId, Session> + AbortController**，一账号一 WS + 独立 device_id + 可选同 IP 代理；后台定时任务按账号组协程，不要全局单例。
10. **不要照抄的部分**：SB 9000 行单文件 + 自述未修的竞争条件；AR 的历史包袱（DB 兼容层、计数式议价）。DSH 用 TS 类型 + 小表 + 事件驱动更干净；协议照 §2/§3 重写 200 行以内。
