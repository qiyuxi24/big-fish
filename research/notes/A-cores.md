# A · 核心通道笔记（mtop 逆向 / 官方开放平台 / 网页 RPA）

分析对象（`research/repos/`，只读）：`XianYuApis`(cv-cat, 1591★) · `xian-guanjia`(thefreelight, 30★) · `XY-Agent`。
配套笔记：`research/notes/C-scraping.md`（采集系）。

## 0. 许可证先看（法律结论先于技术结论）
| 仓库 | LICENSE 文件 | 结论 |
|---|---|---|
| xian-guanjia | `xian-guanjia/LICENSE` MIT © 2026 kingofmarketing | **唯一可复用代码** |
| XianYuApis | 无（README.md:5 徽章自称 MIT，但仓库无 LICENSE/COPYING） | 默认保留所有权利，**代码不可抄**，算法事实可学 |
| XY-Agent | 无 | 同上，不可抄代码 |
| MediaCrawler | `MediaCrawler/LICENSE` NON-COMMERCIAL LEARNING 1.1 | 仅学习 |
| xianyu-auto-reply / xianyu-super-butler | AGPL-3.0 | 传染，商用禁用 |
| XianyuAutoAgent | GPL-3.0 | 传染 |
`ai-goofish`、`xianyu_spider` 亦无 LICENSE。→ 落地时只可移植 `xian-guanjia` 的签名/客户端代码；mtop 与 RPA 部分须自研实现（可参考思路，不复制代码）。

## 1. XianYuApis（裸 HTTP 逆向 mtop）——不是 JS 项目，是 Python 移植版
- 形态：18 个文件，`Dockerfile`(python:3.12-slim + Node 18，`CMD ["python","goofish_live.py"]`)、`requirements.txt`(requests, loguru)、`goofish_apis.py`(776 行，HTTP 全流程)、`goofish_live.py`(337 行，IM WebSocket)。
- 两个入口：`goofish_apis.py:749-776`（扫码登录 → `public()` 直接发一个商品）；`goofish_live.py:326-337`（`cookies_str = r''` 手填 Cookie → `asyncio.run(main())` 常驻收发消息）。

### 1.1 mtop 签名（全局唯一算法，三个文件互证）
- 核心：`sign = md5(token + "&" + t + "&" + 34839810 + "&" + data)` —— `static/goofish_js_version_2.js:19-26`，其中 `34839810` 即 appKey，`token` 是 cookie `_m_h5_tk` 按 `_` 切开的前半段（`goofish_apis.py:741`），`t` 为毫秒时间戳（`goofish_apis.py:599` 用的是 `int(time.time())*1000`，**秒级精度**），`data` 为 JSON 紧凑串（`separators=(',',':')`）。
- 调用侧：`utils/goofish_utils.py:54-56` 走 `execjs` 调 JS，`:12-14` 载入 `static/goofish_js_version_2.js`。**我们不需要 execjs/子进程，Node 里 `crypto.createHash('md5').update(s).digest('hex')` 即可等价。**
- 辅助 ID：`generate_mid` = `"" + Math.floor(1e3*Math.random()) + Date.now() + " 0"`（`static/goofish_js_version_2.js:3-5`）；`generate_uuid` = `"-" + Date.now() + "1"`（`:7-9`）；`generate_device_id` = 36 位 UUID 形态 + `"-" + user_id`（`:11-16`）。
- 通用参数模板见 `utils/build_cookies.py:63-78` 与 `goofish_apis.py:596-611`：`jsv=2.7.2, appKey=34839810, t, sign, v=1.0, type=originaljson, accountSite=xianyu, dataType=json, timeout=20000, api=..., sessionOption=AutoLoginOnly, spm_cnt, spm_pre`；body 为表单 `data=<json字符串>`；headers 必带 `Origin/Referer=https://www.goofish.com` 与 Chrome UA（`goofish_apis.py:578-594`，UA 版本号写死 146，`build_cookies.py:16-17` 写死 147 —— 已过时风险点）。
- **tfstk**（阿里风控 cookie）：不是纯算法，而是阿里 `et_f.js` 反爬 SDK 在浏览器环境算出来的。`utils/gen_tfstk.js` 用 vm 沙箱 + deep Proxy 补环境（`:1-10` 策略说明、`:344-362` has 恒 true 防 ReferenceError、`:364-386` 每 200ms×30 次轮询 cookieWrites，命中 `name==='tfstk'` 输出，并主动调 `__awsc_et__.getETToken({appkey:'XIANYU'})`）；调用侧 `_gen_tfstk()`（`goofish_apis.py:57-65`）用 `subprocess.check_output(['node', ...])` 拿 stdout。→ **Node daemon 最稳的取法是直接从用户浏览器 Cookie 读 tfstk，而不是补环境重算。**

