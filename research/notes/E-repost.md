# E · 闲鱼一键搬运助手 v2.1.9 —— 「ACF(Chromium 定制内核) + 易语言宿主」逆向笔记

> 分析对象：`research/repos/unpacked/C闲鱼一键搬运助手v2.1.9`（用户新加的闭源商业工具，闲鱼相关）
> 方法：**纯静态只读**。全程未运行任何 .exe/.dll，未修改 unpacked 目录任何文件。
> 标注约定：**✅ 证实**（有文件/偏移/命令输出支撑）· **🟡 推测**（有间接证据的推断）· **❓ 不可得**（静态无法取得，需运行或脱壳）
> 分析日期：2026-10-20

---

## 0. 一句话结论

**✅ 这是一个「易语言(x86) + VMProtect 全加密业务层 + Admenri Chromium Framework(ACF) 定制内核」的外挂式客户端**：业务逻辑全在被 VMProtect 虚拟化的 `.ne[`（24MB 密文）里，静态零明文；真正能看清的是它的**外壳架构**——32 位宿主通过 ACF 的 mojom/命名管道 IPC 远程遥控一整个 **64 位 Chromium 131.0.6778.76 官方构建**（341MB 完整安装目录），用 Chromium 的真实网络栈 + 真实渲染器去操作闲鱼网页，并用 ACF 的 Profile/CookieManager/资源拦截/DOM-QuerySelector/JS 注入能力做**多账号隔离与页面级自动化**。

> 对我们的意义：它和我方 `playwright-core/CDP 接管真 Chrome` 属于**同一路线的两个世代实现**（都是用真浏览器 + 自动化），但它是"自建内核分发"、我方是"接管用户已有内核"。它可借鉴的是 **profile 级账号隔离、每账号一视图的并行模型、资源拦截取数**；**不值得借鉴**的是 341MB 自建内核分发与 VMProtect 加密（体积/兼容/合规三重代价）。

---

## 1. 包结构与完整性校验

| 文件/目录 | 大小 | 位宽 | PE 时间戳(UTC) | sha256(前 16) |
|---|---|---|---|---|
| 闲鱼搬运助手v2.1.9.vmp.exe | 24,178,688 | x86 | 2026-05-07 16:15:50 | a840a8de44f5692a… |
| libacf.dll | 3,356,672 | x86 | 2024-11-13 19:59:24 | 65a0fa053b6f2916… |
| libacf_Caller.dll | 368,128 | x86 | 2025-02-26 09:43:00 | 882cc050e21ca810… |
| libcurl.dll | 1,755,648 | x86 | 2020-06-03 09:50:21 | 5eb7c4723acab028… |
| sqlite3.dll | 497,152 | x86 | 2019-11-19 13:11:37 | c02c7b4bbadff0c7… |
| gzip.dll | 30,208 | x86 | 2001-08-31（假时间戳） | 97ea3d99cf21123b… |
| data.db | **0 字节** | — | — | — |
| tabControl/ | 1,086,119 | — | — | — |
| ACFlib/ | 357,307,494 | — | — | — |
| ├ chrome.exe | 2,808,320 | **x64** | 2024-11-13 19:59:24 | — |
| ├ chrome_proxy.exe | 1,121,792 | x64 | 同上 | — |
| └ 131.0.6778.76/chrome.dll | 241,301,504 | **x64** | 同上 | — |

完整 sha256 见 §10 附录。

**✅ 三个版本资源事实（决定性的"身份指纹"）**

| 文件 | VS_VERSION_INFO 关键字段 | 说明 |
|---|---|---|
| vmp.exe | FileDescription=`易语言程序`；Comments=`本程序使用易语言编写(http://www.eyuyan.com)`；manifest `E.App` | 易语言编译产物（E.App 是易语言固定 manifest 名） |
| libacf.dll | FileDescription=`Admenri Chromium Framework (ACF) Library`；CompanyName=`Copyright (C) 2023-2024 Admenri.`；FileVersion=1.0.0.1 | **ACF 官方库原件**，非山寨改名 |
| ACFlib/chrome_elf.dll、chrome.exe | CompanyName=`The Chromium Authors`；FileDescription=`Chromium`；FileVersion=`131.0.6778.76`；LastChange=`7564831157caa65f87a650a541d1e575e47fc3a3-refs/branch-heads/6778@{#2236}` | Chromium **官方源码构建**（带 git hash + branch-heads），不是 Google Chrome 品牌版 |

---

## 2. 答案一：ACF 是什么？三层调用链与进程模型

### 2.1 三层结构（✅ 定性，🟡 具体分工）

