# 闲鱼 IM 协议事实（P1.1 资产）

> 目标：把研究阶段从三个开源实现里读出的闲鱼 IM（钉钉 lwp 长连接）协议事实，沉淀成 P2 的 reply / deliver 执行器可以直接照做的规格。
> 依据：`research/notes/B-im.md`（三仓只读分析，逐条带 file:line）；行号已用归档源码 `research/tmp/xianyu-*.tgz`（内存解压、只读）二次核对，仓库前缀写作 `<repo>/<相对路径>`。
> 边界：只记录协议事实与我们自己的流程设计，**不含任何 GPL/AGPL 源码片段**。三仓全部 copyleft（见 `research/notes/B-im.md:88-91`）——协议事实不受版权保护可独立重写，但注释、轨迹 JSON、prompt 文案一律不搬。

## 0. 概览

连接期只有三步：**取 IM token → ws 握手并注册 → 提交同步游标**；之后是两条并行循环：15s 心跳、收帧即 ACK。业务帧全是明文 JSON 文本帧，只有推送包的 `data` 字段可能是 base64(JSON) 或 base64(MessagePack)。

```
mtop idlemessage.pc.login.token ──► accessToken (+Set-Cookie)
        ▼
wss://wss-goofish.dingtalk.com ── /reg ──► sleep 1s ──► /r/SyncStatus/ackDiff
        ▼
loop{ 15s /! 心跳 ；每条下行先 ACK 再入队 ；业务帧 }
```

三条不变量（后面所有小节都在展开）：**① ACK 与业务解耦**（先 ACK 再处理）；**② token 一次性**（只在 `/reg` 头用一次，换 token 必须重连重注册）；**③ 两套 token / 两个 appKey**（HTTP mtop 用 `_m_h5_tk` + `34839810`；IM 用 accessToken + `444e9908a51d1cb236a27862abc769c9`，混用是最常见 401 来源）。

## 1. 连接与注册

### 1.1 端点与握手

| 项 | 值 | 出处 |
|---|---|---|
| 地址 | `wss://wss-goofish.dingtalk.com`（AR 可用 `WEBSOCKET_URL` 覆盖，测试用） | XianyuAutoAgent/main.py:615-627；xianyu-auto-reply/websocket/app/services/xianyu/xianyu_async.py:33；xianyu-super-butler/app/config.py:97 |
| 握手头 | 全量 cookie + 浏览器 UA + `Origin: https://www.goofish.com` | xianyu-super-butler/XianyuAutoAsync.py（connect 段） |
| 库层参数 | `ping_interval=20`、`ping_timeout=15`、`open_timeout=30` | xianyu-auto-reply/.../connection_manager.py:197-215（注释：默认 10s 会把 TLS 抖动误判成 token 失效并触发人脸验证） |

### 1.2 `/reg`：唯一的"登录一次"动作

纯文本 JSON，**没有 body 字段**，只有 headers：

```json
{"lwp":"/reg","headers":{"cache-header":"app-key token ua wv",
 "app-key":"444e9908a51d1cb236a27862abc769c9","token":"<accessToken>",
 "ua":"Mozilla/5.0 ... Chrome/133.0.0.0 Safari/537.36 DingTalk(2.1.5) OS(Windows/10)
       Browser(Chrome/133.0.0.0) DingWeb/2.1.5 IMPaaS DingWeb/2.1.5",
 "dt":"j","wv":"im:3,au:3,sy:6","sync":"0,0;0;0;","did":"<device_id>","mid":"<generate_mid()>"}}
```

| header | 含义 | 取值来源 |
|---|---|---|
| `cache-header` | 声明哪些头参与缓存键 | 固定 `"app-key token ua wv"` |
| `app-key` | IM 应用 key（≠ mtop appKey） | 固定 `444e9908a51d1cb236a27862abc769c9` |
| `token` | IM accessToken | §1.3 的 `data.accessToken` |
| `ua` | 伪装钉钉桌面端 | 固定串，含 `DingTalk(2.1.5)` / `DingWeb/2.1.5`；改它会改指纹，照抄 |
| `dt` / `wv` / `sync` | 客户端能力声明 | 固定 `"j"` / `"im:3,au:3,sy:6"` / `"0,0;0;0;"` |
| `did` | 设备 id，账号维度稳定 | `generate_device_id(user_id)` 派生并持久化（xianyu-super-butler/utils/xianyu_utils.py:115） |
| `mid` | 消息 id，用于回显关联 | 每次发帧新生成 |

