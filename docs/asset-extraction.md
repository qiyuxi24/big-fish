# 资产交接单：`research/repos/` 的复用结论与删除依据

> 生成：2026-10-20（P1.1 进行中）｜体积为 `du -sm research/repos/*` 实测｜星数/许可为 2026-10 实测（见 `docs/xianyu-4q-research.md:32-50`）。
> **决策前提**：用户已定「先把前面几个仓库的价值榨干，然后删除 research/repos（≈886MB）」。
> **本文件作用**：删除前的唯一交接单——每个来源「给了什么 → 落到本仓哪个文件 → 为什么没吸收」；以及删掉后会失效的路径清单。
> 边界：本文件只留档，不执行删除、不改其它文件。

## 0. 结论速览

- 886MB 里 **≈78MB 是 13 个开源仓库**（其中 8 个是 1MB 级「挑出来的单文件」，不是完整 clone），**≈808MB 是 3 套闭源商业包**（RAR + 解压目录）。真正有价值的是后者产出的**事实**，事实已全部落进 `docs/`（12 篇 + 2 篇 ADR）与 `research/notes/`（5 篇）。
- **代码可复用的只有 2 个仓库**：`xian-guanjia`（MIT，已整套移植到 `packages/channel-guanjia`）、`goofish-cli`（Apache-2.0，已移植签名/信封/关键词表/限流熔断语义）。`pilot-pro`（Apache-2.0）只取协议事实，未移植代码。
- 其余 10 个仓库（GPL-3.0 ×1、AGPL-3.0 ×2、非商用许可 ×1、无 LICENSE ×6）**只以「事实/思路」吸收，没有一行代码进仓**。
- 3 个商业包是**只读逆向**：未运行任何 exe/dll、未修改包内文件、未复制其代码或依赖；能力模型已改写为我们自己的设计（`docs/delivery-rules.md`、`docs/xianyu-commercial-tools-analysis.md`）。
- 删除后**唯一不可再生的物证是偏移级逆向记录**（`research/notes/D-delivery.md`、`E-repost.md`）；要重跑必须重新拿到 38MB / 144MB / 84MB 原包。所有结论的「判据」（哪条串、哪个偏移、哪个接口）都留在这两份笔记里，够复核。

## 1. 总表：来源 → 资产 → 已吸收去向 → 未吸收原因

### 1.1 开源仓库（13 个，≈78MB）

