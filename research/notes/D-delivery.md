# D · 闲鱼自动发货助手 v4.8.2 —— 闭源商业工具只读逆向笔记

> 对象：`research/repos/unpacked/(v4.8.2)闲鱼自动发货助手/`（原包 `research/repos/(v4.8.2)闲鱼自动发货助手.rar`，39MB）
> 方法：只读静态分析。**未运行任何 exe/dll**，未修改 unpacked 目录内任何文件。工具：`objdump`、`/c/mingw64/mingw64/bin/strings`、`python3`（GBK/UTF-16 扫描、xlsx 解包、mp4 box 解析、PE 版本资源解析）。
> 标注：**✅ 证实**＝有静态证据（文件+偏移/命令输出）；**🟡 推测**＝无直接证据的合理推断；**❓ 不可得**＝被加密/禁止运行导致无法取证。

---

## 0. 结论速览

| 判定项 | 结论 | 强度 |
| --- | --- | --- |
| 语言/框架 | **易语言 5.x（EPL）静态编译，32 位 GUI** | ✅ 硬证据（版本资源明文+manifest+导入指纹） |
| 保护 | **VMProtect 全节保护**：原始 `.text/.rdata/.data` 全部置空（Size=0, raw off=0），整机载荷塞进 `.?2m`；入口在 VMP 节内；0x40000 起熵 7.997 | ✅ |
| 静态可读性 | 除 `.rsrc`（19,597 B）外**零可读字符串**：`strings -n 6` 24,537 行全噪声，URL/mtop/中文菜单/SQL/JS 全部不可得 | ✅ |
| UI 形态 | 易语言原生窗口 + **EdgeView(WebView2 封装)** 承载闲鱼网页；登录页在 WebView2 内（白屏=缺 runtime） | ✅（DLL/资源证据）+ 🟡（窗口结构） |
| 网络 | exe IAT 有 `WININET.dll`+`WS2_32.dll`；HPSocket4C 5.8.8 **只有 TCP/UDP 组件，0 条 HTTP/WS/SSL 导出** → 本地 HTTP 服务假设被削弱 | ✅ |
| 发货规则来源 | `发货文件.xlsx`（匹配标题→发货内容，A1:B4）+ `多规格发货列表.txt`（规格ID/商品ID/卡密标题:规格/发货内容，5 连字符分隔，GBK+CRLF） | ✅ |
| 存储 | `sqlite3.dll` 3.30.1 + 0 字节 `data.db` → 建表在程序内（加密不可得）schema ❓ | ✅（0 字节）／❓（schema） |
| 授权/许可证 | 程序本身闭源无授权文件；捆绑的 EdgeView 为 LGPL-2.1（Admenri），包内**无 LGPL 声明/源码提供** | ✅（合规瑕疵记录） |

**一句话**：易语言写的"WebView2 内嵌闲鱼网页 + 页面内注入/CDP 自动化 + 本地 xlsx/txt 规则表 + SQLite 记录"的发货工具，被 VMProtect 全节加密到**无法静态提取任何 URL/接口/菜单文案**——本次能拿到的只有"技术栈 + 数据格式 + 能力面"，业务细节只能靠推断。

---

## 1. 文件清单与 PE 指纹

```
ls -la 'research/repos/unpacked/(v4.8.2)闲鱼自动发货助手'
```

