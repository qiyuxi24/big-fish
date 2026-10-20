# C — 闲鱼抓取类开源仓库技术分析（只读）

> 对象：`research/repos/` 下已解压的 xianyu_spider（885★）、ai-goofish（0★）、MediaCrawler（67k★）。
> 方法：只 grep/read，未运行代码、未登录闲鱼、未装依赖；结论均带 `相对路径:行号`。
> 目的：给 DSH 插件 + 本地 daemon（TypeScript/Node）的**发布自动化**挑可复用模式。

## 0. 总览

| 仓库 | 许可 | 路线 | 对我们的价值 |
| --- | --- | --- | --- |
| xianyu_spider | 无 LICENSE 文件、repo license=null（README 自称 MIT，不算授权） | 纯 httpx 直连 mtop + 纯 HTTP 扫码登录，Playwright 仅兜底验证 | 传输/签名/登录态/IM 的最佳范本 |
| ai-goofish | 同样无 LICENSE | Playwright 驱动真实页面点击 + 拦截 XHR 响应 | 「免签名」通道与监控调度的范本 |
| MediaCrawler | NON-COMMERCIAL LEARNING LICENSE 1.1 | 浏览器只登录+签名，业务走 httpx；平台适配器架构 | 只借架构思路，**代码不可抄** |

## 1. xianyu_spider：纯 HTTP 直连 mtop

### 架构与入口
- FastAPI app 工厂 `xianyu/app.py:14-54`：lifespan 内 ensure_im_schema + init_goofish，挂 search/auth/im 三条 router；入口 `python spider.py` → uvicorn 或 CLI（`xianyu/cli.py:52-75`）。
- 分层清晰：`mtop.py`（1327 行，传输+签名+票务+登录）、`search_query.py`（payload 构造）、`search.py`（翻页+落库+去重）、`protocol.py`（协议常量/风控标记）、`session.py`（登录态）、`im_*`（长连接）、`models.py`（Tortoise ORM）。→ 与 daemon 的 transport/signer/session/routes 分层同构。

### 传输与签名
- 纯 httpx 直连，无浏览器参与：`BASE_URL = "https://h5api.m.goofish.com/h5/{}/1.0/"` `xianyu/mtop.py:36`；`APPKEY = "34839810"` `xianyu/mtop.py:37`；`SEARCH_API = "mtop.taobao.idlemtopsearch.pc.search"` `xianyu/mtop.py:44`。
- 签名可完全离线复刻：`md5(f"{token}&{j}&{appkey}&{compact_json(data)}")`，`generate_sign` `xianyu/mtop.py:158-171`；`token = _m_h5_tk.split("_")[0]` `xianyu/mtop.py:68-72`；j=2.7.2。
- Query 字段表：jsv/appKey/t/sign/v=1.0/type=originaljson/accountSite=xianyu/dataType=json/timeout=20000/api/sessionOption=AutoLoginOnly `xianyu/mtop.py:75-96`。
- token 获取与刷新：随机 25 位 cna → GET goofish.com → POST `mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get` 触发 Set-Cookie `xianyu/mtop.py:121-155`；ret 命中 TOKEN EXPIRED/FAIL_SYS 则重跑 init_h5tk 并重试一次 `xianyu/mtop.py:296-322`。
- 匿名可用：登录失效时只保留 `_m_h5_tk/_m_h5_tk_enc/cna`，搜索照跑 `xianyu/mtop.py:379-404`。
- Cookie 域坑：httpx 按 Domain 丢弃 passport 的 Set-Cookie，代码手工重写到 `.goofish.com`（`_promote_cookies_to_goofish` `xianyu/mtop.py:184-188`、`_ingest_response_cookies` `xianyu/mtop.py:191-211`）。→ Node/undici 的自管 cookie jar 有同一坑。

