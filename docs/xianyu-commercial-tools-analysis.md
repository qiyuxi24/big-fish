# 两个闲鱼商业工具逆向分析（自动发货助手 v4.8.2 / 一键搬运助手 v2.1.9）

> 📦 历史调研快照（2026-10-20）。结论已并入 [STATUS.md](STATUS.md) 与 [architecture.md](architecture.md)，保留作证据；当前状态不必读本文。

> 对象：用户新加的两个 RAR，解压后位于 `research/repos/unpacked/`。
> 方法：**只读静态分析**（objdump / strings / python 解析 xlsx·txt·mp4·PE 资源）。**全程未运行任何 exe/dll**——两者均为未签名 + VMProtect 全加密的可疑分发版，运行有盗号/木马风险。
> 细节笔记（带偏移与复现命令）：[`research/notes/D-delivery.md`](../research/notes/D-delivery.md)（275 行）、[`research/notes/E-repost.md`](../research/notes/E-repost.md)（407 行）。
> 标注：✅ 证实（有静态证据）／🟡 推测（合理推断）／❓ 不可得（加密导致，需脱壳或运行）

---

## 0. 先纠正一个前提：这不是"同一个工具的两个版本"

| | A（v4.8.2） | B（v2.1.9） |
| --- | --- | --- |
| 产品名 | 闲鱼自动发货助手 | 闲鱼一键搬运助手 |
| 解决什么 | **虚拟商品/卡密自动发货**：买家付款或发消息后，自动把卡密/话术发过去 | **商品搬运铺货**：把商品（图文/价格/规格）从一个账号"搬"到另一个账号批量上架 |
| 形态 | 单窗口，内嵌 WebView2 | 仿 Chrome 多标签窗口，自带 341MB Chromium 内核 |
| 体积 | 100MB（其中 76MB 是教程视频） | 371MB（其中 341MB 是内核） |

两者是**两条不同产品线**，只是都出自"易语言 + VMProtect + 浏览器内嵌"这一套中国灰色工具生态。你说的"分别是不同的版本"，如果指的是"两款不同工具"，那对；如果以为它们是同一产品的两代，那不对。

---

## 1. 结论速览

1. **技术上都是"浏览器里跑 JS 的自动化"，不是接口直连**。两者都自带浏览器内核，用注入 JS / 拦截响应体的方式操作 goofish 页面——**正因为浏览器是真的，`_m_h5_tk` / `tfstk` / `x5sec` 全是页面自己生成的，它们根本不需要逆向签名算法**。这从侧面再次确认我们之前的技术判断：走真浏览器是最省事、最抗变更的路线。
2. **业务逻辑一律静态不可得**。两个 exe 都是 VMProtect **全节加密**（原始节 Size=0，整机载荷塞进乱码节），B 甚至做了量化验证：24MB 业务层里 `http://`/`https://`/`goofish`/`mtop`/`_m_h5_tk`/`x5sec` 等 9 个标记串**命中 0 次**，GBK 汉字对密度 10.4% ≈ 随机期望 10.3%。→ 想拿接口名/JS 片段只有两条路：脱壳或跑起来抓包，两者本任务都禁止。
3. **两者共同的产品逻辑值得抄**：能力拆成三层——登录态（浏览器 profile 里）｜规则/任务（用户可编辑的 xlsx/txt）｜记录（本地 SQLite）。界面极简，卖家零学习成本。
4. **对我们是"同路线、更老一代"的参照**：它们自建内核分发（B 的 Chromium 冻结在 131 / 2024-11，比工具自己编译时间 2026-05 落后 18 个月）；我们用 CDP 接管用户真 Chrome，内核永远最新、体积为零、协议标准化、可调试、合规干净——**路线级优势在我们这边**。
5. **但有两块必须补上**，否则打不过它们：① **一账号一 user_data_dir 的隔离与登录态快照**（它们做成了一等公民）；② **用网络响应拦截取数，而不是 DOM 抓数**（它们有 `ResourceInterceptor/ResponseBodyFilter`，免算签名、抗页面改版）。
6. **风险提示（重要）**：两个包都**未签名 + VMProtect 全加密 + 0 字节 data.db + 带 "C" 前缀**，高度疑似**破解/二次分发版**。"无法找到后门证据"≠"没有后门"（密文不可审计）。建议：不要在主账号电脑/主账号环境运行；要看功能，只当作产品参考，别当工具用。

---