### 1.2 登录态：扫码（可全自动）+ 续期
- 前置 cookie：`build_initial_cookies()` 有两份同逻辑实现——`goofish_apis.py:68-93` 返回 `requests.Session`（登录流程用）、`utils/build_cookies.py:52-94` 返回纯 dict（CLI 用）。三步：① `GET https://log.mmstat.com/eg.js` 取 `cna` 再 set 到 `.goofish.com` ② 两次「空 sign」POST mtop（`mtop.taobao.idlehome.home.webpc.feed`、`mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get`）拿 `_m_h5_tk`/`cookie2` ③ 塞 `tfstk`；共 7 个：`cna/xlly_s/mtop_partitioned_detect/_m_h5_tk/_m_h5_tk_enc/cookie2/tfstk`（`utils/build_cookies.py:85-94`）。
- 扫码七步（`goofish_apis.py:96-280`）：① 基础 cookie ② `GET passport.goofish.com/mini_login.htm`（`appName=xianyu&appEntrance=web&fromSite=77`）取 `XSRF-TOKEN`/`_tb_token_`（`:117-129`）③ `GET newlogin/qrcode/generate.do` 得 `codeContent`(二维码 URL)/`t`/`ck`（`:132-152`）④ 终端用 █▀▄ 半块字符打印二维码（`:157-186`）⑤ `POST newlogin/qrcode/query.do` 轮询 `qrCodeStatus`：NEW→SCANNED→CONFIRMED，`poll_interval=3s, timeout=120s`，CONFIRMED 时 Set-Cookie 已带 `sgcookie/unb/tracknick/csg`，EXPIRED 抛 TimeoutError ⑥ `POST passport.goofish.com/login_token/login.do?token=&subFlow=DIALOG_CHECK_LOGIN_RPC&nextCode=0018&bizScene=qrcode&confirm=true`，body `deviceId=cna` ⑦ 空 sign 打 `mtop.idle.web.user.page.nav` 刷新 `_m_h5_tk`，再 `generate_device_id(unb)` 建实例。
- 拿 IM accessToken：`get_token()`（`goofish_apis.py:295-345`）→ mtop `mtop.taobao.idlemessage.pc.login.token`，data=`{"appKey":"444e9908a51d1cb236a27862abc769c9","deviceId":...}`，返回 `data.accessToken`；命中 `令牌过期` 字符串则递归重试（`:343-344`，**全仓库唯一的风控/错误处理，无错误码表、无滑块、无重试退避**）。
- 续期：`refresh_token()`（`goofish_apis.py:348-396`）打 `mtop.taobao.idlemessage.pc.loginuser.get`；IM 侧独立线程每 600s 续一次（`goofish_live.py:252-255`）。