### 登录态
- 判定：`("_m_h5_tk", "unb", "cookie2")` 三件套齐全才算登录 `xianyu/protocol.py:41,103-105`；用户 ID 取 unb/sn `xianyu/protocol.py:85-93`。
- 落盘：`data/session.json`（cookies/device_id/user/user_id）`xianyu/session.py:11-27` + `xianyu/config.py:9`；启动 load+apply 后补一次 init_h5tk `xianyu/mtop.py:132-138`；device_id = `uuid4()+"-"+user_id` `xianyu/mtop.py:242`。
- 纯 HTTP 扫码（daemon 友好，无需起浏览器）：出码 `/newlogin/qrcode/generate.do` `xianyu/mtop.py:1043-1120`；轮询 `/newlogin/qrcode/query.do` `xianyu/mtop.py:1123-1251`，状态 NEW/SCANED/CONFIRMED/EXPIRED（`xianyu/protocol.py:203-223`）；确认后换票 /login_token/login.do（subFlow=DIALOG_CHECK_LOGIN_RPC, nextCode=0018）+ /newlogin/login.do + /newlogin/hasLogin.do `xianyu/mtop.py:769-853`。
- 拍脸（iv）兜底才起 Playwright：`launch_persistent_context(channel="chrome", headless=False, locale=zh-CN, args=["--disable-blink-features=AutomationControlled"])` `xianyu/qr_browser.py:265-290`；`add_init_script` 覆写 `navigator.webdriver` `xianyu/qr_browser.py:177-179`；每 1s 读 `context.cookies()` 导回 httpx `xianyu/qr_browser.py:19-29`；临时 profile 用完即删 `xianyu/qr_browser.py:165,221-222`。→ 「浏览器只做验证、把 cookie 偷回 HTTP 通道」是最省心的分工。

### 风控识别
- 关键页面标记表：havana / /iv/ / verify.htm / punish / h5_verify / identity / aq.taobao / baxia / dialog-view / risk `xianyu/protocol.py:68-82`。
- WAF URL 特征：`_____tmd_____`、`/punish`、`x5secdata=` `xianyu/mtop.py:561-563`。
- ivCheckLogin 白屏需人工贴地址栏 URL 回传服务端换 Cookie `xianyu/mtop.py:998-1029`。→ daemon 应把「需要人工」做成显式事件，不要静默重试。

### 接口形态（可照抄的 API 设计）
- `POST /search/` 返回 logged_in/user_id/new_records；登录失效仍返回 200 + `login_expired` `xianyu/routers/search.py:12-43`。→ 失败不抛异常、用状态字段表达，插件侧好渲染。
- auth 组：`/auth/cookie`、`/auth/qr/start`、`/auth/qr/status`、`/auth/qr/text`、`/auth/qr/trace`、`/auth/qr/callback`、`/auth/qr/continue`、`/auth/qr/browser`、`/auth/status`、`/auth/user`、`/auth/logout` `xianyu/routers/auth.py:27-125`；进度用 HTML 页每 2s fetch 轮询（非 SSE）。

### IM（仓库里唯一的「写操作」范本）
- `wss://wss-goofish.dingtalk.com/` `xianyu/im_client.py:26`；`/reg` 握手带 app-key/token/did/ua 等头 `xianyu/im_client.py:157-168`；心跳 `/!` 15s `xianyu/im_client.py:186-193`；发文本 `/r/MessageSend/sendByReceiverScope`（content base64 + contentType 101）`xianyu/im_client.py:119-148`；收 `/s/sync` `/s/pre` `xianyu/im_client.py:253`；网页版与脚本同开会互踢 token（`README:98`）。

### 限流（反面教材）
- `asyncio.Semaphore(3)` + gather 并发翻页 `xianyu/search.py:96-108`；**无 sleep、无退避、无代理**，README 只是在 `README:163-164` 建议配代理池和随机间隔。

## 2. ai-goofish：Playwright 监控 + Web 管理台