| 文件 | 大小(B) | PE TimeDateStamp (UTC) | 版本资源（解析 .rsrc 得到） | 判读 |
| --- | --- | --- | --- | --- |
| `闲鱼助手v4.8.2.vmp.exe` | 16 228 352 (0xF7A000) | 2026-08-25 10:51:16 | FileVersion 1.0.0.0；**FileDescription=`易语言程序`**；**ProductName=`易语言程序`**；LegalCopyright=`作者版权所有 请尊重并使用正版`；**Comments=`本程序使用易语言编写(http://www.eyuyan.com)`** | 易语言 5.x + VMProtect，**无签名**，二进制里写的"v4.8.2"不在版本资源里（文件版本仍是 1.0.0.0） |
| `edgeview.dll` | 953 344 | 2026-03-26 08:05:48 | 2.1.12.0，ProductName=`EdgeView Wrapper Proxy Library`，`Copyright (C) 2024 Admenri` | 易语言 WebView2 封装库（开源 LGPL-2.1） |
| `edgeview_static.dll` | 889 344 | 2024-09-15 02:43:23 | 同上 2.1.12.0 / Admenri | 同一模块的 static 版（🟡 把 WebView2Loader 静态编入，省掉外部 loader） |
| `WebView2Loader.dll` | 116 312 | 2024-07-19 21:13:06 | 1.0.2651.64，`Microsoft Edge Embedded Browser WebView Loader`，PDB=`D:\a\_work\e\src\out\Release\WebView2Loader.dll.pdb` | 微软**官方** loader（Azure 流水线构建） |
| `HPSocket4C.dll` | 330 752 | 2022-04-11 15:05:58 | 5.8.8，ProductName=`HP-Socket`，`https://github.com/ldcsaa/HP-Socket`，PDB=`C:\Users\Administrator\Desktop\Windows\Lib\HPSocket4C\x86\HPSocket4C.pdb` | 官方 HP-Socket C 接口 |
| `sqlite3.dll` | 497 152 | 2019-11-19 13:11:37 | 3.30.1.0，Public Domain | 易语言官方 SQLite 支持库同款版本 |
| `libssl-3.dll` | 619 008 | 2021-09-09 00:37:12 | 3.0.0 OpenSSL | OpenSSL（谁加载 ❓） |
| `libcrypto-3.dll` | 3 719 680 | 2021-09-09 00:33:44 | 3.0.0 OpenSSL | 同上 |
| `gzip.dll` | 30 208 | 2001-08-31 23:00:17 | 6.0.2600.0 (xpclient)，ProductName=`Internet Information Services`，Microsoft | **微软 IIS 6.0 的 gzip.dll**（XP 时代），被易语言生态当作解压模块用 |
| `data.db` | **0** | — | — | 空文件，无 `SQLite format 3` 头 → 运行期建表 🟡 |
| `发货文件.xlsx` | 9 156 | mtime 2024-09-15 | Applications=`wijmo.xlsx`(GrapeCity)；lastModifiedBy=`小白`；KSOProductBuildVer=2052-12.1.0.18276(WPS) | 规则表模板（详见 §5） |
| `多规格发货列表.txt` | **123** | — | GBK + CRLF | 多规格卡密表（详见 §5） |
| `卡卷发货教程/Desktop 2024.10.17 - 19.09.14.07.DVR.mp4` | 78 820 754 | — | mp42/isom, mp4V+mp4a, moov 在尾 | 92.3 秒录屏教程（详见 §5） |
| `登录闪退 (白屏)打开这个/webview2runtime_win7.exe` | 1 613 664 | — | 微软签名（Microsoft Code Signing PCA 2011 → **Microsoft Ireland Operations Limited**），字符串含 `SOFTWARE\Microsoft\EdgeUpdate` | **WebView2 Runtime 引导安装器**（🟡 1.6MB → Evergreen bootstrapper，非离线 standalone） |

> 细节：exe 的本地 mtime（Aug 25 18:51 +08）与 PE TimeDateStamp（2026-08-25 10:51Z）**完全一致** → 该文件发行后未再被改动；末尾 `0xF79C8D–0xF7A000` 为全 0 填充，无 overlay、无 Security Directory（未签名）。

---

## 2. 技术栈判定

### 2.1 是易语言（EPL）—— 四条独立证据 ✅

**E1｜版本资源明文自述**（最硬的证据）
```
strings -e l -n 3 -t x '闲鱼助手v4.8.2.vmp.exe' | head -30
  f751f2 DEFAULT_ICON
  f79886 VS_VERSION_INFO
  f7991e FileVersion      -> 1.0.0.0
  f7994e FileDescription  -> 易语言程序
  f79982 ProductName      -> 易语言程序
  f799e2 LegalCopyright   -> 作者版权所有 请尊重并使用正版
  f79a26 Comments         -> 本程序使用易语言编写(http://www.eyuyan.com)
```
（UTF-16LE 中文无法被 `strings` 打印，用 python 从 `0xF79886` 起按 UTF-16 解码得到完整值：`FileDescription=易语言程序`、`Comments=本程序使用易语言编写(http://www.eyuyan.com)`。）

