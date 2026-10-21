# 与「闲鱼一键搬运助手 v2.1.9」的功能对齐（逆向结论 + 覆盖计划）

> 状态：2026-10-21 起草。**逆向只做到静态层**，未运行该程序；功能面是「组件能力 + 品类惯例」的推断，
> 不是从明文里读出来的承诺。逐项置信度在 §3 标注 `[确定]` / `[推断]`。
> 合规结论见 §5：**核心搬运链路（复制他人素材再发布）不实现**，只做红名单子集。
> 采集解析器的实现见 `packages/channel-mtop/src/reference.ts`（本文件 §7）。

## 1. 逆向对象

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `闲鱼搬运助手v2.1.9.vmp.exe` | 24,178,688 B | x86、易语言（E.App manifest）、VMProtect 全节加密 |
| `libacf.dll` / `libacf_Caller.dll` | 3,356,672 / 368,128 B | Admenri Chromium Framework（MIT，`github.com/Admenri/acfwrapper`） |
| `libcurl.dll` / `sqlite3.dll` / `gzip.dll` | 7.70 / 3.30.1 / — | 网络、本地库、压缩 |
| `ACFlib/` | 341 MB | 官方 Chromium 131.0.6778.76（x64，含 chrome.exe / chrome_proxy.exe） |
| `tabControl/` | 1 MB | 纯 UI 壳（jQuery + zui + chrome-tabs），WebMessage 协议已全部读出 |
| `data.db` | 0 B | 空库，运行期才建表 |

静态结论（细节见 `research/notes/E-repost.md`、`docs/xianyu-commercial-tools-analysis.md` §3）：

- 业务层**零明文**：PE 里 `.text/.rdata/.data/.ulO` 的 rawsize 全为 0，载荷在 `.ne[`（24,149,664 B）；
  9 个标记串（`http://`、`goofish`、`mtop`、`_m_h5_tk`、`x5sec`、`.jpg`、`cookie` 等）全 0 命中；
  GBK 汉字对密度 10.4% ≈ 随机基线 10.3% —— 即**看不出是中文程序**，VMProtect 把字符串表也加密了。
- 导入表被替换成 stub，业务 DLL 全走 LoadLibrary/GetProcAddress；导出只有 12 个 `e2ee_Cache*`。
- **因此静态拿不到**：URL、mtop 接口名、注入脚本、CSS 选择器、账号目录结构、授权/卡密机制。
  唯一途径是脱壳或运行；本项目**明确不运行**（未签名 + VMProtect + 疑似破解分发，见 §5 风险）。

## 2. ACF（libacf）能做什么 —— 决定「搬运流程」的形态

`[确定]`（来自 ACF wrapper 的公开头文件与导出符号）

- `AcfEnvironment::CreateEnvironment(browser_path, extra_command_line, {user_data_dir})`；`CreateProfile{storage_path, incognito, cookie 策略, host_mapping_rules}`
- `AcfFrame::GetDOMDocument / ExecuteJavascript / QuerySelectorAll`；`AcfDOMNode::{GetElementAttribute, GetElementInnerText, GetAsMarkup}`
- `AcfFunctionFactory / FunctionHandler / PromiseResolver`：注册页面可 `await` 的 native 函数
- `AcfResourceHandler / ResponseFilter`：**拦 XHR 响应体**（不用自己算 mtop 签名）
- `AcfCookieManager / CookieVisitorSync`、`AcfURLRequest`、`AcfDevtoolsMessageObserver`、`GetKernelVersion`
- `extra_command_line` 可塞 `--proxy-server`；免费版无 `Ex_*` 导出（无指纹魔改），S5 认证代理是 Ex 版（100 元/月）专有

对我们的意义：它用**内置浏览器 + 页面上下文**做所有平台交互（登录态天然复用、签名由页面自己算），
而我们的 publish 走的是同一条思路（CDP + 真实浏览器），只是没做「采集」和「图片」这两段。

## 3. 功能面推断（13 项）