## 2. A：自动发货助手 v4.8.2 怎么工作的

### 2.1 技术栈（✅ 硬证据）

- **易语言 5.x 静态编译，32 位 GUI**：版本资源 @`0xF79886` 明文写 `FileDescription=ProductName=易语言程序`、`Comments=本程序使用易语言编写(http://www.eyuyan.com)`；manifest @`0xF79AC0` `name="E.App" version="5.2.0.0"`；导入 17 个系统 DLL，其中 `MSVFW32!DrawDibDraw`、`WINMM!midiStreamRestart`、`RASAPI32` 是易语言运行库指纹。
- **VMProtect 全节加密**：`.text/.rdata/.data` 三节 `Size=0`、raw offset=0；节名乱码 `.j"^` / `.aWX` / `.?2m`；15.5MB 载荷在 `.?2m`；入口 `0x12e396a` → 文件偏移 `0x3c596a`，首字节是 `call + 变形算术`（VM 入口）；`0x40000` 起熵恒 `7.997`；**无 Authenticode 签名**。
- **静态字符串收获 = 0**：`strings -n 6` 得 24,537 行全噪声；UTF-16 只有 15 条（全在 `.rsrc`）。URL / mtop 接口 / 中文菜单 / SQL / JS **不可能**从静态文件拿到。
- **核心组件**：`edgeview.dll` / `edgeview_static.dll` = **EdgeView 2.1.12.0（Admenri，LGPL-2.1）**，易语言 WebView2 封装（PDB 路径 `D:\EdgeView-master\epltest\edgeview.pdb`）。内部符号直接暴露能力：`AddHookScript`（document-start 注入）、`ExecuteScriptCDP`、`CallCDPMethod`、`SetCDPEventReceiver`、`GetResponseBodyData`，外加完整 CoreWebView2 矩阵（`AddScriptToExecuteOnDocumentCreated`、`WebMessageReceived`、`CallDevToolsProtocolMethod`、`GetCookies`…）。
- `HPSocket4C.dll` 5.8.8：374 个导出里 **0 条 HTTP/WebSocket/SSL**（只有 TCP/UDP/Agent/Pack/线程池）→ "HPSocket 起本地 HTTP 服务当桥"的假设被排除；剩下的用途 🟡 是 TCP/UDP 连授权/公告服务器。
- 其它：微软官方 `WebView2Loader.dll` 1.0.2651.64；`sqlite3.dll` 3.30.1；`libssl/libcrypto` 3.0.0（谁加载 ❓）；`gzip.dll` 竟是微软 IIS 6.0（XP 时代）版本。

### 2.2 发货链路（🟡 强推断，能力已被组件证实）

```
买家付款/发消息
   ↓  触发源：内嵌 WebView2 里的闲鱼 IM / 订单页（登录态在 WebView2 profile 里）
EdgeView 注入 JS（document-start）
   ├─ MutationObserver 盯消息/订单 DOM
   ├─ hook fetch/XHR/WS 帧
   └─ 或 CDP Network.responseReceived → GetResponseBodyData 读 mtop JSON
   ↓  window.chrome.webview.postMessage → 易语言主程序
本地规则引擎（用户可编辑）
   ├─ 发货文件.xlsx：匹配标题 → 发货内容
   └─ 多规格发货列表.txt：规格ID + 商品ID → 卡密
   ↓
页面内发送：填会话输入框点发送，或复用页面上下文调 mtop 发送接口
   ↓
写 data.db（发货记录 / 卡密已用）🟡
```

### 2.3 两个规则文件（✅ 逐字节解析，直接可抄的数据模型）

**`发货文件.xlsx`**：单 sheet `A1:B4`，两列：

| A 匹配标题 | B 发货内容 |
| --- | --- |
| 测试1 | 马上发货咯稍等 |
| 测试2 | 111111111111 |
| 手机 | 11111111111111 |

→ **一列"键"、一列"要发出去的整段文本"**，同一列既能发卡密也能发话术。生成方 `wijmo.xlsx`(GrapeCity)，后被 WPS 12.1 保存（作者 `lastModifiedBy=小白`，2024-09）。

**`多规格发货列表.txt`**（123 字节，GBK + CRLF，分隔符 = 5 个连字符）：
```
规格ID | 商品ID | 卡密标题:规格 | 发货内容
2-----1072903926162-----腾讯会员:电脑7天-----AAAAAAAAAAAAAAAA
1-----1072903926162-----腾讯会员:安卓手机7天-----BBBBBBBBB
```
→ 解决"同商品多 SKU 卡密不同"的真实痛点；比标题匹配稳。