**E2｜清单（manifest）是易语言默认程序集标识**，偏移 `0xF79AC0`：
```xml
<assemblyIdentity name="E.App" processorArchitecture="x86" version="5.2.0.0" type="win32"/>
<dependency>Microsoft.Windows.Common-Controls 6.0.0.0</dependency>
```

**E3｜导入表指纹 = 易语言静态运行库特征**（`objdump -p`）：`MSVFW32!DrawDibDraw`、`AVIFIL32!AVIStreamGetFrame`、`WINMM!midiStreamRestart`、`RASAPI32!RasGetConnectStatusA`、`MSIMG32`、`WINSPOOL.DRV`、`comdlg32`、`WININET` —— 这些与业务无关的"孤立单函数导入"正是 EPL 静态链接多媒体/系统库的特征；链接器 6.0、Subsystem=GUI(2)、machine 0x14C(32 位)。

**E4｜模块生态同款**：`edgeview.dll`（易语言 WebView2 模块，PDB 路径 `D:\EdgeView-master\epltest\edgeview.pdb`，epltest=EPL 测试工程）、`HPSocket4C.dll`（易语言常用网络库）、`sqlite3.dll 3.30.1`（易语言官方 SQLite 支持库版本）、`gzip.dll`（易语言压缩模块常见依赖）。同目录另一商业包 `C闲鱼一键搬运助手v2.1.9` 也是 `.vmp.exe`+`data.db 0 字节`+`sqlite3.dll 3.30.1`+`gzip.dll`（同一打包/生态习惯）。

### 2.2 VMProtect 保护层级 = **全节**（不是只保护入口）✅

`objdump -h` 节表：
```
Idx Name   Size      VMA       File off
 0 .text   00000000  00401000  00000000
 1 .rdata  00000000  00672000  00000000
 2 .data   00000000  009c5000  00000000
 3 .j"^    00000000  00a9d000  00000000     <- 节名乱码
 4 .aWX    00000c18  0131f000  00001000
 5 .?2m    00f72350  01320000  00002000     <- 真载荷（15.5MB，占文件 96%）
 6 .rsrc   00004c8d  02293000  00f75000
```
- 原始四个正式节（`.text/.rdata/.data`）**Size=0、raw offset=0**：原程序的代码与数据被整体搬进 VMP 节并加密。
- 入口 `AddressOfEntryPoint=0x12e396a`（VA 0x16e396a）落在 `.?2m` 内 → 文件偏移 `0x3c596a`，首 48 字节：
  ```
  e8 f3 68 23 00 66 c1 c9 ed 33 d3 33 c8 f7 da 81 ea b7 37 11 f6 86 cc c1 ca 03 42 c1 e8 c6 66 23 c0 66 c1 f8 07 ...
  ```
  即 `call` + 一串变形算术（VM 入口），**不是**标准 CRT/EPL 启动代码。
- 熵扫描（64KB 块，`python scan.py <exe> entropy`）：`0x00000000 H=7.197`（头部）→ `0x00040000 起恒为 H=7.997`（满熵 8.0），直到文件尾 → 整段为加密/压缩数据。
- 字符串零收获（见 §4）：GBK 扫描仅 25 条且全部落在 `0x2008–0x2719`（VMP stub 区）且是随机字节误判（如 `0x00002008 夦攻競`）。

**结论**：这是"整文件加密 + VMP 运行时映射"级别（类似 VMProtect 3.x 的全节/整文件模式），**静态提取业务字符串不可能**；要拿 URL/JS/SQL 只能内存 dump，本任务禁止运行 → ❓。

### 2.3 各 DLL 职责（+ 证据）

