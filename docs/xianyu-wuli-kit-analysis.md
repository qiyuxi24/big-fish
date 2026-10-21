# 「闲鱼虚拟项目」套件逆向分析（第三个包）

> 📦 历史调研快照（2026-10-20）。结论已并入 [STATUS.md](STATUS.md) 与 [architecture.md](architecture.md)，保留作证据；当前状态不必读本文。

> 分析对象：`research/repos/闲鱼一键搬运助手.rar`（87,770,486 B，2026-10-20 19:43），解压目录 `research/repos/闲鱼一键搬运助手/`
> 方法：文件清点 + PDF 全文提取 + Chrome 扩展源码通读 + 截断 ZIP 抢救 + Inno Setup 载荷解压 + PyInstaller 冻结模块清单还原
> 结论一句话：**这不是"又一个搬运工具"，而是「雾里」卖课/卖软件的四件套**——安装包（残缺）+ 阿奇索会话窃取插件 + AI 改写 prompt + 16 页操作手册。它的发布通道是**阿奇索 SaaS 的内部网页接口**，不是直连闲鱼。

---

## 1. 包里到底是什么（四件套）

| 文件 | 实际内容 | 判定 |
| --- | --- | --- |
| `人物设定.txt`（1,066 B, UTF-8 CRLF） | 闲鱼虚拟资源 listing 的 **AI 改写 prompt** | 可用素材 |
| `闲鱼虚拟项目及软件详细操作指南-_1_.pdf`（4.1 MB / 16 页，另有一份重复副本） | **雾里闲鱼搬运助手 3.20** 使用手册（©2025 雾里，微信 WuL983） | 官方教程 |
| `阿奇索插件.zip`（29,845 B） | MV3 扩展「阿奇索头信息获取工具」v1.0，**抓 aldsidle.agiso.com 的 Cookie + Authorization** | 关键：会话窃取器 |
| `雾里闲鱼搬运助手3.20.tmp`（76,843,000 B） | **其实是 ZIP**（PK 头），单条目 `雾里闲鱼搬运助手3.20.exe`（csize 81,438,586）→ **下载不完整**（无中央目录/EOCD） | 需重新下载 |

厂商：雾里（微信 WuL983）。商业模式：**免费试用 3 天 → 25 元/月**；多店铺订单可配"易店助手"（免费版一号可用，赞助版 99 元/年绑 5 店）。

### 1.1 PDF 手册里的完整工作流（16 页，文本仅 3,268 字，其余是截图）

1. **获取闲鱼 Cookie**：软件内置「闲鱼 Cookie 提取器」，扫码登录官方网页版后点"一键获取 Cookie"。
2. **采集**（两种）：
   - 店铺 ID 批量采集：手机闲鱼分享店铺主页 → 电脑打开 → URL 里取 `userid=2220706022154` 粘进软件，支持多家店铺每行一个；
   - 关键词搜索采集；还能「批量获取卖家 ID」先把同行卖家 ID 攒出来再逐个分析。
3. **风控**：采集滑块与搜索滑块都要**手动过**，过完必须重新获取一次 Cookie（与 goofish-cli 的 x5sec-recovery 结论一致：过滑块后 session 会被刷新）。
4. **发布通道 = 阿奇索（agiso）SaaS**，不是直连闲鱼：
   - 装「阿奇索插件」→ 打开 `https://aldsidle.agiso.com/` 注册登录（91 账号）→ 绑定 91 卡券 → **无需开通阿奇索会员**（原文："我们只需要用到它的发布接口"）；
   - 点插件图标复制 **Authorization 和 Cookie**，填进搬运助手（"注意不要填反"）；
   - 填店铺名称（随意）、库存（未开鱼小铺填 1 / 已开通填 9999）→ 添加店铺；
   - 参数**有时效**：每天发布前重新获取，可清空后 F5 刷新；过期就次日填新值点保存。
5. **发布**：选爆款商品 → 选发布城市 → 一键发布；支持统一加价（填 1）/降价（填 -1）与筛选条件。失败原因只列两条：**闲鱼账号未实名**、**账号违规被扣分**。
6. **爆单经验**（手册原文）：第一天采集、第二天看「想要增量」判断同行哪个品在出单；避免机构名/人名/个人 IP 类课程资料，选弱版权品；页脚免责"需人工审核，侵权违规后果使用者自负"。

---

## 2. 阿奇索插件：技术上是"偷自己的会话"

`research/repos/unpacked/agiso-plugin/阿奇索插件/`（MV3，全部源码已读）：