| # | 仓库（★ / 许可） | 可复用资产 | 已吸收去向（本仓路径） | 未吸收 / 原因 |
|---|---|---|---|---|
| 1 | cv-cat/XianYuApis 1.6k★ / 无 LICENSE 文件（README 自称 MIT） | mtop 签名公式、登录五步、接口清单、tfstk 生成机制 | `docs/xianyu-4q-research.md:52-88`（抓取/登录/发布）、`:106-153`（sign/tfstk/触发条件）；同算法实现落 `packages/channel-mtop/src/sign.ts` + `test/fixtures/mtop-responses.ts` | 无许可文件 ⇒ 不抄代码，只按事实重写；Python+execjs 方案不用（Node crypto 直算） |
| 2 | shaxiu/XianyuAutoAgent 9.4k★ / GPL-3.0 | IM WebSocket 协议、LLM 客服分层、消息字段 | `research/notes/B-im.md`（§2:20 传输、§4:40 接口）；`docs/xianyu-4q-research.md:90-100` | GPL 传染；IM 长连接 P1.2 才做（§5-1） |
| 3 | zhinianboke/xianyu-auto-reply 7.8k★ / AGPL-3.0 | 多账号凭据模型、WS 自动回复、擦亮任务、表设计 | `research/notes/B-im.md` §5:56 / §7:79 / §9:93 | AGPL 更严；凭据与队列我们已自建（`core/src/credentials.ts`、`queue.ts`） |
| 4 | 23Star/xianyu-super-butler 1.3k★ / AGPL-3.0 | 滑块处理、发货/擦亮盘点、45 张表结构 | `research/notes/B-im.md` §5:56（「风控/自动过滑块」最重要结论） | 同上，只借结论不借码 |
| 5 | xiaolu-ai26/XY-Agent 27★ / 无 LICENSE | 网页发布六步 + 成功判定、违禁词分类、类目上限 | 流程 → `packages/channel-cdp/src/steps.ts`（自写状态机）；词表分类 → `packages/core/src/policy.ts:10-12`；类目上限记为能力边界 | DrissionPage 代码不抄；无许可 ⇒ 只借鉴流程 |
| 6 | superboyyy/xianyu_spider 885★ / 无 LICENSE | 纯 HTTP 直连 mtop 范式、Set-Cookie 域重写坑、限流反面教材 | `packages/channel-mtop/src/response.ts:17`（`parseSetCookie`）；`research/notes/C-scraping.md` §1:15-48 | 无许可 ⇒ 只取坑位；HTTP 直连不作发布主通道 |
| 7 | thefreelight/xian-guanjia 30★ / **MIT** | 闲管家 20+ 接口、签名 `md5(appId,appSecret,md5(body),ts,mchId,mchSecret)`+4 头、错误码表 | **整套移植**：`packages/channel-guanjia/src/{sign,methods,errors,types,client,index}.ts` + 4 个测试；事实版 `research/notes/A-cores.md` §2:52 | 未吸收：Python 实现与其 `json=` 插空格 bug（我们签名与发送共用紧凑串，见 `component-decomposition.md:271`） |
| 8 | NanmiCoder/MediaCrawler 67k★ / NON-COMMERCIAL 学习许可 | 「浏览器内签名」三范式、混合传输架构 | `research/notes/C-scraping.md` §3:63；`docs/xianyu-4q-research.md:52`（架构范式） | 许可禁商用；其登录/签名实现不适用于闲鱼 |
| 9 | fancyboi999/goofish-cli 331★ / **Apache-2.0** | mtop 调用模板、`ret` 关键词表、限流/熔断、风控红线文档、发布流程 | `packages/channel-mtop/src/{sign.ts:4,request.ts:4,constants.ts:4}`；`packages/core/src/{risk.ts:4,limiter.ts:2,circuit.ts,policy.ts:8}` | 未吸收：`core/browser_cookie.py`（DPAPI 需原生模块 ⇒ 改 CDP 导 cookie，`packages/channel-cdp/src/cookies.ts`）；`docs/risk-control.md` 仍未落地（§5-4） |
| 10 | dameng2026/xianyu-pilot-pro 100★ / Apache-2.0 | 多规格发布 `mtop.idle.pc.backend.idleitem.publish` 的**双层 JSON**、x5sec 缓存、captcha backoff | `docs/xianyu-4q-research.md:77`（多规格分水岭）、`:140-153`（滑块/x5sec 机制） | 上游 130MB 商业版含反检测浏览器 ⇒ 只取协议事实；多规格发布排 P1.2（§5-3） |
| 11 | avehub/ai-goofish — / 无 LICENSE | Playwright 监控 + AI 筛选、`expect_response` 直接吃 XHR JSON | `research/notes/C-scraping.md` §2:50；`packages/channel-cdp` 的 `captureJson`（思路同源、实现自写） | 无许可；监控属读侧，P2 再做 |
| 12 | webxiaoyou/xianyucaiji — / 无 LICENSE | MV3 扩展能在 goofish 页面读写（可行性实证） | `docs/component-decomposition.md` §2.4:65（决策：不做扩展） | 需用户长期装可疑扩展、体验更差 ⇒ 否决 |
| 13 | huwangkeji/Xianyu-Smart-Customer- 2★ / MIT | 扩展内跨域 iframe 注入、限流器 | 同上（仅作可行性实证） | MIT 但未采用：CDP 接管真 Chrome 已覆盖 |

> 说明：1/6/11/12/13 等目录里只有分析者挑出的几个文件（如 `goofish-cli/` 的 `src__goofish_cli__core__mtop.py`），不是完整仓库；删前无需再 clone。

### 1.2 闭源商业包（3 套，≈808MB）