完整形态见 xianyu-super-butler/XianyuAutoAsync.py:6869-6884；AR 同构实现见 xianyu-auto-reply/.../xianyu_async.py:588-601 与 backend-web/app/services/chat_new/im_client.py:893。

### 1.3 IM accessToken 的来源接口

`POST https://h5api.m.goofish.com/h5/mtop.taobao.idlemessage.pc.login.token/1.0/`（xianyu-super-butler/XianyuAutoAsync.py:2167 处拼 URL）

- 走**普通 mtop 签名**（§1.4），请求体是表单字段 `data`，值为**紧凑 JSON 字符串**：`{"appKey":"444e9908a51d1cb236a27862abc769c9","deviceId":"<device_id>"}`（:999，用 `json.dumps(..., separators=(",",":"))` 生成，不能有空格）。
- 额外参数：`api=mtop.taobao.idlemessage.pc.login.token`、`sessionOption=AutoLoginOnly`、`accountSite=xianyu`、`smToken=<_m_h5_tk token>`、`queryToken=sm`、`sm=sm`、`spm_cnt=a21ybx.im.0.0`。
- 成功判定：`ret` 含 `SUCCESS::调用成功` 且 `data.accessToken` 非空。
- **同一响应常下发 `Set-Cookie`**：必须解析合并回 cookie jar 并落库，否则下次签名用的 `_m_h5_tk` 是旧的（刷新会换 cookie）。
- 被风控时 `data.url` 存在、`accessToken` 不存在，该 url 是惩罚页（§5.2），不是错误码。普通 mtop 侧也用它取 IM token（xianyu-super-butler/utils/manual_captcha.py:97；xianyu-auto-reply/common/services/im_token_api.py）。

### 1.4 mtop 签名（所有 mtop 接口共用）

| 项 | 值 |
|---|---|
| URL | `https://h5api.m.goofish.com/h5/<api>/<ver>/` |
| 固定参数 | `jsv=2.7.2`、`appKey=34839810`、`v=1.0`、`type=originaljson`、`dataType=json`、`sessionOption=AutoLoginOnly`（XianyuAutoAgent/XianyuApis.py:152-171） |
| sign | `md5(token + "&" + t + "&" + appKey + "&" + data)`，`t`=毫秒时间戳，`token`=`_m_h5_tk` 的 `_` 前段（XianyuAutoAgent/utils/xianyu_utils.py:61-69；XianyuApis.py:189,284） |
| 失败返回 | `FAIL_SYS_TOKEN_*` / `FAIL_SYS_SESSION_EXPIRED` / `FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR`（§4、§5） |

### 1.5 注册后的第一帧：ackDiff

注册成功后 `sleep(1)` 再发 `lwp:"/r/SyncStatus/ackDiff"`，body 是单元素数组，`pipeline/channel/topic` 均 `sync`、`tooLong2Tag:"PNM,1"`、`highPts:0`、`pts: now_ms*1000`、`seq:0`、`timestamp: now_s`（xianyu-super-butler/XianyuAutoAsync.py:6885-6902；xianyu-auto-reply/.../xianyu_async.py:606-623）。`pts` 是"从哪个同步点开始收"的游标（**推断**，见 §8）；照抄其量纲，不要"优化"成秒。

## 2. 保活与 ACK

**2.1 应用层心跳**：`{"lwp":"/!","headers":{"mid":"<generate_mid()>"}}`，间隔 **15s**（xianyu-auto-reply/.../xianyu_async.py:34 `HEARTBEAT_INTERVAL=15`，超时 30s 在 :35；xianyu-super-butler/app/config.py:98-99）。发送必须带超时：SB 用 `asyncio.wait_for(send, timeout=2.0)`，超时即判连接已死（xianyu-super-butler/XianyuAutoAsync.py:6905-6926，异常文案在 :6923）。它与库层 ping（§1.1）是**双保险**：库层 ping 看不见 NAT 静默丢链，应用层心跳看不见 TLS 半开连接堆积。

**2.2 每条下行必须回 ACK**：服务端按"未被确认"判定客户端卡死，**漏回会被断连**（research/notes/B-im.md:26）。帧为 `{"code":200,"headers":{"mid":"<下行 headers.mid 原样>","sid":"<下行 headers.sid 原样>"}}`；下行若带 `app-key` / `ua` / `dt` 也原样回填（xianyu-super-butler/XianyuAutoAsync.py:9830-9845；xianyu-auto-reply/.../message_handler.py:573-598；XianyuAutoAgent/main.py:655-667）。`handle_message`（SB :9823）**第一件事就是 ACK**，之后才判 `is_sync_package`（:9853）；ACK 段自身 try/except 包住，解析异常不能把 ACK 一起吞掉。对我们：**解码→ACK→入队** 三步内联完成，AI/落库/发送全交队列，否则一次 LLM 调用就能拖死连接。