| DLL | 职责 | 关键证据 |
| --- | --- | --- |
| `edgeview.dll` / `edgeview_static.dll` | **EdgeView = 易语言 WebView2 线程隔离封装**（Admenri, LGPL-2.1，github.com/Admenri/EdgeView，README："为易语言编写的 WebView2 封装调用库，已进行线程隔离…同时借助 CDP 的功能实现原版之外的附加内容"）。程序用它内嵌闲鱼网页，并做 **document-start 注入脚本 / JS→native 消息 / 任意 CDP 调用 / CDP 事件订阅 / 读响应体** | 版本资源 `EdgeView Wrapper Proxy Library 2.1.12.0`；PDB `D:\EdgeView-master\epltest\edgeview.pdb`；内部符号：`AddHookScript`、`ExecuteScriptCDP/ExecuteScriptCDPAsync`、`CallCDPMethod/CallCDPMethodSync/Async`、`SetCDPEventReceiver`、`GetResponseBodyData(Sync)`+`ResourceResponseCallback`、`BindEventForWebView`；CoreWebView2 接口矩阵：`AddScriptToExecuteOnDocumentCreated`、`WebMessageReceived`、`CallDevToolsProtocolMethod`、`DevToolsProtocolEventReceived`、`DownloadStarting`、`GetCookies/CookieList`、`ProfileAddBrowserExtension`、`CapturePreview`、`PrintToPdfStream`、`PermissionRequested`、`NewWindowRequested`、`FrameWebMessageReceived`…；已启用 `Log.entryAdded`+`Runtime.consoleAPICalled` 事件（`ContentLoading: Runtime.enable called`） |
| `WebView2Loader.dll` | 微软官方 WebView2 loader（2024 版 1.0.2651.64） | 见 §1 版本资源 |
| `HPSocket4C.dll` | HP-Socket 5.8.8 的 C 接口（TCP/UDP/Agent/Pull/Pack + 线程池 + 压缩），**本副本没有 HTTP/HTTPS/WebSocket/SSL 导出** | 374 个导出：`HP_Agent`×55、`HP_Server`×49、`HP_UdpNode`×37、`HP_Client`×28、`HP_UdpArqServer`×24、`HP_UdpArqClient`×24、`HP_TcpServer`×14、`HP_TcpClient`×10、`HP_TcpAgent`×10、`HP_UdpCast`×10、`HP_UdpServer`×9、`HP_UdpClient`×7 + `HP_TcpPack*/HP_TcpPull*/HP_ThreadPool_*/HP_Compressor/Decompressor`；`grep -icE 'http|websocket|ssl' exports = 0` |
| `sqlite3.dll` | 本地 SQLite 3.30.1，服务 `data.db` | 版本资源 + `xl`… 见 §5 |
| `libssl-3/libcrypto-3` | OpenSSL 3.0.0，**谁加载未证实** | 对 9 个文件全字节搜索 `libssl/libcrypto/openssl`：仅 libssl/libcrypto 自身命中，exe 与各 DLL 内**没有**这些字符串（HPSocket4C 内含 "SSL environment not ready" 但导出层无 SSL 组件）→ 🟡（可能由某易语言支持库或 HPSocket SSL 分支运行时 LoadLibrary） |
| `gzip.dll` | 微软 IIS 6.0 的 gzip 实现（30KB，仅导入 KERNEL32） | 版本资源 `Internet Information Services 6.0.2600.0`；PDB `gzip.pdb` |
| exe IAT | 只导入 17 个系统 DLL（KERNEL32/USER32/GDI32/COMCTL32/ADVAPI32/OLEAUT32/ole32/SHELL32/WININET/WS2_32/WINMM/MSVFW32/AVIFIL32/RASAPI32/MSIMG32/WINSPOOL.DRV/comdlg32），**没有** edgeview/HPSocket/sqlite3/WebView2Loader | 易语言 DLL 支持库本来就运行时 LoadLibrary；叠加 VMP 改写导入 → 不能从 IAT 反推实际用到的库 |

---

## 3. 发货工作流（证据分层）

### 3.1 已证实（静态证据）
1. **规则是本地文件**：xlsx（`匹配标题` → `发货内容`）+ txt（多规格，含 规格ID/商品ID）——见 §5 逐字节解析。这说明匹配逻辑至少有两种粒度：**按标题文本匹配** 与 **按商品+规格 ID 匹配**。
2. **登录/操作发生在内嵌 WebView2 里**：包内自带 WebView2 Runtime 安装器，且卖家把安装器放在叫 `登录闪退 (白屏)打开这个` 的目录里 → 缺 runtime 时"登录界面白屏"——只有"登录页由 WebView2 渲染"才会产生这种症状。
3. **具备页面内自动化能力**：EdgeView 的 `AddHookScript`（document-start 注入）、`WebMessageReceived`（JS→易语言）、`CallDevToolsProtocolMethod`、`DevToolsProtocolEventReceived`、`GetResponseBodyData`（读响应体）——"在页面里监听/注入/抓响应"是现成能力，不需要另造轮子。
4. **有本地库但有记录层**：`sqlite3.dll` + 0 字节 `data.db` → 运行期建表，记录发货/账号/卡密状态 🟡（schema 不可得）。
5. **网络出口**：exe IAT 含 `WININET`（HTTP/HTTPS 客户端）与 `WS2_32`（socket）。