```
┌───────────────────────────────────────────────┐
│ 闲鱼搬运助手v2.1.9.vmp.exe   (x86, 易语言)      │  ← 业务层：账号管理/搬运任务/UI 调度
│   · VMProtect 虚拟化，LoadLibraryA+GetProcAddress│     （全部动态解析，无静态导入）
│     动态加载 libacf_Caller.dll / libcurl / sqlite3│
└───────────────┬───────────────────────────────┘
                │ C 导出 API（acf_CreateEnvironment / acf_RegisterClass / acf_PostTaskOnUIThread…）
┌───────────────▼───────────────────────────────┐
│ libacf_Caller.dll (x86, 368KB)                │  ← C++ 包装层（= CEF 的 libcef_dll_wrapper，
│   · 只 import libacf.dll(33 个函数)+K32+User32  │     易语言 binding；MIT 开源可对照）
│   · RTTI: AcfBrowser/Frame/DOMDocument/        │
│     Profile/CookieManager/ResourceHandler…     │
└───────────────┬───────────────────────────────┘
                │ libacf.dll 的 56 个 C 导出（acf_* 前缀，Cef→Acf 改名）
┌───────────────▼───────────────────────────────┐
│ libacf.dll (x86, 3.3MB) = ACF 框架宿主          │  ← 浏览器侧"遥控器"：
│   · CreateProcessW/CreateNamedPipeW/           │     拉起并 IPC 遥控内核进程
│     ConnectNamedPipe/CreateIoCompletionPort    │
│   · crashpad + CryptProtectMemory(防 dump)     │
└───────────────┬───────────────────────────────┘
                │ 自定义 mojom 协议（25 个接口，命名管道 / ipcz）
┌───────────────▼───────────────────────────────┐
│ ACFlib/chrome.exe + 131.0.6778.76/chrome.dll   │  ← 改造过的 Chromium 131 内核（x64, 241MB）
│   · 自定义开关 acf-named-platform-channel-pipe │
│     acf-url-intercept / acf-chrome-test /      │
│     acf-allow-offstore-extension               │
└───────────────────────────────────────────────┘
```

### 2.2 为什么判定是「进程外 IPC 遥控」而不是「内嵌 CEF 多进程」

这是本题最关键的一条，四路独立证据收敛：

1. **✅ 位宽矛盾（硬证据）**：宿主侧 `vmp.exe` / `libacf.dll` 全是 **x86**（PE magic 0x10b，objdump 目标 pe-i386），而内核 `131.0.6778.76/chrome.dll` 是 **x64**（magic 0x20b）。32 位进程**不可能**把 64 位 DLL 映射进自己的地址空间 ⇒ 必然进程外。
2. **✅ IPC 导入 + mojom 协议**：`libacf.dll` 导入 `CreateProcessW`（拉起内核）、`CreateNamedPipeW`/`ConnectNamedPipe`/`CreateIoCompletionPort`（命名管道 + IO 完成端口）、`AssignProcessToJobObject`（内核进程生命周期绑宿主）。字符串里有自定义 mojom 接口族（0x2ac70e 起）：`acf.mojom.{BrowserHost, BrowserClient, EnvironmentHost, EnvironmentClient, ProfileHost, ProfileClient, CookieManagerHost/Client, DevtoolsMessageObserver, FunctionRegisterClient/Target, ResourceInterceptorHost/Client, ResourceResponseHost/Client, ResponseBodyFilterHost/Client, URLRequestHost, WebMessageClient/Target/Factory, WebSocketHost/Client}`，宿主侧实现类 `AcfEnvironmentHostImpl`（0x2aa30d）、`AcfProfileWrapper`、`AcfWebMessageProxyImpl`、`AcfDevtoolsMessageObserverClient`。另有 `acf-disable-ipcz`（0x2aa2cc）—— 说明它同时支持 Chromium 新 ipcz 传输与回退传统命名管道。
3. **✅ 源码路径泄漏**：libacf.dll 内含 `..\..\acf\libacf\devtools_message_client.cc`（0x2aa220）。
4. **✅ 官方口径**：作者在官方论坛明说 ACF「**不同于 CEF3 的同进程调用模式，ACF 使用进程通讯方式远程遥控内核实现全部功能**」（bbs.admenri.com thread-11，2025-03-01）。内核侧也确实被打了补丁：`chrome.dll` 里有 `acf-named-platform-channel-pipe`（0xde20060）、`acf-url-intercept`（配合 `disable-acf-url-intercept` 0xc98b8f0）、`acf-chrome-test`、`acf-allow-offstore-extension`（0xd279cb0）四个 acf 自定义开关。

⇒ **结论**：`ACFlib/chrome.exe` 是被 `libacf.dll` 用 `CreateProcessW` 拉起的**独立子进程**（一个 Environment 一个内核进程树：browser + renderer + gpu + utility，标准 Chromium 多进程），宿主通过命名管道上的自定义 mojom 接口远程调用它。**不存在"把 Chromium 嵌进宿主进程"这种形态**。

### 2.3 ACF 的来历与版本对应（✅ 有官方信源）

- ACF = **Admenri Chromium Framework**，个人开发者 Admenri 的「浏览器自动化与嵌入框架」，C++ 写成、导出 C/C++ 接口；**易语言 / C# 封装以 MIT 开源在 github.com/Admenri/acfwrapper**，本包 `libacf_Caller.dll` 就是其中 `binding_epl/libacf_caller` 的预编译产物（✅ 导出名逐一对得上：acf_CreateEnvironment / acf_RegisterClass / acf_PostTaskOnUIThread / acf_ObjectAddRef …）。
- 官方站点（admenri.com，2025.4 第四版）分 **免费版 / Ex 版（100 元/月）**，Ex 独占：①内核级指纹动态修改 ②WebSocket 内核级拦截修改 ③**S5 账号密码代理**；"Ex 版授权仅限用户本机使用"；`δ` 版对应 M131 内核。
- **✅ 本包是免费版**：libacf.dll 无任何 `Ex_*` 导出，只有查询函数 `acf_get_ex_version_active_state`（0x308e54）；且 chrome.dll 里搜不到任何 acf 前缀的指纹/Canvas/WebGL 魔改开关。

### 2.4 `chrome_proxy.exe` 是误读 —— 它不是代理组件（✅ 纠正）