### 1.3 发布商品（网页版 mtop，非开放平台）
- 接口：`POST https://h5api.m.goofish.com/h5/mtop.idle.pc.idleitem.publish/1.0/`，`api=mtop.idle.pc.idleitem.publish`，`spm_cnt=a21ybx.publish.0.0`，`spm_pre=a21ybx.home.sidebar.1.46413da6EPl7v5`（`goofish_apis.py:595-611`）。
- 请求体顶层字段（`goofish_apis.py:612-643`）：`freebies, itemTypeStr:"b", quantity:"1", simpleItem:"true", imageInfoDOList[], itemTextDTO{desc,title,titleDescSeparate:false}, itemLabelExtList[], itemPriceDTO{}, userRightsProtocols[{enable:false,serviceCode:"SKILL_PLAY_NO_MIND"}], itemPostFeeDTO{}, itemAddrDTO{}, defaultPrice, itemCatDTO{}, uniqueCode, sourceId/bizcode/publishScene="pcMainPublish"`。注意 `title` 与 `desc` 都填同一段文案（网页版只有一个描述框）。
- 图片：先 `POST https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat&_input_charset=utf-8`（multipart 字段名 `file`，`:399-428`），返回 `object.url`/`object.pix`(宽x高)，再拼成 `{extraInfo{isH,isT,raw:"false"},isQrCode:false,url,heightSize,widthSize,major:true,type:0,status:"done"}`（`:644-669`）。
- 价格：`itemPriceDTO.priceInCent` / `origPriceInCent`（元×100 转字符串，`:686-690`）；不传价则 `defaultPrice=true`。
- 运费 4 选 1（`:670-683`）：包邮→`canFreeShipping+supportFreight=true`；按距离→`supportFreight+templateId:"-100"`；一口价→`supportFreight+postPriceInCent+templateId:"0"`；无需邮寄→`templateId:"0"`。**已知 bug：`can_self_pickup` 写成 `data["onlyTakeSelf"]` 而非 `itemPostFeeDTO.onlyTakeSelf`（`:684-685`），自提实际不生效。**
- 类目/属性靠预测接口自动填：`get_public_channel()`（`goofish_apis.py:459-528`）打 `mtop.taobao.kgraph.property.recommend` v2.0（标题+图片→类目属性预测），遍历 `cardList[*].cardData.valuesList` 取 `isClicked` 项塞 `itemLabelExtList{...from:"newPublishChoice",properties:"propertyId##propertyName:channelCatId##catName"}`（`:693-717`），`itemCatDTO` 取 `categoryPredictResult`（`:719-724`）。
- 地址：`get_default_location()`（`:530-575`）打 `mtop.taobao.idle.local.poi.get`，**经纬度硬编码南京 118.78248347393424,31.91629189813543**，取 `data.commonAddresses[0]` 组 `itemAddrDTO{area,city,divisionId,gps:"经度,纬度",poiId,poiName,prov}`（`:726-735`）。
- 收尾：`json.dumps(data,separators=(',',':'))` → 签名（`:737-743`）→ POST。**`uniqueCode` 硬编码 `"1775897582791680"`（`:639`）：重复发布固定唯一码有被判重复/去重风险，自研时必须每次生成。**

### 1.4 IM WebSocket 协议（`wss://wss-goofish.dingtalk.com/`，`goofish_live.py:18`）
- 连接：`websockets.connect(base_url, extra_headers={Cookie 全串, Host, Connection:Upgrade, Origin:https://www.goofish.com, UA Chrome/133})`（`:257-270`）。**注意 `extra_headers` 是 websockets<14 的 API，14+ 要改 `additional_headers`；Node 侧 `ws` 用 `headers` 选项即可。**
- 注册 `/reg`（`:200-220`）：headers `{cache-header:"app-key token ua wv", app-key:"444e9908a51d1cb236a27862abc769c9", token:accessToken, ua:"...DingTalk(2.1.5) OS(Windows/10) Browser(Chrome/133)...", dt:"j", wv:"im:3,au:3,sy:6", sync:"0,0;0;0;", did:device_id, mid:generate_mid()}`；紧接 `/r/SyncStatus/ackDiff`（topic=sync、tooLong2Tag:"PNM,1"、pts=ms*1000、seq:0，`:221-238`）。
- 保活：`{"lwp":"/!"}` 每 15s（`:241-250`）；**每条下行消息必须立即回 ack `{code:200, headers:{mid,sid,app-key,ua,dt}}`（`:276-289`），否则被踢**。
- 收消息：`body.syncPushPackage.data[0].data` 先 `json.loads`，失败则 `decrypt()`（base64 → protobuf，走 JS blackboxprotobuf）得数字键 dict：`message["1"]["10"]["reminderTitle"]`(昵称)/`["senderUserId"]`/`["reminderContent"]`(文本)，`cid = message["1"]["2"].split('@')[0]`（`goofish_live.py:293-323`）。
- 发消息 `/r/MessageSend/sendByReceiverScope`（`:126-198`）：`body[0]={uuid, cid:"<cid>@goofish", conversationType:1, content:{contentType:101, custom:{type:1|2, data:base64(json)}}, redPointPolicy:0, extension:{extJson:"{}"}, ctx:{appVersion:"1.0",platform:"web"}, mtags:{}, msgReadStatusSetting:1}`，`body[1]={actualReceivers:["<toid>@goofish","<myid>@goofish"]}`；文本 payload `{contentType:1,text:{text}}`，图片 `{contentType:2,image:{pics:[{type:0,url,width,height}]}}`（`:164-190`）。
- 会话与历史：`/r/SingleChatConversation/create`（`:103-124`，`bizType:"1"`，`extension:{itemId}` 绑定商品）；`/r/MessageManager/listUserMessages`（`:26-101`）`body=["<cid>@goofish", false, 9007199254740991, 20, false]`，`hasMore` 时用 `nextCursor` 换 `body[2]` 翻页；收到 `lwp=="/s/vulcan"` 需重发历史请求（`:75-76`）。