- 登录：人工扫码后 `context.storage_state("xianyu_state.json")` `login.py:12-45`（cookie + localStorage 快照；`LOGIN_IS_EDGE` 可换 msedge `login.py:16-17`）。
- 主爬虫：`launch(headless=RUN_HEADLESS)` + `new_context(storage_state=...)` `spider_v2.py:650-653`；**无 stealth.min.js、无 webdriver 覆写**——靠真实 UI 点击而非常规反检测。
- 取数方式（对发布自动化最关键）：`page.expect_response(lambda r: "h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search" in r.url)` 包住 goto/click，直接吃 XHR JSON，不解析 DOM `spider_v2.py:24,663-664,701-705`；详情接口同法（`...mtop.taobao.idle.pc.detail` `spider_v2.py:26`）。→ **让页面自己发请求 + 拦响应，签名问题自然消失**。
- 交互流程：goto `/search?q=kw` → 等「新发布」→ 点「最新」→ 可选「个人闲置」+价格输入框+Tab → 按 `[class*='search-pagination-arrow-right']` 翻页 `spider_v2.py:658-664,742-751`（用 class 前缀选择器抗改版）。
- 风控：`div.baxia-dialog-mask` 2s 内出现 → 放弃任务并提示关无头 `spider_v2.py:672-689`；详情 ret 含 `FAIL_SYS_USER_VALIDATE` → random 300–600s 长睡后退出 `spider_v2.py:789-798`；`README:71-73` 建议遇滑块关无头人工滑。
- 节奏（按动作分档的 random_sleep）：首屏 2–4s `spider_v2.py:700`、排序后 4–7s、进详情前 3–6s、**每商品后 15–30s** `spider_v2.py:886`、页间 25–50s `spider_v2.py:900`、关页 2–4s `spider_v2.py:895`。
- 去重：每 keyword 一个 `{keyword}_full_data.jsonl`，启动载入历史 link 集合，key=`link.split('&')[0]` `spider_v2.py:79-81,630-648,770-773`。
- 调度：`config.json` 数组（task_name/enabled/keyword/max_pages/personal_only/min_price/max_price/ai_prompt_*）`config.json:1-35`；`main()` 对所有 enabled 任务 `asyncio.gather` 跑**一次即退出** `spider_v2.py:972-984`，无常驻轮询。→ 我们的 daemon 必须补「常驻 + 任务级间隔 + 错峰」。
- 告警：ntfy POST（Priority: urgent，Tags: bell,vibration）+ 企业微信 webhook `spider_v2.py:493-563`；AI 过滤 AsyncOpenAI + base64 图 + `json_object` `spider_v2.py:566-612`；`retry_on_failure` 装饰器 `spider_v2.py:395-425`。
- 管理台：FastAPI + Jinja + StaticFiles `web_server.py:55-71`；任务 CRUD 直接读写 config.json `web_server.py:77-219`；启动=`create_subprocess_exec(sys.executable,"-u","spider_v2.py")` 重定向 `logs/scraper.log` `web_server.py:222-250`，停止=terminate `web_server.py:253-269`，日志=GET /api/logs 读整个文件 `web_server.py:272-292`。→ MVP 可用，daemon 化后应换成进程内作业 + 推送。

## 3. MediaCrawler：架构参考（许可禁止商用）

- 许可：`NON-COMMERCIAL LEARNING LICENSE 1.1` `LICENSE:1-18`（中文版 `LICENSE:31+`）：禁止商用、禁止大规模爬取、须保留声明。**代码不可进 DSH 产品，只能借思路。**
- 分层：`main.py` 的 `CrawlerFactory` 按平台返回实现 `main.py:50-67`；抽象四件套 AbstractCrawler/AbstractLogin/AbstractStore/AbstractApiClient `base/base_crawler.py:26-111`；平台细节在 `media_platform/<p>/{core,client,login,help,field}.py`；横切能力独立成包 proxy/ cache/ store/ database/ tools/ api/。→ 我们的「平台适配器 + 横切模块」目录可直接照此约定。
- 混合传输（核心模式）：浏览器只做三件事——登录、给 httpx 供 cookie（`utils.convert_browser_context_cookies` `media_platform/xhs/core.py:387-390`）、在页面内算签名；业务全走 httpx。自愈：`if not await client.pong()` → login → `update_cookies` `media_platform/xhs/core.py:108-120`。
- 浏览器内签名三范式：
  1. 纯算法旁路：xhs 用 xhshow 复算 x-s/x-t（`media_platform/xhs/playwright_sign.py:33-72`、`media_platform/xhs/client.py:111-124`）——有算法时首选。
  2. 直调页面函数：抖音 `window.bdms.init._v[2].p[42](...)` 出 a_bogus（`media_platform/douyin/help.py:85-98`，已标 deprecated）。
  3. **hook 捕获 + 回调**：注入 `KS_SIGN_CAPTURE_SCRIPT` 劫持 `Object.prototype.caver` 的 setter 抓到页面签名对象存 `window.__ks_realm`，再在 `page.evaluate` 里用 Promise 包 `$encode` 调用（`media_platform/kuaishou/help.py:35-86`、注入点 `media_platform/kuaishou/core.py:105`）。→ 发布接口没公开算法时照第 3 种做。