**教程视频**：`mp4V+mp4a`，**92.3 秒**录屏（2024-10-17），无 README/文档 → 功能本身很轻薄，卖点就是"填表 → 自动发卡"。

---

## 3. B：一键搬运助手 v2.1.9 怎么工作的

### 3.1 技术栈（✅ 硬证据）

- 同样是易语言 + VMProtect 全加密：`.text/.rdata/.data/.ulO` 四节 rawsize=0，`.ne[` 节 24,149,664 字节密文；无签名；导出表只有 12 个 `e2ee_Cache*`（🟡 易语言 E2EE 模块顺带导出，与业务无关）。
- **ACF = Admenri Chromium Framework**（`libacf.dll` 版本资源直接写明；官网 admenri.com + 官方论坛帖 + MIT 的 `github.com/Admenri/acfwrapper` 三重印证）。**它不是 CEF3 同进程模式，而是"进程外 IPC 遥控"**：
  - 位宽矛盾是硬证据：宿主 `vmp.exe`/`libacf.dll` 全 **x86**，内核 `chrome.dll` 全 **x64** → 32 位进程不可能加载 64 位 DLL，必然跨进程；
  - `libacf.dll` 导入 `CreateProcessW`/`CreateNamedPipeW`/`CreateIoCompletionPort`/`AssignProcessToJobObject`；
  - 25 个自定义 `acf.mojom.*` 接口（`BrowserHost`/`ProfileHost`/`CookieManagerHost`/`ResourceInterceptorHost`/`WebMessageTarget`/`FunctionRegisterTarget`…，偏移 `0x2ac70e` 起）；
  - `chrome.dll` 内 4 个 acf 开关：`acf-named-platform-channel-pipe`(0xde20060)、`acf-url-intercept`、`acf-chrome-test`、`acf-allow-offstore-extension`(0xd279cb0)；
  - 作者原话："不同于 CEF3 的同进程调用模式，ACF 使用进程通讯方式远程遥控内核"。
- **内核 = Chromium 131.0.6778.76 官方构建 x64 241MB**（版本资源带 git hash `756483115…-refs/branch-heads/6778@{#2236}`，PE 时间戳 2024-11-13）。工具自己编译于 **2026-05** ⇒ 内核落后约 **18 个月**。
- 纠正一个初始误判：`chrome_proxy.exe` 是 Chromium 官方 **PWA 快捷方式 stub**（源码 `chrome/app/chrome_proxy_main_win.cc`），**不是**代理/多开组件。`external_extensions.json` 只有 99 字节注释，**无内置扩展**。

### 3.2 多账号 / 代理 / 指纹

- **隔离是一等公民**：`AcfEnvironment::CreateEnvironment(browser_path, ExtraCommandLine, {user_data_dir}, handler)`，官方注释 "Avoid create multi environment on the same data dir"；每 Environment = 一套独立 Chromium 进程树 + 独立 cookie/缓存；还能再开多个 `Profile`（`storage_path`/`enable_encrypted_cookies`/`persist_session_cookies`/`host_mapping_rules`）+ `CookieManager` 读写。
- **代理**：免费版 `libacf.dll` **没有任何代理专用 API**，官方口径"S5 认证代理是 Ex 版（100 元/月）功能"；免费版只能自己拼 `ExtraCommandLine` 塞 `--proxy-server`（而 Chromium 命令行本身不支持带账号密码的 SOCKS5）。🟡 若它要"一号一 IP"，只能在工具侧自建本地转发。
- **指纹**：全量扫 `chrome.dll` 的 fingerprint/canvas/webgl → 只有 Chromium 原生串，**无任何 acf 指纹魔改**；`libacf` 也无 `Ex_*` 导出 ⇒ 本包是免费版、无内核级指纹伪装。
- **自动化能力（决定路线判据）**：`AcfFrame::QuerySelectorAll / GetDOMDocument / ExecuteJavascript`（原生 DOM 抓取，甚至不用注入 JS）、`AcfResourceHandler / AcfResponseFilter`（拦截请求与响应体）、`AcfFunctionFactory`（把宿主函数注册成页面可 await 的 JS 函数）、`AcfCookieManager`、`AcfURLRequest`（内核网络栈里发请求）、`AcfDevtoolsMessageObserver`（能开 CDP）。