### 3.2 强推测（🟡 无法证实，但概率高）
```
[买家付款/发消息]
      │  ← 触发源：WebView2 里的闲鱼页面（IM 会话页 / 订单页 / 消息推送）
      ▼
EdgeView WebView2（登录态在 WebView2 profile 里，非本地文件）
      │  ① AddHookScript 注入 JS（document-start）
      │  ② JS 侧 MutationObserver 盯消息列表 / hook fetch·XHR / 监听 ws 帧
      │     或 ②' CDP 事件：Network.responseReceived → GetResponseBodyData 读 mtop JSON
      ▼
JS → window.chrome.webview.postMessage（WebMessageReceived）→ 易语言主程序
      ▼
规则引擎（本地）：标题匹配 xlsx「匹配标题」→ 取「发货内容」
                 多规格：规格ID/商品ID + 「卡密标题:规格」→ 取卡密
      ▼
发出去：A) 页面内填会话输入框 + 触发发送（DOM 注入 + 点击/Enter）
        B) 或调 mtop 发送接口（需 _m_h5_tk 签名，WebView2 里可直接复用页面上下文）
      ▼
写 data.db（发货记录/卡密已用标记）🟡
```

### 3.3 为什么倾向"页面内自动化"而不是"直连 mtop"
- 包内只有 16MB 单 exe + 浏览器栈：**没有** libcurl / Python 运行时 / 任何 HTTP 客户端库（除 WININET）；直连 mtop 需要 `_m_h5_tk` 签名与完整 cookie 体系，自建成本高。
- 反而把 WebView2 + EdgeView + runtime 安装器 + 92 秒"登录"教程一起打包 —— 典型"让用户在弹出的浏览器里扫码登录，剩下都靠注入"的形态。
- HPSocket 本副本**无 HTTP 组件**（0 条 HTTP 导出），若要"本地 HTTP 服务 + 页面回调"这种桥接架构就做不到用 HPSocket 实现 → "HPSocket 起本地 HTTP 服务给 WebView2 当后端"的假设基本排除；🟡 剩下的可能：TCP 客户端连授权服务器（卡密校验/公告/心跳），或不经 HPSocket 用别的方式。

### 3.4 不可得（❓，因为全节加密 + 禁止运行）
- 具体 mtop 接口名（`mtop.idle.*` / `mtop.taobao.idlemessage.*` 等）与页面 URL（`goofish.com`/`/h5/`/`wss-goofish`）——**无法给出证据**，不做断言。
- 是否真的用 WS / 是否有本地监听端口 / 端口号。
- 中文菜单文案、界面流程、注册表键、窗口类名。
- 建表 SQL。
> 想在拿到这些，只有内存 dump 或抓包（运行程序）——本次禁止，且该 exe 未签名+VMProtect+来路不明，风险不值得。

---

## 4. 字符串证据汇总

```
S=/c/mingw64/mingw64/bin/strings
$S -n 6 <file> | wc -l          # ASCII 可打印串条数
$S -e l -n 6 <file> | wc -l     # UTF-16LE 条数
$S -n 6 '闲鱼助手v4.8.2.vmp.exe' | grep -aIiE 'http|mtop|goofish|wss|taobao|hpsocket|edgeview|sqlite|webview' | wc -l   # => 0
```