- 登录态复用三档：storage_state 快照（ai-goofish 级）→ `launch_persistent_context(user_data_dir=browser_data/...)` 持久 profile `media_platform/xhs/core.py:417-445` → **CDP attach 用户真实 Chrome**（`config/base_config.py:59-83`、`tools/cdp_browser.py:313-346`、`tools/browser_launcher.py:119-161`：`--remote-debugging-port=9222` + `--disable-blink-features=AutomationControlled`；Chrome 136+ 连已开实例直连 `ws://localhost:9222/devtools/browser` `tools/cdp_browser.py:318-341`）。→ 反检测上限就是「用真人浏览器」。
- 反检测：非 CDP 模式统一 `add_init_script(path="libs/stealth.min.js")`（各平台 `core.py:96-105`）；CDP 模式不注入（真浏览器即最强伪装）。
- 限流：`asyncio.Semaphore(MAX_CONCURRENCY_NUM)`（默认 1 `config/base_config.py:105`）+ 每请求 `asyncio.sleep(CRAWLER_MAX_SLEEP_SEC)`（默认 2s `config/base_config.py:140`），全局串行最保守（`media_platform/xhs/core.py:169,190,245,274,326`）。
- 代理池：先验活再入池（GET `https://echo.apifox.cn/` 200 才算活 `proxy/proxy_ip_pool.py:56,71-97`），取一个即出池、耗尽重载 `proxy/proxy_ip_pool.py:99-120`；IP 错误码 300012 触发换 IP（`media_platform/xhs/client.py:78-80` + `proxy/proxy_mixin.py`）。
- 存储/去重解耦：`store/<p>/_store_impl.py` + 通用 `store/excel_store_base.py`；`cache/` 抽象 + 本地 TTL 缓存（`cache/local_cache.py:34-56`）/redis；`database/{db,models}.py` 支持 sqlite/mysql/postgres。
- 守护式 API：`api/services/crawler_manager.py:30-120` 用 `asyncio.Lock` 保护单例子进程、500 条环形日志、`asyncio.Queue` → WebSocket 实时推日志（`api/routers/websocket.py`）。→ 比 ai-goofish「读整个日志文件」更接近本地 daemon 应有形态。

## 4. 对 DSH（插件 + 本地 daemon，TS/Node）的可复用结论

1. **发布写操作不要复算签名**：三个仓库都没有「发闲置」实现，xianyu_spider 里也没有发布 api（grep 仅 `xianyu/mtop.py:36-44` 的 search/login/IM）→ 发布接口需自行抓包定位（形如 `mtop.taobao.idle.pc.*`），签名走「hook 页面签名器」路线；只读搜索则可按 xianyu_spider 纯 HTTP 复刻（md5 + 三件套）。
2. **双通道同一接口**：`TraceTransport`（undici 直连 mtop，快、省资源，需自管 cookie 域与 token 刷新）与 `BrowserTransport`（Playwright/CDP 驱动页面发请求并拦响应，免签名）实现同一接口；风险升级时自动降级到 BrowserTransport。
3. **登录态单文件**：cookies[] + deviceId + userId（+ 可选 storageState）；每次响应回写 Set-Cookie 并重写 `.goofish.com` 域；有效性用三件套齐全 + unb 判定，失效即触发扫码流程（二维码 URL 交给插件渲染，服务端轮询 status）。
4. **风控总线**：统一枚举 baxia 遮罩 / 滑块 / iv 拍脸 / punish / WAF；命中 → 事件上报插件 → 人工（HITL）→ 回写 cookie；不要在各处零散 if，更不要静默长睡重试。
5. **限流**：按动作类型分档随机延迟（浏览轻、提交重），全局并发 1–2；提交类再加「每日配额 + 幂等键（先落草稿库再提交）」，参考 ai-goofish 每商品 15–30s 的实测下限。
6. **调度**：任务定义 JSON + 运行记录 JSONL；daemon 常驻，任务级 `nextRunAt` + 抖动、单任务串行、任务间错峰、失败退避翻倍；启停在进程内（CrawlerManager 模式）而非 spawn 子进程 + 读日志文件。
7. **告警**：结构化事件流，ntfy/webhook 只是 sink；先落盘再推送，推送失败可重放。
8. **许可红线**：xianyu_spider、ai-goofish 无 LICENSE 文件（repo license=null；ai-goofish `README:281` 自认参考 xianyu_spider）→ 只借思路不抄代码；MediaCrawler 明禁商用 → 连代码级借鉴也避免，仅保留架构名词。
9. **缺口（需真实抓包补）**：发布表单字段结构、图片/视频上传（OSS）流程、发布后校验与撤回；本次规则禁止运行仓库代码，未验证。

---

### 一句话记忆

`纯 HTTP + md5 签名`（xianyu_spider）做读，`真实浏览器点 + 拦 XHR`（ai-goofish）兜底，`浏览器供 cookie/签名 + 业务走 HTTP`（MediaCrawler）做架构，发布走 hook；三个仓库的许可都不允许抄代码。