初步清点时怀疑 `chrome_proxy.exe` 意味着"代理/多开隔离"。实测**否定**：
- 它是 **Chromium 官方构建树里的标准 target**（PWA/网页快捷方式创建 stub，源码入口 `chrome/app/chrome_proxy_main_win.cc`），版本资源与 chrome.exe 完全同源同时间戳（x64，2024-11-13 19:59:24，Chromium Authors）；
- strings（2,548 行）里只有 `chrome_proxy.exe.pdb`(0xecfa0)、`ppapi_proxy` 等通用串，**没有任何 proxy 配置/转发/账号密码逻辑**。

⇒ 这个文件与"代理/多开隔离"无关；它的存在只说明包内是**完整原版 Chromium 安装目录的拷贝**。

### 2.5 ACF 暴露给上层的自动化能力（✅ 头文件级证据，决定第 4 问的判据）

| 能力 | API（来自 acfwrapper 官方头文件 + 本包 RTTI 双重印证） |
|---|---|
| 多环境/多 profile | `AcfEnvironment::CreateEnvironment(browser_path, ExtraCommandLine, AcfEnvironmentSettings{user_data_dir}, handler)`；`CreateProfile(AcfProfileCreateParams{storage_path, incognito, cookie 策略, host_mapping_rules…})` |
| 原生 DOM 抓取（**不注入 JS 也行**） | `AcfFrame::GetDOMDocument / ExecuteJavascript / QuerySelectorAll(selector, cb)`；`AcfDOMNode::{GetElementAttribute,GetElementInnerText,GetElementBounds,GetAsMarkup,…}` |
| 注入 JS 并取回值 | `ExecuteJavascript(...)` + `AcfExecuteJavascriptCallback::OnExecuteResult(AcfValue)`；caller 层封装 `ExecJsCallbackAsync`(0x53d30) |
| JS↔native 双向 RPC | `AcfFunctionFactory/AcfFunctionHandler/AcfPromiseResolver`（注册成页面里可 await 的函数）、`AcfWebMessageFactory/Handler/Proxy` |
| 网络请求拦截/改包 | `AcfResourceHandler/ResourceRequestHandler`、`AcfResponseFilter/ResourceReadCallback/ResourceSkipCallback`、进程级 `AcfEnvironmentHandler::GetResourceRequestHandler(…, bool& block_request)` |
| Cookie 直读直写 | `AcfCookieManager/AcfCookieVisitor`（caller 层 `CookieVisitorSync` 0x54144） |
| 原生 HTTP（绕过浏览器） | `AcfURLRequest/URLRequestClient` |
| DevTools 协议 | `AcfDevtoolsMessageObserver`（SendDevToolsMessage/OnDevToolsMessage） |
| 内核路径/版本 | `GetKernelVersion()`；`ExtraCommandLine = multimap<string,string>` ⇒ **可给内核塞任意命令行开关**（`--proxy-server`、`--user-agent`、`--lang` 等） |


---

## 3. 答案二：多账号 / 多开 / 代理 / 隔离

### 3.1 框架原生就为此设计（✅）

- `AcfEnvironmentSettings` 只有一个字段 `user_data_dir`，官方注释："**Avoid create multi environment on the same data dir**" ⇒ 一个 Environment = 一个独立 Chromium 用户数据目录（= 一份 cookie/缓存/存储/登录态）。
- `ProfileCreateParams.storage_path` + `enable_encrypted_cookies` + `persist_session_cookies` + `host_mapping_rules` ⇒ 同一内核下可再开多个逻辑 profile；每个 profile 有自己的 cookie jar、preferences、缓存。libacf 里有 `AcfProfileWrapper`（RTTI）与 `user-data-dir`（唯一一处，0x2ba1b4）。
- `AcfBrowserCreateParams{parent HWND, visible, rect}` ⇒ 浏览器可**作为子窗口嵌进易语言主窗口**（不弹外置窗口），这解释了为什么它的 UI 是自绘的"仿 Chrome 多标签"而不是真 Chrome 窗口。

### 3.2 多开的实际形态（🟡 推断，证据链合理但无法在密文里验证）

最可能的实现：**一个主窗口 + N 个"账号环境"**，每个账号 = 一个 `user_data_dir`（如 `data/accounts/<账号名>/`），各自 `CreateEnvironment` ⇒ 每个账号跑一套独立的 Chromium 进程树（browser+renderer），互不共享 cookie/指纹/缓存。依据：
- `tabControl/index.html` 的 tab 只是**宿主自己的 UI 元素**（HTML 画的标签条），**不是** Chromium 的 tab —— 所以"一个 tab"完全可能是"一个账号的浏览器视图"，也可能是"一个搬运任务"（见 §6）；
- 包内 `data.db` 是 **0 字节占位**（sqlite3 打开后自动建表）⇒ 账号列表/任务队列存本地 SQLite，运行时才写；
- 🟡 一个 Environment 一个内核进程树的代价很大（每个约 150–250MB 内存），24MB 工具敢开多账号，说明它大概率是**按需开/关**（跑完一个账号的搬运就销毁环境），而不是常驻 N 个。

**❓ 无法确定的**：环境目录命名、代理配置具体落在哪（vmp.exe 内部，全加密）、是否用 `--user-agent` 换 UA。

### 3.3 代理（🟡）