## 2. xian-guanjia（官方开放平台 SDK，**MIT，可复用**）
- 形态：仅 5 个文件——`LICENSE`(MIT)、`README.md`(148)、`SKILL.md`(136)、`references/api-docs.md`(121)、`scripts/xian_guanjia.py`(447，无依赖单文件客户端)。
- 入口：`scripts/xian_guanjia.py:14-32` `XianGuanjiaClient(app_id, app_secret, mch_id, mch_secret, base_url="https://open.goofish.pro")`。
- **鉴权签名**（`:34-59`）：`timestamp=int(time.time())`；`body_str = json.dumps(body, separators=(',',':'))`（无 body 用 `"{}"`）；`bodyMd5=md5(body_str)`；`sign_str = f"{app_id},{app_secret},{bodyMd5},{timestamp},{mch_id},{mch_secret}"`；`sign=md5(sign_str)`。文档样例与实现一致（`references/api-docs.md:71-99`：`body={"goods_type":1,"goods_no":"12344532"}` → `bodyMd5=9b8030f5097d5ed123405b003dd247c5` → `sign=fda5954f48ab32b3b271c84450440ead`）。
- 请求：`request()`（`:61-93`）统一 POST，headers `{Content-Type:application/json, X-App-Id, X-Mch-Id, X-Timestamp, X-Sign}`（`:87` 处塞 X-Sign），30s 超时，响应 `{code,msg,data}`，**`code===0` 才算成功**。→ Node/TS 移植 30 行内可完成。
- 商品接口（全 POST，`:104-278`）：`/api/product/categories`(`:115`)、`/api/product/attributes{category_id}`(`:127`)、`/api/product/list{page,page_size,status(1上架/2下架)}`(`:149`)、`/api/product/detail{product_id}`(`:161`)、`/api/product/skus{product_id}`(`:175`)、**`/api/product/create`（`data` 原样直传，`:189`）**、`/api/product/create_batch{products:[]}`(`:201`)、**`/api/product/publish{product_id}`(`:215`)**、`/api/product/unpublish`(`:229`)、`/api/product/update{product_id,...}`(`:246`)、`/api/product/update_stock{product_id,stock,sku_id?}`(`:266`)、`/api/product/delete{product_id}`(`:278`)。
- 店铺/订单/物流（`:104, :302-410`）：`/api/user/shops`(`:104`)、`/api/order/list{page,page_size,status}`(`:302`)、`/api/order/detail{order_id}`(`:314`)、`/api/order/cards{order_id}`(虚拟卡密，`:328`)、`/api/order/ship{order_id,logistics_no,logistics_company}`(`:344`)、`/api/order/update_price{order_id,price}`(`:361`)、**`/api/order/place{goods_no,goods_type(1普通/2虚拟),buyer_nick,buyer_id,order_no,price}`(`:382`)**（代下单/刷单接口，风控红线，慎用）、`/api/logistics/companies`(`:401`)、`/api/mch/balance`(`:410`)。
- 回调三类（`references/api-docs.md:35-38`）：商品回调 / 商品推送 / 订单推送；需在发布或编辑商品请求里带真实推送地址，或在开放平台后台配置。
- 错误码（`references/api-docs.md:101-121`）：0 成功 / 1 请求错误 / 401 签名错误 / 403 IP 不在白名单 / 408 时间戳过期 / 500 系统异常 / 1000 商户不存在 / 1001 商户不可用 / 1002 余额不足 / 1100 商品不存在 / 1101 商品不可用 / 1102 库存不足 / 1200 订单不存在 / 1201 下单参数错误 / 1202 下单金额低于成本价 / 1203 管家订单号已存在 / 1209 下单超时需查单。
- ⚠️ 缺口：仓库 `references/api-docs.md` **没有** `create`/`publish` 的请求体字段、图片规格、限流 QPS，只有路径列表 + 外链。完整文档在 `README.md:140` 的 llms.txt（`https://s.apifox.cn/3ac13d69-5a38-4536-ae9b-a54001854ef8/llms.txt`，可被 agent 直接抓取）→ 下一步必做。