| # | 包（RAR + 解压目录 + 大小） | 可复用资产 | 已吸收去向 | 未吸收 / 原因 |
|---|---|---|---|---|
| A | `(v4.8.2)闲鱼自动发货助手`：RAR 38MB + 解压 100MB | 规则表数据模型（xlsx 两列「标题→整段文本」；五连字符 txt「规格ID/商品ID/卡密标题/内容」）、发货链路分层、EdgeView document-start 注入能力、VMProtect 指纹 | `docs/xianyu-commercial-tools-analysis.md` §2:34-84；`research/notes/D-delivery.md`（275 行，带偏移）；`docs/delivery-rules.md`（P1.1 新增，规则引擎 + 幂等键设计） | 不吸收：易语言实现、内嵌 WebView2（改 CDP 接管真 Chrome）、xlsx/txt 读写需在零依赖约束下自实现 |
| B | `C闲鱼一键搬运助手v2.1.9`：RAR 144MB + 解压 371MB（其中 ACFlib 341MB = Chromium 131.0.6778.76） | ACF 框架（x86 宿主 + x64 内核，进程外 IPC）、多 Environment/Profile 隔离、DOM+资源拦截+Function 注册能力、tabControl 协议、免费版无指纹魔改 | `docs/xianyu-commercial-tools-analysis.md` §3:88-128；`research/notes/E-repost.md`（407 行）；`docs/component-decomposition.md` §2.5:70-74 | 不吸收：自建内核分发（341MB、落后 18 个月）、VMProtect 全量加密、x86/x64 自造 RPC、ACF Ex 付费指纹（供应链风险） |
| C | 雾里 3.20 套件：RAR 84MB + 解压目录 82MB（+ `unpacked/agiso-plugin` 1MB） | 四件套事实、阿奇索「借第三方 SaaS 网页会话」通道实证、AI 改写 prompt（人物设定.txt）、卡密+心跳+RC4+Gitee 热更的授权壳形态 | `docs/xianyu-wuli-kit-analysis.md`（188 行）§3:57-114、§4:116-126；通道矩阵第 4 条 D 记录在 §6:144 | 不吸收：盗用阿奇索会话（ToS + 可随时失效）、授权壳、PyInstaller 冻结 pandas 栈；prompt 未入库（§5-5） |


### 1.3 口径说明（读表须知）

- 「已吸收去向」里的 `packages/...:N` 是**已落地代码**的行号；`docs/...md:N-M` 是文档锚点（行号按 2026-10-20 版本，文档改动会漂，按小节标题找）。
- 「未吸收」分三类：**许可不允许**（GPL/AGPL/无 LICENSE）／**我们不选这条路**（自建内核、借 SaaS 会话、内嵌 WebView2）／**排期未到**（IM、多规格、图片上传）。只有第三类值得未来补（见 §5）。
- 商业包（§1.2 的 A/B/C）没有「可复制资产」——它们给的是**行为证据**，实现一律自写；这是法务上最安全的一类吸收。
- `docs/` 是**结论层**，`research/notes/` 是**证据层**（带偏移与命令），两者不要混用；删除后两层都还在。

## 2. 许可证判定（删前留档的法律结论）

| 档位 | 来源 | 结论与做法 |
|---|---|---|
| ✅ 可复制代码 | `xian-guanjia`（MIT）、`goofish-cli`（Apache-2.0） | 已移植进 `packages/`；每个文件头写「仓库 + 文件 + 许可」，改动处标 `// ported from …`（见 `component-decomposition.md` §1:19-31） |
| ⚠️ 只取事实/协议 | `pilot-pro`（Apache-2.0，但含商业反检测组件）、`XianYuApis`（README 自称 MIT 但**无 LICENSE 文件** ⇒ 保留所有权利） | 不复制代码，只把「接口名/字段/算法语义」写进 docs；实现全部重写 |
| ⚠️ 只借鉴思路 | `XianyuAutoAgent`(GPL-3.0)、`xianyu-auto-reply`(AGPL-3.0)、`xianyu-super-butler`(AGPL-3.0)、`MediaCrawler`(非商用学习许可) | 本仓闭源分发 ⇒ 一行不抄；AGPL 即使自用不分发，也避免混入其代码以绝后患 |
| ❌ 只借流程 | `XY-Agent`、`xianyu_spider`、`ai-goofish`、`xianyucaiji`（均无 LICENSE）、3 个商业闭源包 | 无许可 = 保留所有权利；商业包还叠加「疑似破解分发」的分发风险，只做行为参考 |
| ⚠️ 待补手续 | xian-guanjia 的 MIT 原文、goofish-cli 的署名 | ① `research/repos/xian-guanjia/LICENSE` 随目录一起删除，而 MIT 要求分发时保留版权声明 ⇒ **待补**：把 LICENSE 文本 + `Copyright (c) 2025 thefreelight` 落进 `packages/channel-guanjia/`（当前只有文件头提及）；② goofish-cli 扁平副本内**无 NOTICE 文件** ⇒ Apache-2.0 §4(d) 无额外 NOTICE 义务，但建议在 `packages/channel-mtop/README.md` 保留来源段（现在只在 src 头注释）。本轮不改，交给后续「合规补手续」任务 |