**2.3 mid 关联的请求/响应**：服务端把请求 `mid` 回显在响应帧 `headers.mid`，可做 Promise 表。xianyu-super-butler/XianyuAutoAsync.py:6745 `_send_im_request(lwp, body, timeout=15)`：发帧前生成 mid、`_im_pending[mid]=future`（:6732-6740），收帧按 mid set_result，超时/断连统一 fail 所有 pending（:6766-6774）。断连报错区分两态：已注册但风控中 → "闲鱼要求人机验证，账号暂停请求中"（映射 `RISK_CONTROL`）；未连接 → "账号尚未连接闲鱼消息服务"（映射 `NETWORK`）。推送帧与响应帧同通道，靠"是否命中 pending mid"分流，未命中一律当推送。

## 3. 收发

### 3.1 发消息：`/r/MessageSend/sendByReceiverScope`

```json
{"lwp":"/r/MessageSend/sendByReceiverScope","headers":{"mid":"<generate_mid()>"},"body":[
 {"uuid":"<uuid4>","cid":"<chat_id>@goofish","conversationType":1,
  "content":{"contentType":101,"custom":{"type":1,"data":"<base64(JSON{contentType:1,text:{text}})>"}},
  "redPointPolicy":0,"extension":{"extJson":"{}"},
  "ctx":{"appVersion":"1.0","platform":"web"},"msgReadStatusSetting":1},
 {"actualReceivers":["<peer_id>@goofish","<my_id>@goofish"]}]}
```

| 字段 | 规则 |
|---|---|
| `cid` | 会话 id，**必须带 `@goofish` 后缀**；裸 id 来自推送包 `message["1"]["2"]` 或 `SingleChatConversation/create` 返回 |
| `content.custom.data` | 双层：内层 JSON `{"contentType":1,"text":{"text":"<正文>"}}` 先序列化再 base64；外层 `contentType:101` 表示自定义消息 |
| `uuid` | 客户端生成，服务端据此去重/定序（幂等键候选，见 §6.2） |
| `actualReceivers` | 自己与对端都要在列，否则消息不落自己会话列表 |
| `conversationType` | 单聊固定 `1` |
| `ctx` / `redPointPolicy` / `msgReadStatusSetting` / `extension.extJson` | 照抄：web 端标识 / 红点策略 0 / 已读设置 1 / 扩展空对象 |

出处：xianyu-super-butler/XianyuAutoAsync.py:6676（组帧）、:6685（sendByReceiverScope）、:6701（redPointPolicy）、:6703（extJson）；XianyuAutoAgent/main.py:112-156；xianyu-auto-reply/.../xianyu_async.py:2008、:2769。

### 3.2 建会话：`/r/SingleChatConversation/create`

首次给某买家/商品发消息前先建会话拿 `cid`，body[0] 为 `{"pairFirst":"<peer_id>@goofish","pairSecond":"<my_id>@goofish","bizType":"1","extension":{"itemId":"<item_id>"},"ctx":{"appVersion":"1.0","platform":"web"}}`（xianyu-super-butler/XianyuAutoAsync.py:6655）。注意 `bizType` 是**字符串** `"1"` 且带 `extension.itemId`——同一对买卖家不同商品是不同会话。

### 3.3 下行解码顺序（必须按此顺序）

推送帧真正内容在 `body.syncPushPackage.data[*].data`（字符串）：

1. `base64 → utf8 → JSON.parse` 成功就用（**明文优先**，实时推送多数是明文）；
2. 失败（非法 JSON / 二进制）才 `base64 → MessagePack decode`。SB/AR 的 `decrypt()` 即"ascii 清理 → base64 补 padding → 标准 msgpack"（XianyuAutoAgent/utils/xianyu_utils.py:287-335 + 自写 decoder :72-284；xianyu-super-butler/utils/xianyu_utils.py:358-399 + :151-355）；
3. 解出的对象若含 `chatType` → **系统提示消息，直接丢弃**（xianyu-auto-reply/backend-web/app/services/chat_new/push_message_parser.py:53-54）。

对 Node：第 2 步用 `@msgpack/msgpack`（标准 msgpack），不要移植那份纯 Python decoder。