- **✅ 免费版 libacf.dll 里没有任何代理专用 API**，字符串层搜 `--proxy-server` / `socks` 均 0 命中；唯一的 "proxy" 字样是 `ControlMessageProxy` / `PipeControlMessageProxy`（IPC 代理类，与网络无关）、`ppapi_proxy`、`proxy-authenticate`（Chromium 通用）。
- **✅ 官方口径**：S5 账号密码代理是 **Ex 版专有功能**。
- ⇒ 🟡 该工具若要配代理，只能走两条路：(a) 自己拼 `ExtraCommandLine` 传 `--proxy-server=host:port`（免费版支持，但**不支持带认证的 SOCKS5**，因为 Chromium 命令行本身不支持账号密码）；(b) 工具自建本地转发代理（用 libcurl 或内置 socket 转发）再让内核连本地端口 —— 若真这样就能绕开 Ex 限制。**包内没有任何代理配置文件，全部运行时决定，静态无法证实走哪条**。
- 顺带：本包存在 `libcurl.dll`（7.70.0，含 OpenSSL）与 `gzip.dll`，说明**图片下载/上传很可能走 libcurl 而非浏览器**（见 §4）。

### 3.4 指纹隔离（✅ 否定内核级伪装）

- 全量扫 `chrome.dll` 的 `fingerprint` / `canvas` / `webgl` / `acf-`：**只命中 Chromium 原生串**（`components/autofill/content/browser/risk/fingerprint.cc`、`fingerprinting_protection_filter`、设备名清单、指纹保护开关），**没有任何 acf 前缀的指纹魔改**。
- ⇒ 免费版 ACF **没有**内核级指纹伪装；能做的只有 API 层可控项：`--user-agent`（命令行）、`SetPreference`、独立 `user_data_dir`。
- 🟡 对比：Ex 版卖点正是"内核级指纹动态修改" ⇒ 说明 Admenri 的指纹魔改是**另发一套 Ex 内核组件库**，免费版内核里确实没有。

### 3.5 `external_extensions.json`（✅ 空的）

`ACFlib/Extensions/external_extensions.json` 只有 99 字节，内容仅 Chromium 官方注释 `// This json file will contain a list of extensions that will be included ...`，**无任何内置扩展条目**，也没有 `Extensions/<id>/` 解包扩展目录。
- 但内核保留了自定义开关 `acf-allow-offstore-extension`（= `--allow-offstore-extension`），即**允许运行时加载非商店扩展** ⇒ 🟡 该工具（或 ACF 上层）可以在运行时注入自己的扩展（做请求篡改/脚本注入），但**这个包内没有随包分发扩展**，所以要么没用，要么在 exe 的加密资源里（不可得）。

---

## 4. 答案三：搬运流程 —— 能力映射 + 推断链路（本问有硬边界）

### 4.1 第一性事实：业务层完全不可静态读取（✅ 量化证明）

- `vmp.exe` PE 有 7 节，其中 `.text / .rdata / .data / .ulO` 四节 **rawsize=0**（内容被抽走），`.ne[` 节 vsize=24,149,664 / raw=24,150,016 = **VMProtect 加密载荷本体**；**无 overlay**；**无 Authenticode 签名**。
- 全文件（24MB）逐字节扫标记串：`http://`=0、`https://`=0、`goofish`=0、`mtop`=0、`_m_h5_tk`=0、`x5sec`=0、`.jpg`=0、`item`=0、`cookie`=0 —— **九个关键标记全 0**。
- GBK 汉字对密度检验：符合 `[0xB0-0xF7][0xA1-0xFE]` 的字节对密度最高 64KB 块 = 6,830/65,536 = **10.4%**，而纯随机数据的理论期望 = (72/256)×(94/256) = **10.3%** ⇒ 与随机噪声完全一致（"解出来"的中文全是 `巡鲅椟筑` 类乱码）。
- 导入表被 VMProtect 换成 stub：每个 DLL 只导入 1 个函数（`DrawDibDraw`、`midiStreamRestart`、`RasGetConnectStatusA` …），业务 DLL 全部 `LoadLibraryA` + `GetProcAddress` 动态解析。
- 导出表只有 12 个 `e2ee_Cache{Clear,Decr,Delete,Exists,Get,GetMulti,GetMultiText,GetText,Incr,Set,SetExpire,SetText}` —— 🟡 推测是易语言某 "E2EE" 通用模块静态编译进来后顺带导出的缓存 API，与业务无直接关系（名字/形态是通用 KV 缓存）。

⇒ **搬运流程的具体 URL、mtop 接口名、注入的 JS 片段、中文选择器文案，静态一律拿不到**（除非脱壳，而运行 exe 被明令禁止）。下面只能给"能力映射 + 有据推断"。

### 4.2 可用组件的功能映射（✅ 组件存在 = 能力可达）

| 组件 | 显然用途（按证据强度） |
|---|---|
| ACF 内核 + 真浏览器 | 登录（扫码/账密）、浏览闲鱼页面、执行页面内 JS、拦截并复用页面自己的 mtop 请求 |
| `tabControl/`（仿 Chrome 标签条 + 地址栏 + 前进/后退/刷新） | 多任务并行视图；地址栏说明**允许手输任意 URL**（人工兜底/风控处理） |
| `libcurl.dll` 7.70 | 图片批量下载（拿到 URL 后本地转存/改尺寸/加水印）、可能也用于非浏览器的 mtop 直连 POST |
| `sqlite3.dll` + `data.db` | 账号表、商品表、任务队列、去重指纹、失败重试状态 |
| `gzip.dll`（易语言压缩支持库） | 压缩解压（zip 包 / 接口响应 gzip / 图片批处理） |
| `ACF ResourceInterceptor` + `ResponseFilter` | **拦截闲鱼 XHR 响应体** ⇒ 不用自己算 mtop 签名就能拿到商品 JSON |
| `ACF FunctionFactory` | 把易语言的函数注册成页面 JS 可 `await` 的桥（页面脚本回调宿主做下载/入库） |
| `ACF CookieManager` | 登录态迁移/复用（把 A 账号 cookie 复制到别的环境、或备份登录态避免反复扫码） |