| 文件 | ASCII 串条数 | 有用命中 | 代表性样本（带偏移） |
| --- | --- | --- | --- |
| `闲鱼助手v4.8.2.vmp.exe` | **24 537** | **0**（URL/域名/API/中文全无） | 唯一可读区在 `.rsrc`（0xF75000 起）：UTF-16 共 15 条 —— `DEFAULT_ICON@0xF751F2`、`VS_VERSION_INFO@0xF79886`、`FileVersion/FileDescription/ProductName/ProductVersion/LegalCopyright/Comments@0xF7991E–0xF79A4C`、`manifest@0xF79AC0`（`name="E.App" version="5.2.0.0"`） |
| `HPSocket4C.dll` | 1 736 | 库元信息 | `C:\Users\Administrator\Desktop\Windows\Lib\HPSocket4C\x86\HPSocket4C.pdb`、`HP_GetHPSocketVersion`、`HP-Socket` |
| `WebView2Loader.dll` | 500 | 官方 loader 诊断串 | `WebView2: Failed to find an installed WebView2 runtime…`、`D:\a\_work\e\src\out\Release\WebView2Loader.dll.pdb`、`CreateCoreWebView2EnvironmentWithOptions` |
| `edgeview.dll` | 2 195 | 模块能力面（见 §2.3） | `\EdgeView-master\epltest\edgeview.pdb`、`D:\EdgeView-master\console_debug.log`、`D:\EdgeView-master\menu_debug.log`、`<html lang="zh-CN">`、`CDP Raw JSON: %s`、`Runtime Raw JSON: %s`、`OnConsoleMessage called`、`Log.enable HRESULT` |
| `edgeview_static.dll` | 2 011 | 同上 | 同族差异仅 static 链接方式 |
| `sqlite3.dll` | 1 602 | 标准 SQLite | `3.30.1`、`sqlite3_*` API |
| `libcrypto-3.dll` / `libssl-3.dll` | 18 239 / 3 482 | OpenSSL 3.0.0 | `OpenSSL 3.0.0 7 sep 2021`、`D:\CFILES\Projects\WinSSL\openssl-3.0.0\…`（第三方 WinSSL 构建） |
| `gzip.dll` | 40 | 微软旧件 | `gzip.pdb`、`LocalAlloc/LocalFree` |

**中文界面文案：拿不到** ✅（这是本次的硬结论）。理由：① 全部中文在加密载荷里；② GBK 扫描 exe 仅 25 条命中且全为 `0x2008–0x2719` 的随机字节误判；③ `strings` 无法从高熵区提取 → 静态证据链闭合，不是"没找到"而是"不可能找到"。

---

## 5. `data.db` / `发货文件.xlsx` / `多规格发货列表.txt` / 教程视频

### 5.1 `data.db`
- **0 字节**，无 `SQLite format 3\0` 头 → 不是"空 schema 的合法库"，而是"文件被创建、尚未写入/或退出时被截断"。`（stat 显示 0，与 `sqlite3.dll` 同包）`
- 因此**没有可恢复的 schema**；建表 SQL 在加密 exe 内 ❓。
- 🟡 推测表：账号/登录态、卡密池（含已用标记）、发货记录（商品ID/规格ID/买家/时间）、配置。依据：同类工具普遍这么存；且同名文件在另一商业包（`C闲鱼一键搬运助手v2.1.9/data.db`）也是 0 字节。

### 5.2 `发货文件.xlsx`（规则表，逐格验证）
```
xl/worksheets/sheet1.xml: <dimension ref="A1:B4"/>  单 sheet，名 "Sheet"
A1=匹配标题        B1=发货内容
A2=测试1           B2=马上发货咯稍等
A3=测试2           B3=111111111111
A4=手机            B4=11111111111111
列宽 A=43.01、B=37.01；A 列样式 s=1，B 列部分 s=2
```
- `docProps/app.xml`：`<Application>wijmo.xlsx</Application><Company>GrapeCity, Inc.</Company>`（**Wijmo 电子表格库生成的 xlsx**，说明模板源头是 JS/.NET 的 Wijmo 导出）
- `docProps/core.xml`：`lastModifiedBy=小白`，created=2024-09-14T09:11Z，modified=2024-09-15T11:54:30Z
- `docProps/custom.xml`：`KSOProductBuildVer=2052-12.1.0.18276`（**WPS Office 12.1**保存过）
- 语义：**两列纯文本映射**，A 列是"匹配用标题/关键字"，B 列是"要发出去的整段文本"（示例里既可能是卡密 `11111111111111`，也可能是话术 `马上发货咯稍等`）→ 说明该表同时支持"发卡密"和"发固定话术"。