### 3.4 解密后的三种消息形态

判定顺序见 xianyu-auto-reply/backend-web/app/services/chat_new/push_message_parser.py:62-90：

| 形态 | 判定条件 | 文本位置 | 发送者 |
|---|---|---|---|
| 标准聊天 | `msg["1"]` 是对象且 `msg["1"]["10"]["reminderContent"]` 非空 | `msg["1"]["6"]["3"]["5"]`（明文 JSON 串；旧格式在 `["1"]`，base64） | `msg["1"]["10"]["senderUserId"]`（去 `@goofish`） |
| 卡片消息 | `msg["1"]["6"]["3"]` 存在 | `msg["1"]["6"]["3"]["2"]` | `msg["1"]["1"]["1"]` |
| 卡片更新 | `msg["1"]` 是字符串且 `msg["4"]["reminderContent"]` 存在 | `msg["4"]["reminderContent"]` | `msg["4"]["senderUserId"]` |

公共信封（标准聊天，:94-141）：`["1"]["2"]`=`cid`（去 `@`）、`["1"]["5"]`=毫秒时间戳、`["1"]["3"]`=`messageId`、`["1"]["10"]["reminderTitle"]` 可兜底当昵称。交易状态不靠猜文本，靠 `message["3"]["redReminder"]` 枚举：`等待买家付款` / `交易成功`（等待卖家发货）/ `交易关闭`（XianyuAutoAgent/main.py:409-451；xianyu-super-butler/XianyuAutoAsync.py:10048-10060 用它触发发货）。**deliver 执行器应以该字段为准，不要正则匹配文案。**

**3.5 去重与过滤**：按 `messageId` 去重（xianyu-auto-reply/.../message_handler.py:644-649），落库加唯一键（§6.2）；丢弃 `is_system_tip_message`（:110）与 `bizType=='IDLE_SPACE_PRICING'` 这类非聊天业务包（:602-638）；`isSelf` 用 `senderUserId == my_id`（去后缀后比较），自己发出的消息也会被推回来，不排除会导致 AI 自问自答。

## 4. 错误与恢复

### 4.1 两类过期必须分开处置

| 错误 | 语义 | 处置 | 出处 |
|---|---|---|---|
| `FAIL_SYS_TOKEN_EXOIRED` / `FAIL_SYS_TOKEN_EXPIRED`（原文含拼写错误） | mtop 签名 token（`_m_h5_tk`）过期 | 可恢复：响应一般自带 `Set-Cookie`，合并 cookie、重签重试，不必重登 | xianyu-super-butler/XianyuAutoAsync.py:2412-2462 |
| `FAIL_SYS_SESSION_EXPIRED` | 登录态失效 | 只能重新登录（人工/扫码），不能重试掩盖 | 同上 |

### 4.2 换 token / 互踢 / 重连

- **换 token = 重连重注册**：AR `_reconnect_with_new_token()` 先刷新 token，**拿不到新 token 就不动现有连接**（xianyu-auto-reply/.../xianyu_async.py:2417-2458）。
- **同账号多端在线会互踢**（research/notes/B-im.md:37）；一账号只允许一个 ws，且必须确认旧连接彻底关闭再建新连接（半关闭会让服务端保留旧会话，表现为新连接被踢）。
- 重连后**必须重新 `/reg` + `ackDiff`**，不能复用注册状态；`pts` 按"已处理最大时间点"重算，否则重复收或漏收。

### 4.3 建议的状态机（P2 落地）

| 状态 | 进入条件 | 动作 | 退出到 |
|---|---|---|---|
| `valid` | 收到 ACK/业务帧 | 正常收发 | `expiring` / `challenge` / `disconnected` |
| `expiring` | token 剩余 < 1h（AR 续期任务即扫此窗口） | 后台刷新 token，成功后标记待重连 | `valid` |
| `challenge` | 命中 `FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR` / 拿到 punish url | 停一切写请求，等人工（§5） | `valid`（补 cookie 后） |
| `disconnected` | 心跳失败 / 收到 close | 指数退避重连，**禁止并发重连** | `valid` |
| `relogin` | `FAIL_SYS_SESSION_EXPIRED` | 拒绝自动重试，上报需扫码 | `valid`（重新导入登录态后） |

退避 `min(60 * 2^(n-1), 1800)` 秒（xianyu-super-butler/XianyuAutoAsync.py:546-567）；熔断冷却 300s→600s（:2350-2359）。

## 5. 风控联动（施工注意，不是"过滑块"教程）