### 4.3 推断链路（🟡 全部为推测，但每一步都有组件支撑）

```
① 账号准备     扫码登录（passport.goofish.com/mini_login.htm 流程，需真浏览器生成 tfstk）
               ↓ 登录态落在该账号的 user_data_dir；CookieManager 可导出备份
② 选源商品     用户在 ACF 内核里打开源商品页（或粘贴商品 ID/链接），
               宿主用 QuerySelectorAll / ExecuteJavascript 从 DOM 抓标题/价格/描述/图片列表；
               更省力的方式：ResourceInterceptor 截详情接口响应体
               ↓ 落 sqlite 商品表
③ 素材处理     libcurl 下载图片 → 本地改名/去重（MD5 比对，sqlite 记录）→ 可能 gzip 打包
               文本"洗稿"：改标题模板、套前缀/后缀、改价公式（如 +5% 或抹零），
               规格/描述里替换关键词以躲重复铺货检测
④ 发布         两种可能（见 §5）：
               a) 在本账号内核里打开发布页，靠 JS 注入填写表单再点提交（浏览器自动化）
               b) 页面内 fetch 调 mtop.idle.pc.idleitem.publish（复用页面 _m_h5_tk 与 x5sec 环境）
               ↓ 图片先用 stream-upload.goofish.com 的 upload.api 上传（multipart）
⑤ 结果回写     从响应/DOM 拿商品 ID；失败进重试队列；多账号轮流发布（每账号一个环境/视图）
```

### 4.4 与我们对闲鱼网页版接口的既有研究对照（我方 A-cores.md 事实，非本工具证据）

- 发布接口：`POST https://h5api.m.goofish.com/h5/mtop.idle.pc.idleitem.publish/1.0/`，`api=mtop.idle.pc.idleitem.publish`，`spm_cnt=a21ybx.publish.0.0`；
- 签名：`sign = md5(token + "&" + t + "&" + 34839810 + "&" + data)`，`token = cookie _m_h5_tk` 前半段、appKey=34839810；
- 图片：`POST https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat&_input_charset=utf-8`（multipart 字段 `file`）；
- `tfstk` 由阿里 `et_f.js` 反爬 SDK 在**真实浏览器环境**里算出，`x5sec` 同理。

→ 这说明：**只要工具在真浏览器里跑，就能天然拿到 `_m_h5_tk` / `tfstk` / `x5sec`，不必逆向签名算法**。这正是"带 341MB 内核"的根本理由，也解释了为什么它不需要在 exe 里出现任何签名常量（与 §4.1 的"零明文"并不矛盾 —— 有浏览器就不需要那套常量）。

---

## 5. 答案四：它是「浏览器自动化」还是「接口直连」？

**结论：骨架必然是浏览器自动化（比重压倒性），但极可能是「页面内 fetch 调 mtop」的混合体。**逐条判据：

| 判据 | 观测 | 指向 |
|---|---|---|
| 分发一整个 341MB Chromium 官方构建 | ✅ ACFlib/ 存在，版本 131.0.6778.76 | 自动化（若纯接口直连，1MB 的 libcurl 足够，没有理由捆 341MB） |
| 原生 DOM 抓取 API | ✅ `AcfFrame::QuerySelectorAll / GetDOMDocument`，RTTI `AcfDOMDocument / AcfDOMNode` | 自动化（按选择器抓页面） |
| JS 注入/执行并回传 | ✅ `ExecuteJavascript` + `AcfExecuteJavascriptCallback::OnExecuteResult`，caller 封装 `ExecJsCallbackAsync` | 自动化 / 页面内调接口 |
| 请求拦截 + 响应体过滤 | ✅ `ResourceInterceptorHost`、`ResponseBodyFilterHost`、`ResourceFilter / ResourceReadCallback`；chrome.dll 有 `acf-url-intercept` 开关 | 自动化（拦流量拿数据，省签名） |
| 浏览器里跑真 cookie | ✅ `AcfCookieManager / AcfCookieVisitor` | 自动化（登录态复用） |
| 有 libcurl | ✅ 7.70.0，82 个 `curl_*` 导出 | **混合**：轻量 HTTP（图片下载/文件上传）不必走浏览器 |
| 有 libacf 的 URLRequest | ✅ `AcfURLRequest / URLRequestClient` | 可在内核网络栈里发请求（共享指纹/代理） |
| exe 内是否有 mtop/签名常量 | ❓ 全加密，无法判定 | 不影响结论（见 §4.4） |
| exe 内是否有注入的 JS 源码 | ❓ 全加密；包内**没有**业务 .js 资源（仅 jQuery/zui/chrome-tabs 这类 UI 库） | 注入脚本只能是运行时字符串（在密文里） |