| # | 功能 | 置信度 | 依据 |
| --- | --- | --- | --- |
| 1 | 多账号（一账号一 user_data_dir / Environment） | 推断 | `CreateEnvironment` 的 user_data_dir 参数 + 属性表惯例 |
| 2 | 内置浏览器多标签（tabControl 自绘 UI） | 确定 | `tabControl/` 资源与 WebMessage 协议 code 0..6 |
| 3 | 采集源商品（列表遍历 + 详情字段） | 推断 | DOM 抓取能力 + 详情 mtop 常态 |
| 4 | 图片批量下载（libcurl） | 推断 | libcurl + `.jpg` 用途惯例 |
| 5 | 图片处理（改名/压缩/去重 MD5/尺寸） | 推断 | gzip.dll + 本地库去重指纹惯例 |
| 6 | 文案改写（前后缀/关键词替换/模板） | 推断 | SQLite 配置表 + 无模型依赖的体积 |
| 7 | 改价公式（加价/抹零/尾数） | 推断 | 本地库配置 + 批量任务形态 |
| 8 | SQLite 本地库（账号/商品/任务/去重指纹） | 确定 | sqlite3.dll + data.db |
| 9 | 批量任务队列 + 重试 | 确定 | 搬运类工具的共有骨架 + 本地库 |
| 10 | 页内 fetch 调 mtop（复用 `_m_h5_tk`/`tfstk`/`x5sec`） | 推断 | ResourceFilter + CookieVisitor 组合 |
| 11 | 代理（免费版仅 `--proxy-server`，无认证） | 确定 | extra_command_line 能力与 Ex 版差异 |
| 12 | Ex 版指纹伪装 | 确定（仅 Ex） | 导出表无 `Ex_*` |
| 13 | 授权/卡密/定时上新监控 | 不可得 | 全在加密段里，静态无证据 |

## 4. 覆盖映射（我们 vs 它）

| 能力 | 我们现在的状态 | 结论 |
| --- | --- | --- |
| 登录态（导入/扫码/刷新） | `CredentialStore` + CDP 导入 + 扫码登录 + `_m_h5_tk` 自动刷新 | ✅ 已覆盖 |
| 单件发布（CDP 步骤机） | 真机跑通 3 次（itemId 1093817229436 / 1091938715735 / 1091940243200，均已下架） | ✅ 已覆盖（限类目矩阵） |
| 批量入队（幂等 dedupeKey） | `xy_publish_batch` + daemon 串行 worker；批量真机未验 | 🟡 功能在、真机缺 |
| 文案生成/改写 | `xy_copy_plan`（5 种风格 + 合规词表）、`skills/xianyu-listing-copy` | ✅ 覆盖（我们走 agent，不内置模板库） |
| **采集参考（列表+详情富字段）** | `parseItemReference` + daemon `POST /reference` + `xy_reference_collect` + 面板「采集」分区（§7） | ✅ R1 已落地（只读统计；真机单件 200），R2 搬家待拍板 |
| 图片下载 / 处理 / 去重 | 无 | ❌ 未做（合规上只允许「自摄素材」的处理，见 §5） |
| 改价公式 | 无（草稿里直接写 priceCents） | ❌ 未做（低优先，属配置项） |
| 多账号并行 | 只有数据结构；发布是单 Chrome 单端口 + `assertSameAccount` | ❌ 未做（它靠多 Environment） |
| 批量真机调度 + pacing | `core/src/limiter.ts` 账号级 pacing（默认 180s，夹 30s..3600s）+ `batch.js` 逐条预约 `availableAt` | ✅ 代码已落地（单测；180s 未真机校准） |
| 失败收尾（重排/重试） | `requeue` + `POST /tasks/:id/retry` + `xy_task_retry`（写类、挂审批） | ✅ 代码已落地（单测；未真机重放） |
| 代理 | 无 | ❌ 不做（见 §5） |

## 5. 合规红线（写进文档，避免后面「顺手就做了」）

AGENTS §1.6 是硬红线：**不搬运他人商品、不刷单、不代下单、不倒卖数据**。
该工具的核心链路正是「抓别人商品 → 下载图片 → 改标题改价 → 原样重发」，即平台明令的**重复铺货**。

因此本项目的裁决：

**可以做的（白名单）**

1. **自有商品的参考分析**：拉自己账号（或已获授权的账号）的列表/详情，统计标题长度、价格带、类目分布、属性、卖点词频。
2. **他人商品的「只读分析」**：只用统计量（价格带、类目、标题字数、关键词），**不落原图、不落原文、不生成草稿**。
3. **自有素材的图片处理**：自己拍摄/自己生成（AI 生图）的图做压缩、尺寸、去重。
4. **原创商品批量发布**：我们已有的 `xy_copy_plan` + `xy_publish_batch` 链路。

**不做的（黑名单）**

1. 下载他人商品图片入库、或把他人图片直接用于发布。
2. 照抄他人标题/描述（含「同义词替换后照抄」）。
3. 跨账号复制他人的在售商品（哪怕「改个价」）。
4. 代理池对抗平台风控、指纹伪装绕检测、卡密破解。

**实现层的硬约束**（review 时按这几条查）

- 解析器**只返回图片数量**，不返回图片 URL（`parseItemReference` 已按此实现，测试断言 `JSON.stringify(ref)` 里不含镜像域名）。
- 摘要素材落库时只存统计与词频，不存 `desc` 全文（如未来要存，必须单独 ADR）。
- 面板上的「采集」分区必须显示红线条目，且按钮只能产出「分析报告」，不能产出草稿。