**删除后的许可风险**：本仓不再持有任何第三方源码副本，风险归零；残留义务仅是「已移植代码的署名/许可文本」（上表待补项）。

## 3. 删除清单与保留清单

### 3.1 可删（≈886MB）

| 路径 | 大小 | 内容 |
|---|---|---|
| `research/repos/unpacked/C闲鱼一键搬运助手v2.1.9` | 371MB | vmp.exe 24MB + ACFlib 341MB（Chromium 131）+ 6 个 dll + tabControl |
| `research/repos/C闲鱼一键搬运助手v2.1.9.rar` | 144MB | 上者原包 |
| `research/repos/unpacked/(v4.8.2)闲鱼自动发货助手` | 100MB | 易语言 exe + EdgeView/HPSocket 等 |
| `research/repos/闲鱼一键搬运助手.rar` | 84MB | 雾里 3.20 套件原包 |
| `research/repos/闲鱼一键搬运助手` | 82MB | 上者解压（含截断的 .tmp 安装包） |
| `research/repos/(v4.8.2)闲鱼自动发货助手.rar` | 38MB | 发货助手原包 |
| `research/repos/unpacked/agiso-plugin` | 1MB | 阿奇索头信息获取 MV3 扩展 |
| 13 个 git 仓库 | ≈78MB | MediaCrawler 26 + xianyu-auto-reply 20 + XianyuAutoAgent 10 + xianyu-super-butler 9 + XianYuApis 5 + 8 个 1MB 级仓库 |
| **合计** | **≈886MB** | `du -sm research/repos` |

- 该目录**从未入库**：`git ls-files research/repos` = 0 行，且被 `.gitignore:13` 的 `research/repos/` 忽略 ⇒ 删除不需要任何 git 操作（不必 commit）。
- 分项按 `du -sm` 各自取整，逐项相加会比 886 多约 10MB，属舍入。

### 3.2 保留（删后仍在本仓，≈340KB）

| 路径 | 大小 | 说明 |
|---|---|---|
| `research/notes/`（5 篇） | 124KB | A-cores 82 行 / B-im 104 / C-scraping 95 / D-delivery 275 / E-repost 407，**带 `文件:行号` 与偏移的原始笔记**，是商业包逆向的唯一物证 |
| `docs/`（12 篇 + 2 篇 ADR） | 216KB | 4q 研究、商业工具分析、雾里套件分析、组件拆解、规则引擎、架构/设计/开发/排障 |
| `.scratch/wuli/`（74MB 前缀 + 836 个 zlib 流） | 临时 | 雾里截断包的抢救产物，gitignored、可丢弃；要复核不如重下 84MB 原包 |

### 3.3 删除后会失效的引用（25 处，本轮不修）