⇒ **比重估计（🟡）**：登录 / 选品 / 发布 / 风控处理 ≈ 全走浏览器（DOM + 注入 JS + 拦截）；图片搬运 ≈ 走 libcurl 或 AcfURLRequest；**几乎不可能有"纯 mtop 直连 + 自算签名"的独立通道**，因为那既没必要（浏览器就在手边）又脆弱（签名算法会变）。
反向佐证（✅）：exe 里连 `https://` 这类常量都没有 —— 纯接口实现必然要硬编码 host/路径；它的网络字符串全在密文里，说明网络调用被封装得很深（要么由 ACF 路由，要么就是密文常量）。

---

## 6. 答案五：UI 与授权

### 6.1 `tabControl/` = 宿主自绘的仿 Chrome 标签条（✅ 协议级证据）

`tabControl/index.html` 是一个**在 ACF 浏览器里渲染的普通 HTML 页面**（22,766 B），依赖 jQuery + jquery-ui + adamschwartz/chrome-tabs（`chrome-tabs.js` 9,209 B）+ zui CSS；末尾脚本 `chromeTabs.init({$shell: $(".chrome-tabs-shell"), minWidth: 45, maxWidth: 200})`。
页面与易语言宿主之间用 **ACF WebMessage 桥**通信，双方协议被完整读出：

- 页面 → 宿主：`acfTabControl.postMessage(code, arg)`

| code | 含义 | arg |
|---|---|---|
| 0 | Select 选中标签 | tabId |
| 1 | Unselect | tabId |
| 2 | CloseTab 关闭 | tabId |
| 3 | OnReady 初始化完成 | — |
| 4 | Command 命令 | 0=Back 1=Forward 2=Reload 3=Stop 4=Menu |
| 5 | LoadURL 地址栏回车 | url |
| 6 | SetFocus | — |

- 宿主 → 页面：`acfTabControl.onmessage = function(args)`

| args.type | 含义 |
|---|---|
| 0 | AddTab(data, tabId) |
| 1 | CloseTab |
| 2 | SetTitle |
| 3 | SetCommandStatus(button: 0=Back 1=Forward 2=IsLoading) |
| 4 | Set URL |
| 5 | Set Loading |
| 6 | Set Favicon |

⇒ 这套协议说明：**标签条是纯 UI 壳，真实浏览器视图由宿主创建/销毁/定位**（tab 的图标、标题、loading、URL 全由宿主推给页面）。这不是"多任务并行"的间接暗示，而是**架构上的确证**：宿主手里有一组 "tabId → AcfBrowser" 的映射表。

### 6.2 多标签意味着什么（🟡 两种可能并存）

1. **多账号并行**：每 tab = 一个账号的浏览器视图（每个账号一个 Environment/user_data_dir，切换 tab 就是切换环境）；
2. **多任务并行**：每 tab = 一条搬运流水线（源商品详情页 / 发布页 / 后台消息页）。

考虑到地址栏可手输 URL + 前进后退 + Reload/Stop，最像的是**"精简版浏览器 + 业务侧栏"**形态：用户平时当浏览器用（登录、人工处理风控），业务按钮在旁边。`AcfBrowserCreateParams.parent` 说明这些视图是**内嵌子窗口**，所以标签切换 ≈ `ShowWindow` 切换。

### 6.3 授权 / 卡密 / 机器码（❓ 不可得，且证据反向）

- exe 全加密 ⇒ 无法读到"卡密/机器码/到期时间/心跳服务器"等易语言常见字符串；
- **✅ 反向证据**：没有任何 `license / activate / machine / 机器码 / 卡密` 类**导出**，也没有独立授权 DLL 或配置文件；`data.db` 为 0 字节说明它不用本地库存授权；
- 🟡 推测：授权校验在密文里（网络验证最常见），或这个 2.1.9 版本是"打包给别人用"的分发版（版本资源里作者写"请尊重并使用正版"）。
- ACF 自身没有商业授权门（免费版可自由分发 libacf.dll），所以**授权只在业务层**，无法静态判定。

---

## 7. 答案六：对我方方案的价值 —— 「自建 ACF 内核」vs「CDP 接管真 Chrome」

### 7.1 正面对比

| 维度 | 本工具（易语言 + ACF 定制内核） | 我方（playwright-core / CDP 接管用户真 Chrome） |
|---|---|---|
| 内核来源 | **自带** 341MB Chromium 131 官方构建（2024-11） | 用户机器上已有的 Chrome/Edge（可随时更新） |
| 内核版本 | 冻结在 M131（2024-11），**比工具自身编译时间 2026-05 落后约 18 个月** | 跟随用户更新，永远接近最新 |
| 进程模型 | 宿主 x86 + 内核 x64，自定义 mojom over 命名管道（**自造 RPC 层**） | 标准 CDP over WebSocket（**协议标准化、生态成熟**） |
| 自动化接口 | 自研 C++ API：DOM QuerySelectorAll / ExecuteJavascript / 资源拦截 / FunctionFactory | CDP：Runtime.evaluate / DOM / Network.* / Fetch.* / Target.* |
| 多账号隔离 | **原生 Profile/Environment（每账号独立 user_data_dir + cookie 加密 + host mapping）** | `--user-data-dir` 各起一个 Chrome 实例（等价效果，需自己管进程/端口） |
| 代理 | 免费版只能塞 `--proxy-server`（无 S5 认证）；Ex 版才有一等公民 S5 认证代理 | Playwright `proxy: {server, username, password}`（原生支持 HTTP/SOCKS5 认证） |
| 指纹伪装 | 免费版无；Ex 版内核级（100 元/月，绑定本机） | 无（需自建 stealth 补丁或换指纹浏览器） |
| 登录/风控 | 真浏览器 + 真 cookie，`tfstk/x5sec` 天然合法 | 同（真浏览器路线同等优势，这是双方共同前提） |
| 体积/部署 | 341MB 内核 + 24MB 加壳 exe，用户装完 ~370MB | 几十 MB 依赖；内核用户已有 |
| 更新/维护 | 内核换代要靠 ACF 作者发新版（被动）；页面改版同样要改选择器 | 内核换代免费；有成熟 CDP/Playwright 生态 |
| 分发/风控面 | VMProtect 加壳 + 未签名 exe ⇒ 杀软误报、下载拦截、企业环境无法装 | 纯 Node 脚本，部署干净；需用户 Chrome 授权远程调试 |
| 调试能力 | 有 DevTools 观察者（可开 CDP），但宿主自身是密文黑盒 | CDP 全透明，Playwright trace/录像/断言齐备 |
| 合规 | 自带内核分发（技术上 BSD 允许，但闭源加壳 + 商业授权风险大） | 不重分发浏览器，合规更干净 |