**5.1 cookie 才是通行证**：只有 `x5sec` 是通行凭证，`x5secdata` / `x5sectag` / `x5step` 是挑战标记；拿到 `x5sec` 后**必须删旧挑战 cookie**，否则 token 刷新永远 `FAIL_SYS_USER_VALIDATE`（xianyu-super-butler/XianyuAutoAsync.py:2636-2690；清理函数 `drop_stale_captcha_challenge` 在 xianyu-super-butler/utils/xianyu_utils.py:72-92）。判定"已通过"的唯一标准是 cookie 里有 `x5sec`（`_has_x5sec`，xianyu-auto-reply/common/services/captcha/drissionpage_slider.py:242），不是页面文案、不是 HTTP 200。

**5.2 惩罚 URL 的来源**：`mtop.taobao.idlemessage.pc.login.token` 被风控时 `data.url` 返回 `.../_____tmd_____/punish?x5secdata=...&x5step=2&action=captcha&pureCaptcha=`，有效期约 1 小时；**只有真的导航到这个 URL 才会弹滑块**（xianyu-super-butler/utils/manual_captcha.py:33-42、:70-141；该 url 被写进 `risk_control_logs.event_description`，见 :37 注释）。正常账号该接口只返回 `accessToken`，不存在 `url`。

**5.3 冷却与特征串**：风控特征串 `RGV587_ERROR` / `FAIL_SYS_USER_VALIDATE` / `哎哟喂` / `被挤爆` / `FAIL_SYS_FLOW_LIMIT` / `请稍后重试`（xianyu-super-butler/XianyuAutoAsync.py:531-538），命中即进 `challenge` 不重试。冷却必须**账号级持久化**（进程重启不清零），trip 期间不发任何写请求（心跳除外）。我们不做"自动过滑块"：三仓最深的两份实现一致指向行为特征识别（xianyu-super-butler/utils/manual_captcha.py:1-13 明写"误差 0.3px 内仍判失败，拦的是行为特征"；AR 结论是 Playwright/CDP 注入被 `PointerEvent.getCoalescedEvents()` 子事件密度识别，`code=300`，只有物理输入 `SendInput` 得 `code=0`）。P2 正确抽象是 **`ChallengeEvent` + 本地有头浏览器 helper + 人工确认后回填 cookie**（research/notes/B-im.md:63-66、:98）。

## 6. P2 落地建议（只给契约，不写实现）

### 6.1 消息落库表（建议）

| 表 | 关键列 | 说明 |
|---|---|---|
| `im_messages` | `account_id`,`message_id`,`cid`,`item_id`,`peer_id`,`direction`(in/out),`chat_time_ms`,`kind`,`text`,`raw_json`,`received_at_ms` | `(account_id,message_id)` 唯一；`chat_time_ms` 用服务端毫秒；`raw_json` 脱敏后存原文便于回放 |
| `im_conversations` | `account_id`,`cid`,`item_id`,`peer_id`,`last_msg_at_ms`,`unread`,`ai_mode` | 主键 `(account_id,cid)`；`ai_mode` 支持人工接管 |
| `reply_rules` | `id`,`account_id`,`scope`,`item_id`,`priority`,`match_kind`,`pattern`,`action`,`template`,`delay_ms`,`enabled` | 规则引擎输入；`priority` 决定首命中 |
| `reply_logs` | `dedupe_key`,`rule_id`,`message_id`,`tokens`,`cost_cent`,`result`,`created_at_ms` | 幂等 + 成本审计 |
| `risk_events` | `account_id`,`kind`,`code`,`punish_url`,`cooldown_until_ms`,`created_at_ms` | 冷却期持久化，重启不清零 |

### 6.2 幂等键

- 入站 `im:<accountId>:<messageId>`：服务端 messageId 天然唯一，落库唯一约束 + 队列 payload 携带同一 dedupeKey。
- 出站 `out:<accountId>:<uuid>`：uuid 生成后即落库，重试前先查库，**绝不重新生成 uuid 重发**（AGENTS.md 不变量 2）。
- 发送前二次校验 `(accountId,cid,textHash)` 近 60s 内是否已发，防"ACK 丢失→重发"造成双发。

### 6.3 自动回复规则引擎接口（建议签名）