| 文件 | 行 | 引用内容 | 建议改成 |
|---|---|---|---|
| `docs/delivery-rules.md` | 3 | `research/repos/ 之后会删除` | 改写为「原包已删，证据见 D-delivery.md」 |
| `docs/xianyu-4q-research.md` | 4 | 「本机已解压的 11 个仓库 `research/repos/`」 | 改为「研究期样本已删（见 asset-extraction.md）」 |
| `docs/xianyu-4q-research.md` | 61 | `research/repos/XianYuApis/static/goofish_js_version_2.js:19-26` | 指向 `asset-extraction.md` §1 #1 或 notes/A-cores.md:21 |
| `docs/xianyu-4q-research.md` | 77 | `research/repos/pilot-pro/` | 指向本文件 §1 #10 |
| `docs/xianyu-commercial-tools-analysis.md` | 3 | 「解压后位于 `research/repos/unpacked/`」 | 加一句「包已删，证据归档于本文件与 research/notes/」 |
| `docs/xianyu-wuli-kit-analysis.md` | 3、39、188 | RAR 路径、`unpacked/agiso-plugin/`、原包路径 | 改为归档说明 |
| `packages/channel-guanjia/README.md` | 11、12 | 移植来源原文件路径 | 保留仓库名+文件路径（不带 `research/repos/` 前缀）即可满足署名 |
| `packages/channel-guanjia/src/{client,errors,index,methods,sign,types}.ts` | 各 1-2 处 | 同上的注释 | 同上（注释里保留仓库名与文件路径） |
| `packages/channel-guanjia/test/{sign,errors}.test.ts` | 12、14 | 测试向量出处 | 同上 |
| `research/notes/A-cores.md` | 3 | 「分析对象 `research/repos/`」 | 改为「研究期样本（已删）」 |
| `research/notes/B-im.md` | — | （无直接路径引用，仅仓库名） | 不用改 |
| `research/notes/C-scraping.md` | 3 | 「`research/repos/` 下已解压的…」 | 同上 |
| `research/notes/D-delivery.md` | 3、29、260 | 对象路径、`ls` 命令、复现脚本变量 | 3 加「已删」，29/260 标注「历史命令，包已删」 |
| `research/notes/E-repost.md` | 3 | 分析对象路径 | 加「已删，证据留在本文」 |
| `AGENTS.md` | 86 | 「禁止提交 … `research/repos/`」 | 保留为历史规则即可（目录已不存在） |

> 除上述 25 处外，`docs/component-decomposition.md`、`A-cores.md`、`B-im.md` 等大量「仓库名 + 事实」引用不依赖目录存在，删除后仍可读。

## 4. 删除后，结论去哪找（按问题索引）

| 想查什么 | 去哪看 |
|---|---|
| 三个通道怎么选、为什么读走 B / 发布走 C | `docs/xianyu-4q-research.md` §0:9、§5:206 |
| mtop 签名公式 / 固定参数 / 实测接口清单 | `docs/xianyu-4q-research.md` §2.1:106、§2.2:121；`packages/channel-mtop/src/sign.ts`、`constants.ts` |
| 登录态与 tfstk、扫码登录 | `docs/xianyu-4q-research.md` §2.3:140；`research/notes/A-cores.md` §1.2:28 |
| 风控触发条件、滑块 / x5sec | `docs/xianyu-4q-research.md` §2.2:121、§2.3:140；`research/notes/B-im.md` §5:56、`C-scraping.md` §1:35 |
| 发布（单规格 / 多规格）与类目上限 | `docs/xianyu-4q-research.md` §1.3:69、`:77`；`packages/channel-cdp/src/steps.ts` |
| IM 协议（客服/自动发货的触发源） | `docs/xianyu-4q-research.md` §1.4:90；`research/notes/B-im.md` §2:20、§4:40 |
| 13 个仓库逐仓事实与许可 | 本文件 §1-§2；`research/notes/{A-cores,B-im,C-scraping}.md`；`docs/component-decomposition.md` §1:19-31、§2:33-74 |
| P1.0 到底吸收了什么、契约长什么样 | `docs/component-decomposition.md` §4:91-272、§5:273；`docs/architecture.md` §2.1:38-46 |
| 自动发货规则引擎（A 包的全部可抄部分） | `docs/delivery-rules.md`（279 行）；`research/notes/D-delivery.md` §5:186-228；`docs/xianyu-commercial-tools-analysis.md` §2.3:64-84 |
| 商业包技术栈与指纹（VMProtect/易语言/ACF/Chromium131） | `docs/xianyu-commercial-tools-analysis.md` §2.1:36、§3.1:90、§4:131；`research/notes/D-delivery.md`（偏移级）、`E-repost.md` §2:47-120 |
| 多账号隔离 / 代理 / 指纹（ACF 那套） | `docs/xianyu-commercial-tools-analysis.md` §3.2:102；`research/notes/E-repost.md` §3:122-157 |
| 搬运 / 自动化路线对比（它们是浏览器自动化还是接口直连） | `docs/xianyu-commercial-tools-analysis.md` §3.3:109、§5:146；`research/notes/E-repost.md` §5:214、§7:284-320 |
| 雾里套件、阿奇索通道（第 4 条通道为何否决） | `docs/xianyu-wuli-kit-analysis.md` §2:37、§4:116、§6:144 |
| 架构 / 设计意图 / 性能预算 / 里程碑 | `docs/architecture.md`、`docs/xianyu-ops-agent-design.md`（§4:107 通道决策、§9:194 风险） |
| 已落地实现与每处移植的出处 | `packages/*/src/*` 文件头注释 + 各包 `README.md` |