- `manifest.json`：permissions = `webRequest, storage, scripting, clipboardWrite`；host_permissions 仅 `https://aldsidle.agiso.com/*`。
- `background.js` 核心只有一处：
  ```js
  const TARGET_URL = 'https://aldsidle.agiso.com/api/User/GetUserInfo';
  chrome.webRequest.onBeforeSendHeaders.addListener(details => {
    if (details.url.includes(TARGET_URL)) { /* 从 requestHeaders 取 Cookie 和 Authorization */ }
    return { requestHeaders: details.requestHeaders };
  }, { urls: ['https://aldsidle.agiso.com/*'] }, ['requestHeaders', 'extraHeaders']);
  ```
  抓到后存 `chrome.storage.local`，光标 badge 显示「新」。
- `popup.js`：显示/一键复制 Cookie、Authorization、全部信息、清空。

**含义**：这是标准的"**用你自己的登录会话，绕开它的网页 UI 直接打内部 API**"套路。README 写"仅本地存储、不发第三方"——但复制出来的 Cookie/Authorization 恰好是要粘进**闭源桌面软件**的，等于把阿奇索账号会话交给了第三方软件。对阿奇索是明确违反 ToS，对用户是账号被滥用/被风控的风险。

---

## 3. 安装包抢救与静态还原（Inno Setup → PyInstaller/PyQt6）

`.tmp` 是截断下载，脚本 `.scratch/wuli/inflate.py` 解析 zip 本地头 + `zlib.decompressobj(-15)` 逐块解压，得到 **77,337,919 B** 前缀（`.scratch/wuli/wuli320_prefix.exe`，尾部缺失约 4 MB，不可执行）。

### 3.1 外层：Inno Setup 安装器

- PE32 i386 GUI，11 节，TimeDateStamp **2026-02-11 11:40:27**，导入仅 kernel32/comctl32/user32/oleaut32/advapi32。
- 版本资源：`Comments="This installation was built with Inno Setup."`、`CompanyName="wuli"`、`FileDescription="雾里闲鱼搬运助手 Setup"`。
- 字符串含 `Embarcadero Delphi for Win32 compiler version 36.0`、`Compression.LZMA1SmallDecompressor` → 安装器是 Delphi(Inno) 写的壳，**程序本体在压缩载荷里**。

### 3.2 载荷：一个 PyInstaller 冻结的 PyQt6 应用

对全文件扫 zlib 流（0x78 0x01/0x5E/0x9C/0xDA 头）得到 **836 个可解压流**，逐个解压后发现大量 **Python 字节码（marshal .pyc）**，其中出现 PyInstaller 特征路径 `modules/_pyi_rth_utils/__init__.py`、`PyQt6/__init__.py`，以及 pandas/numpy/matplotlib/openpyxl/PIL/cryptography/requests/jinja2/arrow/sqlite3。

**还原出的应用模块（co_filename 证据）**：

```
api/api_manager.py      api/base_client.py     api/config.py
api/data_signature.py   api/gitee_config.py    api/heartbeat_api.py
api/init_api.py         api/login_api.py       api/rc4_encryption.py
api/reg_api.py          api/trial_api.py
multi_shop/multi_shop_config_dialog.py
multi_shop/multi_shop_order_monitor.py
category_config.py      ai_rewriter.py         ebook_utils.py
```

一个完整的模块还在可读范围内（`multi_shop/multi_shop_order_monitor.py` 的 .pyc 原文）：

> "多店铺订单监控线程 / 支持监控多个阿奇索店铺的待发货订单" — class MultiShopOrderMonitor(QThread)，持有 `auth_token`、`cookie`、`publish_configs`（每店铺配置），方法 `load_mapping/save_mapping`（`order_mapping.json`）、`load_publish_configs`、`find_original_link`、`find_link_in_excel`、`preprocess_title/title_matcher`（Excel 标题模糊匹配），端点 `https://aldsidle.agiso.com/api/Trade/List`。

→ 业务闭环是：**采集（闲鱼 Cookie 直连）→ AI 改写 → 阿奇索接口发布 → 阿奇索待发货订单轮询 → Excel 标题匹配订单→货源链接 → 自动发货/补发**。

### 3.3 授权/加壳体系（卡密 + 心跳 + RC4 + Gitee 热更）

解出的 `api/*` 全链路接口（同一模块内）：

```
/api/init  /api/reg  /api/login  /api/logout  /api/login_info  /api/user_get
/api/heartbeat  /api/update  /api/upload  /api/notice  /api/soft_info
/api/use_carmi_get  /api/use_carmi_set  /api/use_carmi_list  /api/use_carmi_deduct
/api/deduct_point  /api/deduct_time  /api/recharge
/api/bind_list  /api/un_bind  /api/un_bind_all  /api/waf_add
/api/cloud_data_set  /api/file_data_get  /api/file_data_set  /api/temp_data_get  /api/temp_data_set
/api/variable_get  /api/variable_set  /api/variable_del  /api/user_param_get/set/list
/api/formula_get  /api/call_func
```