## 6. 不值得借鉴的部分

- 自建 341 MB Chromium 内核：我们直接 attach 用户自己的 Edge/Chrome（CDP），升级与指纹都由用户浏览器负责。
- VMProtect 加壳：无源码保护需求，反而让排障变成逆向。
- x86/x64 自造 RPC 通道：我们走 CDP/HTTP，调试面友好。
- Ex 版指纹/认证代理：合规与稳定性双风险。

值得借鉴的 5 点（已吸收）：一账号一 Environment 用完即焚、资源拦截取数优于 DOM 抓数、页内 fetch 复用登录态、
任务视图总线（AddTab/SetTitle/SetLoading）、CookieVisitor 登录态快照。

## 7. 本轮落地：参考分析解析层

新文件 `packages/channel-mtop/src/reference.ts`（纯函数、零 IO、无第三方依赖）：

- `parseItemReference(raw): ReferenceItem` —— 从 `mtop.taobao.idle.pc.detail` 响应取
  `itemId / title / desc / priceCents / originalPriceCents / categoryId / properties[{name,value}] /
  imageCount / browseCount / wantCount / collectCount / soldCount / publishedAt / seller{sellerId,nick,city,itemCount,registeredYear,soldCount,summary} /
  siblingItems[{itemId,title,priceCents}]`；容错 `{data:{itemDO}}`、`{data:{itemCardDO}}`、扁平三种形态；
  缺 `itemId`/`title`/`sellerDO.sellerId` 直接 `VALIDATION`，绝不用猜的 id。
- `extractTitleKeywords(titles, limit)` —— 中文片段（≤6 字整段 + 2-gram）与英文/数字串的词频，过滤纯虚词，零依赖不进分词库。
- `summarizeReferences(items, {topKeywords, topCategories})` —— 价格带（min/median/max/avg）、标题长度、主图数均值、描述覆盖率、类目分布、卖点词。
- 测试：`packages/channel-mtop/test/reference.test.ts` 7 例（真实抓包脱敏 fixture），channel-mtop 包 95/95 通过。

真机校验（2026-10-21，测试用大号自身商品 `1091933071728`，脱敏后不进仓库）：

```
itemId 1091933071728  price 10000  category 50023914  images 3  descLen 88
properties [{"name":"服务区域","value":"全国可服务"},{"name":"计价方式","value":"元/时"}]
seller {"sellerId":"…","city":"西安","itemCount":7,"registeredYear":2012,"soldCount":2}
siblingItems 2 条（含价格 3000 / 15000）
```

daemon 真机校验（2026-10-21，真实凭据目录起 daemon，账号 `2206569289277`）：`POST /reference {accountId:'2206569289277', itemIds:['1091933071728']}` → **200 / 241ms**；item「AI工作流咨询」priceCents 10000、categoryId `50023914`、imageCount 3、seller 西安 / 在售 7 / 注册年 2012、siblings 2 条（3000 / 15000）。keywords 为空是因为只采到 1 件、卖点词要求出现次数 ≥2。**只验证了单件 itemIds 路径**，sellerId / 多件 / 面板点击调工具都没跑过。

抓包踩到的坑（已写进 `packages/channel-mtop/src/user.ts` 的文档注释）：
`mtop.idle.web.xyh.item.list` 的 `userId` **必须传数字 `kcUserId`**（如 `2206569289277`），
传 `baseInfo.encryptedUserId`（`"QWma6tgLyd31UYx/44RiHg=="` 这种）会被平台拒：
`FAIL_BIZ_BAD_REQUEST::解析参数失败`。抓取脚本在 `.scratch/collect/`（不进仓库，含登录态）。

## 8. 下一步（按优先级）

| 阶段 | 内容 | 前置 |
| --- | --- | --- |
| R1（半自动） | ✅ **已落地（只读统计 + 真机单件）**：`POST /reference`（itemIds / sellerId → 解析 + 汇总）+ 只读工具 `xy_reference_collect` + 面板「采集」分区（只出分析报告） | 解析层 95 测试；真机单件 200 |
| R2（需拍板） | **未实现、待拍板**：自有商品跨账号「搬家」（基于我们自己的 items 表与草稿，不碰他人素材） | 用户明确授权范围 |
| R3 | 自摄素材图片处理（压缩/尺寸校验/重复检测），复用现有 `images` 绝对路径契约 | R1 之后 |
| R4 | 多账号并行发布（多 Chrome 端口 / 多 user_data_dir），需要先解掉单实例 `assertSameAccount` | R1–R3 稳定后 |

**未验证项**：搬运助手在真实账号上的行为（不运行它，故永远不验证）；它是否内置定时监控/自动上新（无静态证据）；
它的授权机制（卡密/服务器）如何工作（无静态证据）。