## 5. P1.1 之后仍未吸收、值得未来做的 5 条

1. **IM 长连接**（`wss://wss-goofish.dingtalk.com/`，`research/notes/B-im.md` §2:20）——自动回复、自动发货、订单提醒的唯一低延迟触发源；现状：只做了队列占位（`core/src/store.ts` 的 `kind=deliver`），连接未写。前置：登录态与 cookie 续期链；风险：长连接鉴权字段会随版本变。
2. **图片上传通道** `POST https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat`（multipart，`docs/xianyu-4q-research.md` §1.3:69）——发布前置；现状：契约里留了 `imageInfoDOList` 但未实现（`component-decomposition.md`:277）。注意零依赖 ⇒ 手写 multipart，别引库。
3. **多规格发布** `mtop.idle.pc.backend.idleitem.publish` 的**双层 JSON**（`{inputJson:"…"}` 再序列化、签名打最外层，`docs/xianyu-4q-research.md:77`）——鱼小铺/多 SKU 的分水岭；只能按 pilot-pro 的事实重写（Apache-2.0 但未移植）。
4. **风控红线文档 `docs/risk-control.md`**（component §2.1:45 计划落地但一直没写）+ **滑块/x5sec 恢复 SOP**（goofish-cli `x5sec-recovery.md`、`B-im.md` §5:56、雾里手册「过滑块后必须重新取 Cookie」）——目前只有 `core/src/policy.ts` 的发布前本地校验，缺「卡住之后怎么恢复」的操作规程。
5. **AI 改写 prompt 资产化**（`人物设定.txt`：标题 ≤30 字、`【自动发】`前缀、4 段式描述、5 个话题标签、纯 JSON 输出，见 `docs/xianyu-wuli-kit-analysis.md` §1:9）——P2 文案层直接可用的工程化模板；现状只记录未入库，落在 P2 时再按类目做变体。

## 附录 A：本次核验命令与实测结果

| 命令 | 结果 |
|---|---|
| `du -sm research/repos` | 886 |
| `git ls-files research/repos \| wc -l` | 0（未入库；`.gitignore:13` 已忽略整个目录） |
| `node scripts/test-all.mjs` | **372 tests / 372 pass / 0 fail**（2026-10-20 交付时实测；P1.1 并行任务仍在加用例，条数会涨） |
| `node scripts/typecheck.mjs` | 本会话**无法验证**：`spawnSync node.exe EPERM`（沙箱禁止 node 子进程管道 stdio，是本机限制、非类型错误） |
| 直接 tsc（绕开脚本） `node <DSH>/node_modules/typescript/bin/tsc -p packages/<pkg>/tsconfig.json --noEmit --typeRoots <DSH>/node_modules/@types` | core / daemon / channel-mtop / channel-cdp / channel-guanjia **5 包 0 错误** |
| 删后自检 | `grep -rn 'research/repos' docs/ packages/ research/notes/` 预期 25 处（§3.3 清单），逐条改成 docs 锚点 |
| `wc -l research/notes/*.md docs/*.md docs/adr/*.md` | notes 5 篇 963 行；docs 13 篇（含 2 篇 ADR）2,250 行（2026-10-20 快照，含本文件） |
| `ls research/repos/unpacked/` | 3 个目录：C闲鱼一键搬运助手v2.1.9、(v4.8.2)闲鱼自动发货助手、agiso-plugin |

## 附录 B：删除动作建议（由用户执行，本任务不删）

```sh
# 1) 删仓库样本（886MB，不入库，无需 commit）
rm -rf "research/repos"

# 2) 可选：顺手清掉三条「历史遗留」
#    .gitignore:13 的 research/repos/ 条目（目录已不存在）
#    .scratch/wuli/（74MB 雾里截断包前缀 + 解出的 pyc 流；gitignored，可丢）
```

删除后 `docs/` 与 `research/notes/` 保持原样即可读；§3.3 的 25 处路径引用属「过期指针」，不影响结论，建议另开一个「docs 引用修正」小任务一次性改掉（届时把本文件 §4 当作索引）。