## 3. XY-Agent（DrissionPage 网页 RPA，无 LICENSE）
- 形态：customtkinter 桌面应用，唯一入口 `src/main.py:34-63`（`load_config()` → `XianyuRPAApp(...).run()`），非 CLI/服务；`src/services/` 下 product_service（上架主流程，1700+ 行）、browser_service、captcha_login_service、product_dedup、forbidden_words、knowledge_base(ChromaDB+BGE)。
- 浏览器：DrissionPage `ChromiumOptions.set_local_port()` 接已开调试端口的真实 Chrome（`src/services/browser_service.py:63-64`），按实例隔离 `user_data_dir`（`:67-71`），硬编码 chrome/edge 路径（`:73-97`），CDP 就绪靠轮询 `http://127.0.0.1:PORT/json/version`（`:117-128`），失败则 `subprocess.Popen` 拉 `--remote-debugging-port --user-data-dir --no-first-run --no-default-browser-check`（`:163-169`）。
- **反检测：几乎没有**。grep 全仓 `webdriver`/`navigator` 命中 0，无 stealth 注入、无 UA 覆盖、无指纹改写 —— 完全靠「真实 Chrome + 持久化 profile + 人工扫码 + 随机延时」。这是网页路线的真实成本基线：不碰指纹，只降频。
- Cookie 复用：`data/cookies.json`（`:45`），`page.cookies()` 整份 dump（`:758-765`），`page.set.cookies()` 逐个写回（`:767-812`）；登录态判定 = cookies 里 `['unb','cookie2','sg','_m_h5_tk']` 命中 ≥2（`:222-226`、`:260-264`）；多实例共享同一 cookie 文件。
- 登录：`ensure_login()`（`:327-404`）默认 `config.login.manual=true` → `wait_for_manual_login(timeout=180s)` 轮询并保存 cookie（`:300-325`）；`manual=false` 才走短信验证码（`captcha_login_service.py:93-163` 六步，验证码从 **n8n webhook** 轮询，3s/次、300s 超时、基线去重）→ 密码兜底。**全仓无自动滑块/打码**：滑块只作为失败原因字符串出现（`captcha_login_service.py:469` "可能原因: 验证码过期/错误, 滑块验证, 账号异常"），失败走飞书 webhook 通知（`:79-91`）。
- 上架六步（`src/services/product_service.py:1724-1826`）：① `navigate_to_publish()` ② 传图 `:1122-1225`（找 `text:添加首图` 或 `css:[class*="upload"]`，向上 6 级父节点找 `input[type=file]`，`file_input.input(paths)`，失败回退 `"\n".join`，轮询 ≤20×0.5s 等预览）③ 描述（`USER_XPATHS['publish']['desc_input']` 绝对 XPath，失败回 `fill_description` 三策略 `:1426-1570`）④ 分类+计价 `:1634-1669`（点 `text:请选择计价方式`，再依次试 `元/次`、`元/单`、`元/小时`、`元/份`）⑤ 价格 `page.eles('xpath://input[@placeholder="0.00"]')` 取 `[0]`价格 `[1]`原价 `[2]`运费（`:1757-1774`，缺价用 `default_price=9.9` 兜底）+ 包邮 + 地址 `:1671-1722`（点 `address--` 容器 → `搜索地点` 输入 `广州大学城` → 点 `auto-item` 命中项）⑥ 提交 `button[contains(@class,"publish-button")]`，成功判定 = 10s 内 URL 含 `goofish.com/item` 或出现 `发布成功`（`:1807-1819`）。
- 维护风险：`USER_XPATHS` 全是 `/html/body/div[2]/...` 绝对 XPath（`:81-134`），与仓内 `AGENTS.md`「优先文字/属性定位」自相矛盾；类目白名单只允许服务类 10 项（`:138-149`）；`check_unsupported_category_warning()`（`:1227-1253`）明确检测「网页版暂不支持发布此分类 / 请使用闲鱼APP扫码继续发布」→ **部分类目天生走不了网页**。另有 `clear_uploaded_images` 重复定义（`:1009` 与 `:1071`）。
- 节奏参数（可直接作为 daemon 默认值）：消息轮询 12s、登录态检查 300s（`src/config.example.json:13-16`，apscheduler `IntervalTrigger`，`src/scheduler/task_scheduler.py:23-59`）；回复随机延迟 2-6s；步间 `_random_delay()` = `uniform(1,3)`（`product_service.py:240-243`）；搜索页逐字输入 0.1-0.3s/字、结果等 3-5s。
- 可借鉴的业务护栏：去重（`product_dedup.py:64-78` URL 去重；`:80-124` 字符 bigram Jaccard ≥0.85 判重；`published_records.json` 落盘）；违禁词（`forbidden_words.py:23-30` 硬词表 + `:33-40` 替换表 + `:52-83` 子串检查 + 图片 OCR 走豆包视觉，`:175-230`）。