| 接口 | 入参 | 出参 | 语义 |
|---|---|---|---|
| `decide(input)` | `{accountId, cid, item, peer, history, message}` | `{kind:"reply"\|"ignore"\|"handoff"\|"escalate", text?, ruleId, delayMs, reason}` | 纯函数；`ignore` 覆盖系统提示/自消息/风控中 |
| `match(rule, message)` | 规则 + 消息 | `boolean` | 关键词/正则，按 `priority` 首命中 |
| `render(template, ctx)` | 模板 + 变量 | `string` | 只做变量替换，不调 LLM |
| `compose(input)` | 同 `decide` | `string` | **只有需模型判断时才走这里**，由插件/agent 生成文本，daemon 只发送与限流（不变量 1：daemon 不调 LLM） |

### 6.4 节奏（照抄可用的数值）

| 动作 | 节奏 | 出处 |
|---|---|---|
| 应用层心跳 | 15s（发送超时 2s） | xianyu-auto-reply/.../xianyu_async.py:34；xianyu-super-butler/app/config.py:98-99 |
| ACK | 每帧立即，不排队 | §2.2 |
| token 续期 | 扫描"1 小时内到期"账号 | xianyu-auto-reply/scheduler/**/token_renewal_task.py:1-11 |
| cookie 刷新 | 1200s（SB 注释写 3600，常量才是真的） | xianyu-super-butler/XianyuAutoAsync.py:801 |
| 擦亮 | 默认关闭，最短 1h（`max(3600, interval)`） | xianyu-super-butler/XianyuAutoAsync.py:7314-7325 |
| 评价 | 订单冷却 600s | xianyu-auto-reply/scheduler/**/rate_task.py:32-36 |
| 打字延迟 | `U(0,1)+len*U(0.1,0.3)`，上限 10s | XianyuAutoAgent/main.py:537-546 |
| 单账号写 | 串行，QPS ≤ 1（AGENTS.md 不变量 3） | — |

## 7. 参考实现索引

| 仓库 | 文件:行号 | 看什么 |
|---|---|---|
| xianyu-super-butler | XianyuAutoAsync.py:6655 | `SingleChatConversation/create` 完整 body |
| xianyu-super-butler | XianyuAutoAsync.py:6676-6703 | 发消息组帧（含 redPointPolicy / extJson） |
| xianyu-super-butler | XianyuAutoAsync.py:6745-6774 | mid 关联的请求/响应表 |
| xianyu-super-butler | XianyuAutoAsync.py:6869-6902 | `/reg` 全量 headers + ackDiff |
| xianyu-super-butler | XianyuAutoAsync.py:6905-6926 | 15s 心跳 + 发送超时 |
| xianyu-super-butler | XianyuAutoAsync.py:9823-9853 | handle_message 先 ACK、再判 sync 包 |
| xianyu-super-butler | utils/xianyu_utils.py:115 | device_id 派生 |
| xianyu-super-butler | utils/manual_captcha.py:33-42、70-141 | punish url 来源与有效期 |
| xianyu-auto-reply | websocket/.../xianyu_async.py:588-623 | /reg 与 ackDiff（与 SB 同构，可对照） |
| xianyu-auto-reply | websocket/.../message_handler.py:110、573-598、644-649 | ACK、系统消息过滤、messageId 去重 |
| xianyu-auto-reply | backend-web/.../push_message_parser.py:36-141 | 解码顺序 + 三种消息形态字段 |
| xianyu-auto-reply | backend-web/.../im_client.py:893 | 另一份 /reg 实现（chat_new 模块） |
| XianyuAutoAgent | main.py:112-156、615-667 | 发消息 / 连接 / ACK（最简可读） |
| XianyuAutoAgent | utils/xianyu_utils.py:61-69、287-335 | sign 公式、base64→msgpack 解码 |

## 8. 证据不足 / 待核（别当成已确认）

1. `ackDiff.pts` 精确语义（毫秒×1000 的同步游标）是**从三处实现一致推断**，无服务端文档；重连时能否用"已处理最大时间"回填未验证。
2. 推送包 `data` 明文/加密的**判定边界**只看到"try 明文、except 走 msgpack"双栈兜底（xianyu-auto-reply/.../push_message_parser.py:49-60），未知是否存在"像 JSON 但需解密"的边缘。
3. 服务端是否接受 **binary ws 帧**未验证；三仓全发文本帧，按其文本帧实现即可。
4. 限频/429 的**帧级表现**未观察到，只见错误码文案；P2 先按 `challenge` + 退避处理。
5. `is_sync_package` 之后的离线补发行为未实测；首注册时的历史消息洪峰需要限速消费。
6. 三仓心跳帧都不带业务字段；若服务端后续要求上报 `pts`，需重新核对。