### 3.3 搬运链路（🟡 推断，每步都有组件支撑）

```
① 扫码登录（真浏览器，tfstk/x5sec 天然生成）→ 登录态落在该账号 user_data_dir；CookieManager 可导出备份
② 选品：打开商品页 → QuerySelectorAll/ExecuteJavascript 抓标题/价格/描述/主图；更省力：ResourceInterceptor 截详情接口响应体
③ 素材：libcurl 7.70 下载图片 → 本地改名/去重（sqlite 记录）→ 洗稿（标题模板/前后缀、改价公式、关键词替换以躲重复铺货）
④ 发布：a) 注入 JS 填表单点提交；或 b) 页面内 fetch 调 mtop.idle.pc.idleitem.publish（自动带 _m_h5_tk/tfstk/x5sec）
   图片走 stream-upload.goofish.com/api/upload.api（multipart）
⑤ 回写：拿商品 ID → 失败进重试队列 → 多账号轮流
```

### 3.4 UI：`tabControl/` 的协议被完整读出来了（✅）

`tabControl/index.html`（22,766 B，jQuery + jQuery-UI + `chrome-tabs` + zui）是在 ACF 内核里渲染的**纯 UI 壳**，与易语言宿主走 WebMessage 桥：

- 页面 → 宿主 `postMessage(code, arg)`：0 Select / 1 Unselect / 2 CloseTab / 3 OnReady / 4 Command(0=Back 1=Forward 2=Reload 3=Stop 4=Menu) / 5 LoadURL / 6 SetFocus
- 宿主 → 页面 `onmessage({type,…})`：0 AddTab / 1 CloseTab / 2 SetTitle / 3 SetCommandStatus / 4 SetURL / 5 SetLoading / 6 SetFavicon

→ 架构上确证：宿主手里维护 `tabId → AcfBrowser` 映射，**一个 tab 一个浏览器视图，UI 与执行解耦**。这既是"多账号并行"的载体，也是"一个任务一个视图"的载体。授权/机器码/卡密校验 ❓（无任何 license 导出、data.db 0 字节 ⇒ 🟡 网络验证在密文里）。

---

## 4. 两个工具放一起看：共同选择与市场含义

| 维度 | A 自动发货 | B 一键搬运 | 含义 |
| --- | --- | --- | --- |
| 语言/加壳 | 易语言 + VMProtect 全节 | 同 | 生态同源，反逆向=全量加密 |
| 浏览器 | 系统 WebView2 + EdgeView 注入 | 自建 Chromium 131 + 私有 IPC | 都**不信任用户浏览器**：怕版本/插件/环境不可控 |
| 自动化 | document-start 注入 + postMessage + CDP 读响应 | 原生 DOM API + 资源拦截 + 页面内 fetch | 都是"在真浏览器上下文里干活"，免签名 |
| 数据 | SQLite + xlsx/txt 规则 | SQLite + 加密业务层 | 规则外置给用户，记录内置 |
| 收费/许可 | 闭源、无声明 | 闭源、ACF 免费版 | 灰色商业工具，分发风险高 |
| 规模 | 轻（100MB） | 重（371MB） | —— |

**市场含义（对我们的判断）**：这两块正好是个人卖家最肯付钱的两件事——**虚拟商品自动发卡**与**跨店铺货**。前者实现极轻（两个键的规则表 + IM 监听 + 防重复发货就能用），后者价值大但合规风险最高（搬他人商品 = 重复铺货/侵权）。这印证了我们设计文档里的判断：**P2 运营里"自动发货"应该提前做，而"搬运"只能做成"搬自己商品"的合规版**。

---

## 5. 与我方方案对比：同路线，不同代际

| 维度 | 它们 | 我们（CDP 接管真 Chrome / playwright-core） |
| --- | --- | --- |
| 内核来源 | 自带 341MB，冻结 M131（2024-11） | 用户机器上已有 Chrome/Edge，永远最新 |
| 进程模型 | x86 宿主 + x64 内核 + 自造 mojom over 命名管道 | 标准 CDP over WebSocket |
| 体积 | 371MB | 几十 MB 依赖，内核 0 |
| 多账号 | Environment(user_data_dir) 原生隔离 | `--user-data-dir` 各起实例（需自己管进程/端口） |
| 代理 | 免费版只能 `--proxy-server`，无 S5 认证 | Playwright `proxy:{server,username,password}` 原生支持 |
| 指纹 | 免费版无；Ex 版付费 | 无（真 Chrome 本身就是最不显眼的） |
| 调试/排障 | 密文黑盒 | CDP 全透明，trace/录像/断言齐备 |
| 合规/杀软 | 未签名+加壳+自建内核分发 | 不重分发浏览器，干净 |