配套 `data_signature.py` + `rc4_encryption.py`（请求签名/加密）、`trial_api.py`（3 天试用）、`heartbeat_api.py`（在线心跳，掉线即停）、`gitee_config.py` + 路径 `/api/v5/repos/wul983/xianyu/contents/`（**Gitee v5 API**，更新源 = gitee.com/wul983/xianyu，现已不可访问）。

> 判定：这是国内通用的"网络验证/卡密授权 SaaS 框架"标准形态（一套接口名在多家发卡系统里通用）。**软件本体没有逆向难度，难度全在外层授权壳 + PyInstaller 打包。**

### 3.4 其他能确认的细节

- 界面框架 PyQt6；数据处理 pandas/numpy/matplotlib（对应手册的"商品数据分析、按列排序、想要增量"）；Excel 读写 openpyxl。
- `ebook_utils.py` + `ai_rewriter.py`：扫描本地电子书（`.pdf|.epub|.mobi|.azw3|.txt`，`EbookManager.scan_ebooks`）、正则清理书名、`baidu_cookie` → 百度百科取书名/作者（`https://baike.baidu.com/item/`）、AI 改写 → 说明厂商同一套代码还卖"电子书资源包"。
- 安装包内所有 `/api/` 路径**只有** 阿奇索 `/api/Trade/List` 与自带授权接口，**没有任何 `/api/Product/*`、`/api/Publish` 或 mtop 发布接口**——发布调用在缺失的尾部 4 MB 里，或由界面层动态拼装（当前无法证实，标记为**待验证**）。

---

## 4. 阿奇索这条通道到底是什么（本轮新查证）