### 7.2 值得借鉴的 5 点（本文最实用的产出）

1. **多账号 = 一账号一 Environment（独立 user_data_dir），生命周期"用完即焚"**。`restore_old_session_cookies` / `incognito_mode` / `host_mapping_rules` 这些字段说明作者把"账号隔离"当第一性需求而非事后补丁。我方应把 `userDataDir` 的分配、加密、清理做成显式模块（含登录态导入导出），而不是散落在启动参数里。
2. **资源拦截取数 > DOM 抓数**。`ResourceInterceptor / ResponseBodyFilter` 是它取商品数据的捷径：页面自己发的 mtop 请求，响应体里就是结构化商品 JSON，**不需要自己算 `sign`、不需要逆向 `et_f.js`**。对应到我方：优先用 CDP `Fetch.enable` / `Network.getResponseBody` 复用页面流量，DOM 选择器只做兜底。
3. **"页面内 fetch 调 mtop"是风控最省的姿势**：用 `Runtime.evaluate` 在页面上下文里 `fetch(...)`（自动带上 `_m_h5_tk` / `tfstk` / `x5sec` / referer），比 Node 端重放请求稳得多。这也是 §5 推断它采用的形态。
4. **每账号一个"浏览器视图 + tab 表"，UI 与执行解耦**。`acfTabControl` 协议（AddTab/SetTitle/SetLoading/SetFavicon）本质是一个"任务视图总线"—— 如果我方要做多账号面板，这套消息协议可直接照搬成 IPC/事件设计。
5. **原生 CookieManager 做登录态搬运**。`CookieVisitorSync` 这种同步封装说明作者大量做"读 cookie → 判断登录 → 续期 → 备份"。我方对应 `context.cookies()` / `storageState()`，应做成"每账号一步到位"的登录态快照，而不是每次重新扫码。

### 7.3 不建议借鉴的部分

- **自建内核分发**：341MB + 内核冻结在 M131（2024-11）+ 只能等上游作者更新。我方接管用户真 Chrome，内核永远最新、体积为零，**这是路线级优势**。
- **VMProtect 全量加密业务层**：24MB 密文换来的防逆向，代价是**连作者自己也难维护/排障**（我们这次分析的全部困难都源自它），且杀软误报率高。
- **x86 宿主 + x64 内核的跨位宽自造 RPC**：只为兼容 32 位易语言生态；我方 Node/TS 无需这种复杂度。
- **Ex 版指纹伪装（付费 + 绑定本机）**：指纹需求真实存在，但押注单一作者的内核魔改版本，供应链风险太高。

---

## 8. 风险与合规（客观陈述）

- 🟡 **安全性未知**：exe 无签名、VMProtect 全加密、内含 `CryptProtectMemory`（防内存 dump）、24MB 密文业务层；包内没有被植入后门的**证据**，但**同样无法证伪**（密文天然不可审计）。本次分析遵约**未运行任何二进制**。
- ✅ **疑似平台违规**："一键搬运 + 改标题/改价 + 多账号发布"属于典型的重复铺货/搬运他人商品信息，违反闲鱼/淘宝平台规则，账号封禁风险高。
- 🟡 **技术可见性风险**：自建 Chromium M131 的 UA/ClientHints/JS 引擎特征与最新真 Chrome 有差异，是风控可探测面；用真 Chrome 反而更隐形。
- ✅ **杀软面**：VMProtect + 未签名 + 自建内核 ⇒ 极易被判为风险软件（用户侧安装阻力大）。

---

## 9. 未解问题（静态不可得，需脱壳或运行 —— 本任务明确不做）

| 问题 | 为什么拿不到 | 若真要拿（合法路径，本任务不做） |
|---|---|---|
| 具体 mtop 接口名/参数/签名实现 | exe 全加密，9 个关键串 0 命中 | 脱 VMProtect 或在隔离沙箱里挂代理抓包（**运行 exe 被禁止**） |
| 注入的 JS 源码、中文选择器文案 | 同上；包内无业务 .js | 同上 |
| 账号目录/代理配置的真实布局 | 全部运行时生成，包内无配置 | 运行后看文件系统变化（禁止） |
| 授权/卡密/机器码机制 | 密文 | 同上 |
| 是否使用 Ex 版 ACF | — | ✅ 已判定：**免费版**（无任何 `Ex_*` 导出） |