**结论：路线我们更优，但必须补两块短板**（这也是它们做对的地方）：

1. **账号隔离与登录态**：一账号一 `user_data_dir` + 加密 + 用完即焚 + 登录态快照（它们用 `CookieVisitorSync` 反复做"读 cookie→判登录→续期→备份"）。我们要把这做成显式模块，不是散在启动参数里。
2. **响应拦截取数**：用 CDP `Fetch.enable` / `Network.getResponseBody` 复用页面自己的 mtop 响应（结构化 JSON、免算 sign、抗改版），DOM 选择器只做兜底。

另外 3 个可直接搬的设计：**页面内 `Runtime.evaluate` + `fetch` 调 mtop**（风控最省姿势）、**tab 视图总线协议**（AddTab/SetTitle/SetLoading/SetFavicon → 多账号面板事件模型）、**规则表用 xlsx/csv 导入导出**（卖家零学习成本；A 的"标题→整段文本"和"规格ID+商品ID→卡密"两种键直接照抄）。

**不建议学**：自建内核分发、VMProtect 全量加密业务层（作者自己都难维护，我们这次分析的全部困难都来自它）、x86/x64 跨位宽自造 RPC、付费指纹内核（供应链风险）。

---

## 6. 风险与合规（必须写进结论）

1. **安全**：两包均**未签名**、VMProtect 全加密、`data.db` 0 字节、带 "C" 前缀 → 高度疑似**破解/二次分发版**。静态分析未发现后门证据，但**密文不可审计，无法证伪**。建议不要在主账号电脑/主账号环境运行，更不要用它们登录闲鱼。
2. **平台规则**：B 的"一键搬运 + 改标题改价 + 多账号发布"= 典型重复铺货/搬运，违反闲鱼/淘宝规则，封号风险高；A 的自动发卡在虚拟商品类目尚属常规运营，但仍属非官方自动化。
3. **许可证**：A 打包的 EdgeView 是 **LGPL-2.1**，商业闭源包直接分发 DLL 且**包内无声明/无源码提供** → 合规瑕疵。我们引用任何 GPL/LGPL 组件必须附声明。
4. **法律**：对外售卖"搬运/采集"工具可能触及不正当竞争；若涉及绕过技术措施，还有《刑法》285 条边界（此前四问调研已详述）。**我方定位应为"商家自有账号的运营效率工具"**，明确不搬他人商品、不做数据倒卖。

---

## 7. 还差什么、下一步建议

**静态分析的天花板**：两个 exe 的业务层都是密文，接口名 / 注入 JS 片段 / 中文菜单 / 选择器文案 / 建表 SQL 全部 ❓。要拿到只有两条路：
- 隔离沙箱里跑起来抓包（**风险高，不建议**，且本次明确禁止运行）；
- A 的 92 秒教程视频抽帧 OCR（本机无 ffmpeg，需先装；且视频只有 1.5 分钟，信息量有限）。

**对我们的下一步（建议按性价比排序）**：
1. **把"自动发货"提到 P1 之前**，做成第一个可用能力：xlsx/txt 规则导入 + IM 消息监听 + "规格ID+商品ID"双键匹配 + 防重复发货（幂等键=订单号/买家+商品+规格）+ 发货记录。这块小、刚需、可 1–2 周出可用版。
2. **多店铺"搬自己商品"**：只复制自己账号下的商品到自己的另一个账号，做标题/价格模板与去重，不做他人商品抓取；写操作限速（呼应 goofish-cli 的 1 次/分钟写、每日 ≤20 次写）。
3. 把"账号 profile 隔离 + 登录态快照 + 响应拦截取数"三条写进设计文档（补充到 `docs/xianyu-ops-agent-design.md` 的 daemon/插件职责里）。

**仍需你拍板的三件事**（从上一轮调研一直没定）：
- ① 目标商家：只做纯个人卖家，还是也覆盖鱼小铺/有资质商家（决定要不要接官方闲管家通道）；
- ② 首发主打：**自动发货**（本次分析强推）还是**批量上架**；
- ③ 运行形态：DSH 插件 + daemon 自启，还是纯后台 + 独立 Web 控制台。