- 阿奇索「**商品铺货**」（`gds.agiso.com`）官方能力：添加/授权店铺 → 从店铺下载商品 → 批量铺货到同平台其它店铺；**官方明确"已支持闲鱼、小红书、拼多多 3 个平台"**，且"不同店铺需要分别订购"。（[agiso.com/detail/2088](http://agiso.com/detail/2088)）
- 阿奇索「**开放平台**」（`open.agiso.com`）覆盖的是**订单数据/自动发货/标准货源**，签约平台含闲鱼；文档要联系客服索取。（[agiso.com/detail/1552](https://www.agiso.com/detail/1552)）
- `aldsidle.agiso.com` 是「闲鱼自动发货/铺货」的商户后台 Web 端（SPA，首页 814 B 空壳，和 goofish 一样靠 XHR）。雾里打的 `/api/User/GetUserInfo`、`/api/Trade/List` 就是它的内部 Web API。

**所以雾里的路线是**：不用闲鱼官方权限、不逆向 mtop 签名，而是**借阿奇索这个"已获授权的第三方 ERP"的网页会话，替自己调它的铺货 API**。这解释了手册里为什么"无需开通阿奇索会员""失败原因只有未实名/扣分"——发布动作在阿奇索侧完成，闲鱼侧只看到合法第三方应用的调用。

**这条路的代价**：① 违反阿奇索 ToS，账号可被封；② 依赖对方内部接口，对方一改即失效（已有"参数每天过期"的迹象）；③ 用户必须自己注册 91/阿奇索账号并绑定卡券；④ 采购/发布数据全部经过第三方，隐私与合规风险。

---

## 5. 三种商业工具横向对比（更新版）

| 维度 | v4.8.2 自动发货助手 | v2.1.9 一键搬运助手 | **3.20 雾里搬运助手（本次）** |
| --- | --- | --- | --- |
| 技术栈 | 易语言 5.x + VMProtect + WebView2(EdgeView 2.1.12) | 易语言 + ACF 自建 Chromium 131(241MB) | **Inno Setup + PyInstaller 冻结 PyQt6（Python）** |
| 加壳/授权 | VMProtect 全节加密，无授权体系 | VMProtect 全节加密，无授权体系 | 无 VMProtect，**卡密/试用/心跳/RC4/Gitee 热更** |
| 体积 | 100 MB | 371 MB（内核占大头） | 安装包 81 MB（解释器+pandas栈） |
| 读侧（采集） | 无（只做发货） | 真浏览器内注入 JS | **闲鱼 Cookie 直连 + 内置 Cookie 提取器** |
| 写侧（发布） | 无 | 自建内核直接操作网页发布 | **阿奇索 SaaS 内部 API（盗用会话）** |
| 订单侧 | IM 监听 + 规则表 xlsx | 无 | **阿奇索 /api/Trade/List 多店铺轮询 + Excel 标题匹配** |
| 商业模式 | 破解/灰产流通 | 破解/灰产流通 | 3 天试用 → 25 元/月（正规发卡） |

**关键结论**：三家都没有解决"闲鱼官方发布权限"这个根本问题——两家靠自己造浏览器，一家靠借第三方 ERP 的会话。这也是我们方案里"通道矩阵"必须并列存在的根本原因。

---

## 6. 对我们的启示（可直接落到设计）

**可借鉴（4 条）**
1. **AI 改写层**：`人物设定.txt` 是现成的 listing 文案工程化模板（标题 ≤30 字、`【自动发】`前缀、4 段式描述、5 个话题标签、纯 JSON 输出），可直接进我们的"文案生成"prompt 库，按类目做变体。
2. **订单→货源映射**：`order_mapping.json` + Excel 标题模糊匹配（`preprocess_title`/`title_matcher`）是自动发货的实用兜底；我们的事件驱动队列里要保留"人工映射表"作为降级路径。
3. **多店铺并发模型**：每店铺一份 `{auth_token, cookie, publish_configs}`，线程/QThread 轮询——等于我们说的"一账号一凭据"，但它是**线程**，我们升级为**进程隔离 + 单账号 QPS 闸门**。
4. **凭证时效管理**：手册"参数有时效，每天重取"正好印证我们的"凭据快照 + 过期前主动续期 + 过期即停写"设计。

**不借鉴（4 条）**
1. 盗用第三方 SaaS 会话（ToS 违规 + 可随时封/失效 + 数据经手第三方）。
2. 卡密+心跳+RC4+Gitee 热更这套"国内软件授权壳"（对商家工具没意义，还引入远程开关风险）。
3. PyInstaller 冻结整条 pandas/matplotlib/PIL 栈（安装包 81 MB、内存占用不可控——正是用户关心的"性能"反面教材）。
4. 搬运思路本身（重复铺货 = 平台违规；我们只做"搬自己的商品"）。

**通道矩阵更新（第 4 条通道）**

| 通道 | 是否合规 | 门槛 | 稳定性 | 结论 |
| --- | --- | --- | --- | --- |
| A 官方闲管家 open.goofish.pro | ✅ | 鱼小铺 + 订购 ERP | 高 | 有资质商家首选 |
| B mtop 直连（XianYuApis 等） | ⚠️ 逆向签名 | 无 | 中（接口漂移） | 只读灰度 |
| C CDP 接管真 Chrome | ⚠️ 平台协议 | 无 | 高（页面变了会坏） | 发布主力 |
| **D 借第三方 SaaS 网页会话（阿奇索等）** | ❌ ToS + 授权风险 | 需自注册 91/阿奇索 | **低（对方内部 API）** | **只做兜底调研，不实现** |

---

## 7. 风险清单

1. **安装包残缺**：`.tmp` 缺尾部约 4 MB，无法安装/运行；要验证真行为必须重新完整下载（或让用户提供完整包）。
2. **会话窃取插件**：把阿奇索 Cookie/Authorization 交给闭源软件，等于把账号控制权外借；建议在隔离环境/小号使用。
3. **闭源不可验证**：无签名、内嵌 PyInstaller 载荷、有 `/api/call_func`（远程函数调用）与 `/api/update`（远程热更）——**理论上厂商可远程下发任意代码**，这是比 VMProtect 更实际的后门面。
4. **素材侵权**：`ebook_utils.py` 业务链（电子书 + 百度书名 + AI 改写）指向"盗版电子书/课程资源"，手册自己也写"避免机构名/人名/个人 IP"。
5. **重复铺货**：搬运同行爆款 = 平台明令违规，封号概率高；文档已把"侵权违规后果"甩给使用者。
6. **数据合规**：采集到的同行店铺商品、卖家 ID、订单标题（含买家信息）经第三方 SaaS，个人信息保护法风险。

---

## 8. 待验证 / 下一步

- [ ] 需要用户**重新下载完整 3.20 安装包**（81.4 MB 的 `雾里闲鱼搬运助手3.20.exe`），才能确认发布接口与运行时行为（也可在隔离沙箱跑一次抓包）。
- [ ] 阿奇索铺货内部 API 的**发布端点**未取到（在丢失的尾部）；如要复现，只能抓包，不建议做。
- [ ] 我们自己的实现**不引入任何第四条通道**；C 通道（CDP 接管真 Chrome）继续作为发布主力，A 通道作为有资质商家的首选。

---

*本文所有结论的原始证据：`research/repos/闲鱼一键搬运助手/`（PDF/插件/prompt）、`research/repos/unpacked/agiso-plugin/`、`.scratch/wuli/wuli320_prefix.exe`（抢救出的 77 MB 前缀）与 `.scratch/wuli/streams/`（836 个 zlib 流中筛出的可读模块）。*