> 备注：`data.db` 为 0 字节 ⇒ 它是**清空后的"干净包"**（作者打包时没带数据库）或首次运行才建库；不含任何用户数据残留。这一点也算"包内无隐私泄漏"的正面证据。

---

## 10. 证据附录（命令 / 偏移 / 哈希）

**工具**：`/c/mingw64/mingw64/bin/strings`（`-n 6 -t x` ASCII、`-e l` UTF-16LE）、`objdump -p/-h`、`file`、Python 3.12（自写 PE 解析脚本，位于 `.scratch/repost/`：`pe_info.py`、`pe_times.py`、`pe_exports.py`、`res_dump.py`、`offsets.py`、`gbk_scan.py`）。

**关键偏移（`open(path,"rb").find(...)` 首次命中）**

| 文件 | 字符串 | 文件偏移 |
|---|---|---|
| libacf.dll | acf-disable-ipcz | 0x2aa2cc |
| libacf.dll | `..\..\acf\libacf\devtools_message_client.cc` | 0x2aa220 |
| libacf.dll | acf.mojom.BrowserHost | 0x2ac70e |
| libacf.dll | acf.mojom.FunctionRegisterTarget | 0x2aca60 |
| libacf.dll | acf.mojom.EnvironmentHost | 0x2ac982 |
| libacf.dll | acf.mojom.ProfileHost | 0x2acab8 |
| libacf.dll | acf.mojom.ResourceInterceptorHost | 0x2acb5e |
| libacf.dll | acf.mojom.WebMessageTarget | 0x2acd2c |
| libacf.dll | acf_get_ex_version_active_state | 0x308e54 |
| libacf.dll | user-data-dir | 0x2ba1b4 |
| libacf_Caller.dll | acf_CreateEnvironment | 0x4f686 |
| libacf_Caller.dll | acf_RegisterClass | 0x4f77b |
| libacf_Caller.dll | AcfDOMDocument | 0x52bfc |
| libacf_Caller.dll | AcfExecuteJavascriptCallback | 0x52d44 |
| libacf_Caller.dll | ExecJsCallbackAsync | 0x53d30 |
| libacf_Caller.dll | AcfProfileCreateParams | 0x53edd |
| libacf_Caller.dll | CookieVisitorSync | 0x54144 |
| chrome.dll | acf-named-platform-channel-pipe | 0xde20060 |
| chrome.dll | acf-chrome-test | 0xde20080 |
| chrome.dll | disable-acf-url-intercept | 0xc98b8f0 |
| chrome.dll | acf-allow-offstore-extension | 0xd279cb0 |
| chrome_proxy.exe | chrome_proxy.exe.pdb | 0xecfa0 |

**vmp.exe PE 结构（`objdump -h` + Python 解析交叉验证）**

```
section   VA          vsize       rawsize
.text     0x00001000  2146989     0        <- 被抽空
.rdata    0x0020e000  (…)         0        <- 被抽空
.data     0x005cf000  (…)         0        <- 被抽空
.ulO      0x0069c000  (…)         0        <- 被抽空
.CQf      0x0143c000  (…)         4096
.ne[      0x0143d000  24149664    24150016 <- VMProtect 加密载荷
.rsrc     0x02b45000  19597       19597
导出表 RVA 0x15c4d90 size 389 → 12 个 e2ee_Cache* 函数；无 overlay；无 Authenticode 签名
```

**sha256（完整）**

```
闲鱼搬运助手v2.1.9.vmp.exe a840a8de44f5692ae063541eea86a6491c9d8625c1285b08fb09ec04d4b33c55
libacf.dll                  65a0fa053b6f2916cd852aab1ba9061afa3d5df70321f1cfdc0bc977f09d75d5
libacf_Caller.dll           882cc050e21ca8102b5e672c91c18e4022ba662dad7cf9f610771b4c8ba2c0b5
libcurl.dll                 5eb7c4723acab028d8bfea807cae6dad1f38d2c21b11586d77a69a716fbc4f2a
sqlite3.dll                 c02c7b4bbadff0c71ef92a66468f813d2233dc00754425be71f83cd4a1719adc
gzip.dll                    97ea3d99cf21123bc1aec72f9ded6a51ac659830392adfefd424eb799ab0219e
tabControl/index.html       22,766 B
Extensions/external_extensions.json  99 B（仅注释，无扩展）
```

**外部信源（web）**
- ACF 官方介绍页 <https://admenri.com/index.php/acframework/> —— 2025-04-12 第四版：免费版/Ex 版、Ex 功能与 100 元/月、"δ(M131) 内核"、"Ex 授权仅限用户本机"。
- 作者官方论坛帖 <https://bbs.admenri.com/forum.php?mod=viewthread&tid=11> —— 2025-03-01："不同于 CEF3 的同进程调用模式，ACF 使用进程通讯方式远程遥控内核实现全部功能"。
- 易语言/C# 封装（MIT，含官方 API 头文件）<https://github.com/Admenri/acfwrapper>。

**横向对照**：同生态的另一款闭源工具笔记 `research/notes/D-delivery.md`（闲鱼自动发货助手 v4.8.2）用的是 Admenri **EdgeView（WebView2 封装）** + VMProtect + sqlite3 3.30.1 + 0 字节 data.db —— 与本工具（Admenri ACF + VMProtect + sqlite3 3.30.1 + 0 字节 data.db）**同作者生态、同技术范式**，说明这条"Admenri 组件 + 易语言 + VMProtect"的路线在该灰色工具圈已成事实标准。