## 4. 结论：对我们的 DSH 插件 + 本地 daemon（TS/Node）
1. **三条通道分级**：官方开放平台（`xian-guanjia`，MIT，合规首选，做发布/改价/订单）> 浏览器 CDP 自动化（XY-Agent 思路，零指纹改造、靠真 Chrome profile，做官方未开放的类目与客服）> mtop 裸逆向（XianYuApis，不可抄代码、依赖 tfstk 反爬 SDK，仅作兜底）。
2. **daemon 底座**：Node 常驻进程持 `ws`（IM）+ 一个 Chromium（CDP `/json/version` 探活，`--remote-debugging-port` + 独立 `--user-data-dir`）复刻 XY-Agent 的「profile + 扫码一次 + cookie 落盘 `.goofish.com`」；登录态判定直接用 cookie 名集合 `unb/cookie2/sg/_m_h5_tk` 计数 ≥2。
3. **签名全部可纯 Node 实现**：mtop = md5(token&t&34839810&data)（`static/goofish_js_version_2.js:19-26`），开放平台 = md5(appId,appSecret,md5(body),ts,mchId,mchSecret)（`scripts/xian_guanjia.py:34-59`）—— 两处都无需 execjs/子进程。
4. **tfstk 不要自己补环境**：从用户已登录浏览器的 cookie 读取即可（浏览器通道天然持有），仅在纯 HTTP 通道才需 `gen_tfstk.js` 那套 vm+Proxy 沙箱（成本高、易随 SDK 更新失效）。
5. **IM 协议可独立于浏览器**：只需一次扫码拿 `unb`+`_m_h5_tk` → `get_token()` 拿 accessToken → `wss` `/reg`；必须做三件事：15s ping、每条消息回 ack、600s refresh_token，否则掉线。
6. **默认节奏**：IM 轮询 12s、登录检查 300s、动作间随机 1-3s、发布前做「URL + 文本 Jaccard 0.85」去重、发布间隔 ≥60s（三仓库均无显式限流代码，只能保守自定，YAML 可配）。
7. **硬约束**：`uniqueCode` 每次必须新生成（`goofish_apis.py:639` 硬编码是反面教材）；网页发布类目受限（服务类白名单 + APP-only 类目）；`onlyTakeSelf` 层级 bug 提醒我们自研时按真实抓包校验字段层级而非照抄。
8. **待办（本次未完成）**：抓 `https://s.apifox.cn/3ac13d69-5a38-4536-ae9b-a54001854ef8/llms.txt` 补 `product/create`+`publish` 请求体字段、图片规格、QPS 限额；`XianYuApis`/`XY-Agent` 无 LICENSE，任何代码复制前须获授权，否则只能按本文档的事实要点自研。