### 5.3 `多规格发货列表.txt`（多规格卡密表，逐字节验证）
`123` 字节，GBK，CRLF：
```
2-----1072903926162-----腾讯会员:电脑7天-----AAAAAAAAAAAAAAAA
1-----1072903926162-----腾讯会员:安卓手机7天-----BBBBBBBBB
```
- 前 40 字节 hex：`32 2d2d2d2d2d 31303732393033393236313632 2d2d2d2d2d cc tad1b6bbe1d4b1 3a b5e7c4d437ccec 2d2d2d2d2d 41...`
- 分隔符 = **5 个 ASCII 连字符** `-----`；行尾 `0D 0A`。
- 字段（按分隔符切）：`规格ID` | `商品ID` | `卡密标题:规格名` | `发货内容`
  - 规格ID：`2`/`1`（小整数，🟡 疑为闲鱼 SKU 序号或本地规格序号）
  - 商品ID：`1072903926162`（同一商品的多个规格）
  - 第三段冒号前后：`腾讯会员` : `电脑7天` / `安卓手机7天`（🟡 我判为"卡密标题:规格名"；用户线索写作"卡密标题:卡密文本"，从两条样例看冒号后是**规格描述**而非卡密本身，卡密在第 4 段）
  - 第 4 段：`AAAAAAAAAAAAAAAA` / `BBBBBBBBB`（真实卡密，示例长度 16/9 不等）
- 价值：这是"**同商品多规格**必须按 规格ID 区分"的格式，比单纯标题匹配稳。

### 5.4 教程视频（不逐帧，只看容器层）
- 78 820 754 B；顶层 box：`ftyp@0x0(24)` + `mdat@0x18(78 712 627)` + `moov@0x4B10F4B(108 103)` → **moov 在文件尾**（非 faststart，录屏工具常见）。
- `mvhd@0x4B10F57`：version/flags=`00000000`，creation=3812008154（1904 纪元 ≈ **2024-10-17**，与文件名一致），timescale=1000，**duration=92 300 → 92.3 秒**。
- 编码：`mp42/isom` 容器，轨 `mp4V`（MPEG-4 Visual）+ `mp4a`（AAC）；moov 内无 `Lavf`/`encoder`/工具名标签（未扫全 78MB，只在 moov/尾部取样）。
- 结论：只有 **1 分半**的演示录屏（`Desktop 2024.10.17 - 19.09.14.07.DVR.mp4`，DVR 命名风格），大概率演示"填表→登录→收消息→自动发货"，**不含文档/README**；功能本身轻薄。

---

## 6. 对我们的价值（借鉴 / 坑）

### 6.1 值得借鉴 ✅
1. **规则表极简到两列**：`匹配标题 | 发货内容`。用户零学习成本，同时能发卡密与发话术（同一列）。→ DSH 发货规则可以直接照抄这个"键=标题/关键字，值=整段文本"的模型。
2. **多规格用"规格ID+商品ID"双键**（`多规格发货列表.txt`）：解决"同商品不同 SKU 卡密不同"的真实痛点；比"标题含规格"更确定。格式 `规格ID-----商品ID-----卡密标题:规格-----发货内容` 可直接做导入器（5 连字符 + CRLF + GBK 需注意编码兼容）。
3. **注入式自动化架构**（EdgeView 那套，等价能力我们用 CDP/Playwright 实现）：document-start 注入 hook + `postMessage` 回传 + `Network.responseReceived`→`getResponseBody` 抓 mtop 响应。这套"网页里跑 JS、宿主只做规则与发卡"的分层，正好是我们 daemon 的形态。
4. **三层解耦**：登录态（WebView2 profile，系统目录）｜规则（用户可编辑的外部文件）｜记录（SQLite）——互相独立，用户换规则不用重登录。值得照搬。
5. **交付物友好**：xlsx + txt 双格式，卖家不用教用户改 json。我们要做"规则导入/导出"时优先 xlsx/csv。

### 6.2 要避开的坑 ❌
1. **VMProtect 全节加密 = 闭源不可静态审计**：本次花在字符串取证上的努力基本空转（24,537 条 ASCII 全噪声）。反过来验证了"要么开源、要么只能黑盒"这条铁律——我们不要再浪费算力做"加密商业 exe 的静态字符串挖掘"。
2. **易语言 + 32 位 + 依赖 WebView2 Runtime**：Win7 用户必然"登录白屏/闪退"（卖家自己都得塞 runtime 安装器）。DSH 是 TS/Node，无此包袱，别学。
3. **未签名 exe + VMProtect + 来路不明**：运行风险极高（盗号/木马不可排除；本次禁运行是对的）。我们任何"试用他方商业工具"的流程都应先隔离 VM。
4. **HPSocket 本副本没有 HTTP/WS 组件**：任何"用 HPSocket 起本地 HTTP 服务当桥"的想法在这套技术栈上不成立；我们要本地桥接直接用 Node HTTP 更简单。
5. **许可证**：打包的 EdgeView 是 **LGPL-2.1**，被闭源商业包以 DLL 形式直接分发，包内**无 LGPL 声明、无源码/替换说明** → 合规瑕疵。我们若引用任何 GPL/LGPL 组件，必须附声明。
6. **教程只有 92 秒**：说明产品力集中在"规则表 + 一键发送"，"智能"部分几乎没有；不要高估这类工具的复杂度。

---

## 7. 限制与未解
- **禁止运行 exe** → 无内存 dump、无抓包 → URL / mtop 接口名 / 本地端口 / 中文菜单 / CREATE TABLE 全部 ❓。这是本笔记最大的空白，且**无法通过静态手段弥补**（已用熵/节表/字符串三重证据确认）。
- `.rar` 原包（39MB）**未解压验证**：环境无 `7z/unrar/rarfile`，未确认包内是否另有说明书/截图（从解压目录看，内容就是程序+示例文件+1 段教程视频，rar 大概率同构）。
- **无 ffmpeg/ffprobe** → 未抽帧 OCR 教程视频（若确实需要菜单文案，唯一合法途径是看这 92 秒视频，成本：安装 ffmpeg 抽帧 → OCR）。
- 兄弟包 `C闲鱼一键搬运助手v2.1.9`（24MB `.vmp.exe` + `ACFlib`/`libcurl.dll`/`tabControl/` + 0 字节 `data.db`）仅作对照，未深入（不属本任务）。
- 外部佐证（网络，非本机证据）：`github.com/Admenri/EdgeView`（README：易语言 WebView2 封装、线程隔离、CDP；LICENSE：LGPL-2.1）；精易论坛帖"EdgeView 有没有办法获取到响应文本"、"EdgeView 拦截请求后如何自定义响应"——侧证该模块具备请求拦截/响应体读取能力（与 §2.3 符号证据一致）。

---

## 8. 复现命令（关键几条）
```bash
D='research/repos/unpacked/(v4.8.2)闲鱼自动发货助手'
objdump -h  "$D/闲鱼助手v4.8.2.vmp.exe"                 # 节表：原节 Size=0 → VMP 全节
objdump -p  "$D/闲鱼助手v4.8.2.vmp.exe" | grep 'DLL Name'   # 17 个系统 DLL，易语言导入指纹
strings -n 6 "$D/闲鱼助手v4.8.2.vmp.exe" | wc -l        # 24537（全噪声）
strings -e l -n 3 -t x "$D/闲鱼助手v4.8.2.vmp.exe"      # .rsrc 里 15 条 UTF-16（版本资源+manifest）
python .scratch/scan.py "$D/闲鱼助手v4.8.2.vmp.exe" entropy   # 0x40000 起 H=7.997
python .scratch/scan.py "$D/闲鱼助手v4.8.2.vmp.exe" gbk 3 25  # 25 条，全是乱码误判
for f in "$D"/*.dll; do objdump -p "$f" | grep 'DLL Name'; done
objdump -p "$D/HPSocket4C.dll" | sed -n '/Export Address Table/,$p' | grep -oE 'HP_[A-Za-z0-9_]+' | sort -u   # 374 个，无 HTTP/WS/SSL
python - <<'EOF'
import zipfile; z=zipfile.ZipFile("$D/发货文件.xlsx")
print(z.read('xl/worksheets/sheet1.xml').decode()); print(z.read('docProps/app.xml').decode())
EOF
python -c "print(open('$D/多规格发货列表.txt','rb').read().decode('gbk'))"
```
（辅助脚本：`.scratch/scan.py`（GBK/ASCII/熵扫描）、`.scratch/ep.py`（PE 入口偏移换算）、`.scratch/mp4.py`（moov/mvhd 解析）、`.scratch/x4.py`（全部 DLL 版本资源）。）
