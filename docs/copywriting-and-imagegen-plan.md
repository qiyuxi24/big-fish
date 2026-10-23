# 文案与 AI 生图方案（P1.3 提案）

> 状态：**选型方案**（2026-10-21）。只写可执行结论、契约与验收，不写愿景。**实现状态见 [STATUS.md](STATUS.md)**——文中「3 个 skill」「xy_imagegen 仅契约」等是当时的计划，勿当作现状。
> 硬边界：daemon 不调 LLM、不调生图 API（AGENTS.md §1.1）。所有需要模型判断的步骤都在 DSH agent（skill）或插件工具侧完成；daemon 只读已落盘的草稿文件与图片路径。

## 0. 结论

1. **文案**：2 个 skill 放 `.agents/skills/`（`xianyu-listing-copy` / `xianyu-listing-audit`），纯 JSON 进出。agent 产出发布草稿后调 `xy_publish_draft`（默认 dry-run），人工确认后才 `mode=enqueue` 入队。daemon 不感知文案从哪来。
2. **生图**：首选火山方舟 **Seedream 5.0 Lite**（约 $0.035/张，中文商品图、多图参考、PNG、2K/4K）；备选阿里云百炼 **通义万相 wan2.7-image**（0.2 元/张，国内合规、异步任务）；再备 **Gemini 3 Pro Image**（约 $0.134/张，图内文字最准，但需外网）；Stability 只用于**去背景/局部重绘**；OpenAI 不作首选（价格与中文商品图无优势）；无 key 或无网时**不生成**，退回实拍——不用占位图、不用网图冒充。
3. **合规**：主图必须实拍；AI 图只做场景/氛围/多角度示意，并在描述注明；不得使用他人商品图/买家秀；生成图不得复刻品牌 logo、IP 角色。发布前跑 `xianyu-listing-audit` + `checkListing`。

## 1. 现状与硬边界

| 事实 | 位置 | 对本方案的含义 |
| --- | --- | --- |
| daemon 不调 LLM | AGENTS.md §1.1 | 文案与生图只在 agent/插件侧；daemon 只做确定性动作 |
| 草稿契约 | `packages/plugin-ops/src/draft.js` `validatePublishDraft` | `title` / `desc` / `priceCents`(正整数分) / `images`(非空、本机绝对路径) / `quantity` / `shipping`(`free`\|`none`) / `pricingMode` / `address` |
| 发布前策略 | `packages/core/src/policy.ts:54-59` | 标题 >30 字=warn、描述 <30 字=warn、图片 1–9 张=error、首图非 1:1=warn、违禁词 38 条=error、禁售类目 20 条=error |
| CDP 上传 | `packages/channel-cdp/src/publish.ts:217`、`docs/architecture.md:192` | `accept="image/png, image/jpg, image/jpeg, image/heic, image/webp"`，`DOM.setFileInputFiles` 读本机文件 |
| 发布页无独立标签字段 | `docs/architecture.md` §13 表单清单 | 5 个话题标签以 `#标签` 形式并入描述，不单独提交 |
| 插件零依赖、写类审批 | `packages/plugin-ops/src/tools.js`（specs）、`src/tool-middleware.js` | 新增生图工具必须标 `access:'confirm'` 并写 `reason`；注册/门禁由中间件统一处理 |
| 本机无 API key、运行时零依赖 | AGENTS.md §2、§1.4 | key 只从环境变量/DSH settings 读；未配置时工具返回 `UNSUPPORTED`，不伪造成功 |

## 2. 文案 skill 集

### 2.1 交付物

```
.agents/skills/
  README.md                          # 装载说明（项目级 skill 根，DSH 自动发现）
  xianyu-listing-copy/
    SKILL.md                         # 改写链主流程（输入→4 段→5 标签→JSON）
    references/
      input-schema.json              # 输入 JSON Schema
      output-schema.json             # 输出 JSON Schema（草稿 + 质检元数据）
      templates.md                   # 标题公式、4 段模板、类目变体、标签词库、few-shot
      red-lines.md                   # 违禁词/禁售类目/侵权/AI 图标注红线
  xianyu-listing-audit/
    SKILL.md                         # 已有草稿的质检与逐条修复建议
    references/
      audit-codes.md                 # 问题码与 `core/policy.ts` 的映射
```

### 2.2 装载方式

DSH 的 skill 发现只认**根下一层**的 `<name>/SKILL.md` 或 `<name>.md`，不递归 `**/SKILL.md`；frontmatter 必须有 kebab-case `name` 与 `description`，缺失/非法只 warn 后忽略（`skill-filesystem` 的 `parseSkillFile`）。

**结论（2026-10-22 实测已闭）**：`skill-filesystem` 只扫**项目根**的 `.dsh/skills` 与 `.agents/skills` 两个根，所以本仓 skill 已从 `skills/` 迁移到 `.agents/skills/`（`git mv`），放在仓库里即被自动发现——**不需要** `customSkillDirs`，也不需要复制/软链到 `.dsh/`。迁移后当前会话的 skill 目录立刻出现 `xianyu-listing-audit` / `xianyu-listing-copy`，装载链路已验证。

### 2.3 改写链（6 步，输入 → 草稿）

0. **归一化**：价格转整数分（≤2 位小数，禁止浮点相乘）；成色映射到 `全新/几乎全新/轻微使用痕迹/明显使用痕迹/有瑕疵`；瑕疵写成「位置 + 现象 + 实拍可证」，没有就写「无」；图片路径只做存在性/格式校验，**不由文案步骤生成**。
1. **类目判定**：有 `categoryHint` 信 hint，并在输出里回填；没有则给 3 个候选与把握度，不猜死。发布页先由页面 AI 识别类目；草稿显式给 `category` 时由 `stepSelectCategory` 点选并校验（`docs/architecture.md` §13.5）。所以这里只做提示，实际选择以发布步骤机为准。
2. **标题（≤30 字）**：公式 `[品牌/系列] + [品类词] + [核心规格/型号] + [成色或差异点]`；前 15 字放最值钱的检索词；无 emoji（`policy.ts:168` 会 warn）；无极限词；不写价格、不写「包邮」（发布页单独填）。计数用 `Array.from(title).length`，与 `checkListing` 同口径。
3. **描述 4 段式**（段间用空行，每段 1–3 句）：
   - 第 1 段「是什么」：品牌 + 型号 + 规格 + 成色，第一句就给结论；
   - 第 2 段「为什么出/适合谁」：使用场景与出售原因，不编故事；
   - 第 3 段「细节与瑕疵」：功能点、配件清单、瑕疵逐条；AI 图若用于场景示意必须在此声明；
   - 第 4 段「交易说明」：发货/自提、是否包邮、议价规则、售后边界，再加一行 5 个 `#话题标签`。
4. **5 个话题标签**：`#` + 词，按「1 个类目大词 + 2 个精准型号/属性词 + 1 个场景词 + 1 个状态/人群词」组合；必须与标题/描述里的词不重复堆砌；总长计入描述，描述总字数按平台输入框上限截断（上限**待验证**）。
5. **自检与降级**：跑 `xianyu-listing-audit` 的规则；命中违禁词就换词（不是删句），标题超 30 字先删形容词再删规格；仍不合格输出 `warnings` 并把 `ok:false`，不要"带病"交给发布。
6. **映射草稿**：文案字段 + 调用方给的 `images`/`priceCents`/`shipping`/`address` 合成 `PublishDraft`；金额保持整数分；`shipping` 只允许 `free`/`none`。

### 2.4 输入契约（`input-schema.json` 摘要）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `productName` | string | 是 | 原始商品名，可含商家话术 |
| `categoryHint` | string | 否 | 用户给的类目；为空则输出候选 |
| `condition` | enum | 是 | `new`/`like-new`/`light-wear`/`visible-wear`/`flawed` |
| `specs` | object | 否 | 型号/尺寸/材质/容量等键值，值一律 string |
| `flaws` | string[] | 否 | 每条一个瑕疵；空数组表示无瑕疵 |
| `accessories` | string[] | 否 | 配件清单 |
| `priceCents` | integer | 是 | ≥100，整数分 |
| `marketPriceCents` | integer | 否 | 市场均价，用于偏离度提示 |
| `shipping` | `"free"\|"none"` | 是 | 与草稿契约一致 |
| `imagePaths` | string[] | 是 | 本机绝对路径，至少 1 张；只校验不生成 |
| `tone` | `"plain"\|"warm"\|"professional"\|"urgent"\|"story"` | 否 | 默认 `plain`（闲鱼口语化）。面板可选，由 `xy_copy_plan` 注入提示词（`styleId` 与它同集合） |
| `variantCount` | integer | 否 | 1–3，生成几套标题/描述备选 |
| `usedAiImages` | boolean | 否 | 若含 AI 生成图，强制在描述第 3 段声明 |

### 2.5 输出契约（`output-schema.json` 摘要）

```json
{
  "ok": true,
  "draft": {
    "title": "≤30 字标题",
    "desc": "四段正文 + 标签行（发布页只有这一个文本框）",
    "descParagraphs": ["段1", "段2", "段3", "段4"],
    "tags": ["#标签1", "#标签2", "#标签3", "#标签4", "#标签5"],
    "categoryCandidates": [{ "path": ["数码", "手机"], "confidence": 0.9 }],
    "priceCents": 129900,
    "shipping": "free",
    "images": ["D:/photos/abc-01.png"],
    "quantity": 1
  },
  "variants": [{ "title": "备选标题", "desc": "备选描述" }],
  "warnings": [{ "code": "TITLE_TOO_LONG", "field": "title", "message": "标题 33 字，超过 30" }]
}
```

规则：**只输出 JSON**，不加 markdown 围栏、不加解释段；缺字段报错不补默认值；`ok:false` 时 `draft` 仍完整（便于人工改），但不得直接入队。

### 2.6 与 DSH agent / 插件的调用方式

```
用户 → DSH agent
  ├─ tool: xy_copy_plan(styleId, facts)     选语言风格 + 注入提示词（只读、不调模型、不写文件）
  ├─ skill: xianyu-listing-copy        产出 draft JSON（纯 JSON）
  ├─ tool: xy_publish_draft(mode=dry-run)   校验草稿 + 打印 daemon 命令（不写队列）
  ├─ 人工确认（价格/图/描述/AI 图声明）
  └─ tool: xy_publish_draft(mode=enqueue)   入队 → daemon 串行执行 CDP 填表
```

- **面板入口**（`packages/plugin-ops/client.js`）：侧边栏「文案风格（skill 注入）」可选 5 档风格、填商品名/价格/成色，点「生成文案请求」得到一段 `xy_copy_plan` 参数 JSON。面板不联网、不调模型，只组请求——执行者是谁（agent / 将来的 provider 适配器）与面板无关，这就是与调用方式的解耦点。

- **agent 侧**只做语言与结构；不直接写闲鱼。
- **插件侧**只做校验、展示、入队；**不调 LLM**（否则等于把 LLM 依赖塞进运行时）。后续若要"一键生成"，也是在 agent 侧串 skill，不在插件里发模型请求。
- **daemon 侧**只读 `payload.draftPath` 指向的 JSON 与图片路径，做 `checkListing` 与 CDP 步骤机；无文案逻辑。

### 2.7 类目变体（`templates.md` 全表，这里给差异点）

| 类目 | 标题重点 | 第 2 段（为什么出） | 第 3 段（细节） | 标签池示例 |
| --- | --- | --- | --- | --- |
| 数码 3C | 型号 + 容量/版本 + 电池健康 | 换机/闲置/升级 | 电池循环、维修史、配件、划痕 | #数码 #iPhone #二手手机 #学生党 #闲置 |
| 服饰鞋包 | 品牌 + 尺码 + 版型/颜色 | 尺码不合/风格不合 | 实测肩宽衣长、起球、鞋底磨损 | #穿搭 #闲置衣服 #通勤 #小个子 #清衣柜 |
| 图书教材 | 书名 + 版次 + 是否划线 | 考完/毕业/重复购买 | 划线页数、笔记、缺页、随书光盘 | #二手书 #考研 #教材 #读书 #低价出 |
| 虚拟资源 | 资源名 + 交付形式 + 适用范围 | 自用多余/整理资料 | 内容清单、更新方式、**不承诺疗效/收益** | #学习资料 #素材 #虚拟资源 #效率工具 #自学 |
| 家居日用 | 品类 + 尺寸/材质 + 风格 | 搬家/换新/尺寸不合 | 承重、色差、拆装、使用痕迹 | #家居 #收纳 #搬家出清 #出租屋 #好物 |
| 母婴玩具 | 品类 + 适用年龄 + 安全认证 | 孩子长大/重复 | 消毒情况、缺件、电池仓 | #母婴 #玩具 #绘本 #育儿 #闲置转让 |

虚拟资源类额外红线：不得含盗版课程/破解软件/账号共享；标题不写「永久」「包更新」等无法履约承诺。

### 2.8 与发布契约的对齐

- 字符计数统一 `Array.from`（中文/emoji 按码点），与 `policy.ts` 一致；标题超限是 **warn** 不是阻断，skill 仍应压到 30 内。
- `tags` 不落独立字段：`desc` 末尾追加 `#词1 #词2 …`（5 个），`descParagraphs[3]` 保留不含标签的正文，避免二次改写重复拼接。
- `images` 由调用方给本机绝对路径；skill 只校验 `accept` 内扩展名（png/jpg/jpeg/heic/webp）与数量 1–9，不重命名、不转码。
- 价格偏离市场价 >70% 触发 warn（`policy.ts:195`）；skill 在 `warnings` 里提示人工确认，不自动改价。

### 2.9 素材复用与 GPL 边界

- `research/repos/unpacked` 里早期记录的「人物设定.txt」已不在仓（`docs/asset-extraction.md:47`、`:144` 记录 prompt 未入库），本方案**不声称读过原文**。
- 该 listing 改写 prompt 的可复用规格来自仓库自己的分析：标题 ≤30 字、4 段式描述、5 个话题标签、纯 JSON 输出（`docs/xianyu-wuli-kit-analysis.md:147`；`docs/end-to-end-chain-and-borrowing.md:69`）。
- 原 prompt 来自 GPL/闭源套件，按 AGENTS §1.5 **只借鉴结构与工程化参数，不复制原文**；`templates.md` 全部为本仓重写的中文模板与自造 few-shot。
- 不放"人物设定"式角色扮演提示：闲鱼文案要的是检索词与交易信息，角色扮演会引入不可控话术和合规风险。

## 3. AI 生图

### 3.1 用在哪 / 不用在哪

- **可用**：白底/纯色背景的补充图、场景氛围图（桌面、书架、穿搭背景）、细节放大示意、同款多色展示；以及「已拍实拍图 → 去背景/换背景」。
- **禁用**：替代首图、修改实物外观/Logo/材质/配件、生成不存在的功能或赠品、用 AI 图掩盖瑕疵、把网图/买家秀喂给图生图做"改款"。

### 3.2 候选服务对比（2026-10 查证）

| 服务 | 代表模型 | 端点 / 鉴权 | 价位量级 | 中文商品图 / 去背景 / 尺寸 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 火山方舟 Seedream（豆包；即梦底层模型） | `doubao-seedream-5-0-260128`(Lite)、`doubao-seedream-5-0-pro-260628`、4.5/4.0 | `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`，`Authorization: Bearer <ARK_API_KEY>` | Lite 约 $0.035/张；Pro 约 $0.045/张（≤1.5K，>1.5K 翻倍）；**第三方口径，待验证** | 中文 prompt 强；多图参考 2–14 张；`output_format` png/jpeg；1K–4K 或显式 WxH；无独立去背景参数，可 prompt 白底 | **首选** |
| 阿里云百炼 通义万相 | `wan2.7-image`、`wan2.7-image-pro`、`wanx2.1-imageedit` | 同步 `POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`；异步 `…/image-generation/generation` + `X-DashScope-Async: enable`；`Bearer $DASHSCOPE_API_KEY` | `wan2.7-image` 0.2 元/张；`wanx2.1-imageedit` 0.14 元/张（官方价） | 中文商品图与图像编辑；输出 PNG；输入 JPEG/PNG/BMP/WEBP（PNG 不支持透明通道），240–8000px、≤20MB、0–9 张；1K/2K/4K（编辑/组图 ≤2K） | **备选（国内合规最稳）** |
| Gemini | `gemini-3-pro-image`（Nano Banana Pro） | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`，`x-goog-api-key` | 约 $0.134/张（1K/2K），4K 约 $0.24/张；**第三方口径，待验证** | 图内文字/排版最准，4K；中文商品图可用但需外网 | 再备（境外网络） |
| OpenAI | `gpt-image-2`、`gpt-image-1.5` | `POST /v1/images/generations`、`/v1/images/edits`，Bearer | 按 token：gpt-image-2 输出 $30/1M、图像输入 $8/1M、文本 $5/1M；单图约 $0.02–0.2（**待验证**） | 1024×1024 / 1024×1536 / 1536×1024（2 代可 4K）；中文 prompt 可用但无商品图优势 | 不作首选 |
| Stability | Stable Image Ultra / Core / SD3.5 | `https://api.stability.ai`（v2beta stable-image），Bearer | 1 credit=$0.01：Ultra 8、Core 3、Remove Background 5、Inpaint 5 | 去背景/重绘能力明确；中文理解一般，适合"已有实拍图后处理" | 只做后处理 |
| 本地 ComfyUI / SD | 自选 checkpoint | `POST http://127.0.0.1:8188/prompt` + `/ws`，无鉴权 | 0 元/张，但要 GPU、显存、模型盘 | 质量取决于模型；中文 prompt 需 pony/中文 CLIP；可控但运维重 | 离线兜底（高级用户） |

说明：即梦（Dreamina）是字节消费端产品，公开 API 实际走方舟 Seedream/Seedance；**没有独立可核实的价目表**（待验证）。因此上表用 Seedream 代表"豆包/即梦"路线。

### 3.3 推荐顺序

1. **首选 Seedream 5.0 Lite**：单价最低、中文 prompt 与商品摄影风格成熟、支持多参考保持实物一致、直出 PNG/2K，足够闲鱼首图与详情图；失败重试一次后降级。
2. **备选 通义万相 wan2.7-image**：国内网络与发票/合规链路最省事，支持异步任务（长任务不占请求），有官方中文图像编辑。
3. **再备 Gemini 3 Pro Image**：需要图内中文文字（如"赠品清单"小卡）时用，成本约 1 元/张。
4. **后处理 Stability**：实拍图去背景/换纯色底，5 credits≈$0.05/张；不用于从零生成。
5. **离线兜底**：不生成。提示用户补拍 1 张 1:1 白底实拍，或只用已有实拍图；**绝不下载网图、绝不用占位色块当商品图**。
6. ComfyUI 仅作为有 GPU 用户的可选本地通道，仓库不打包、不默认启用。

成本控制：一次上架默认只生成 **1–2 张**补充图；按 `maxImagesPerDay`（默认 20 张）硬上限；单次调用超时 120s，失败**不重试超过 1 次**（付费接口重试=双重计费）。

### 3.4 key 存放与脱敏

- **不进仓库**：`.env`、`.env.local`、任何 `*.key` 均不提交；`.gitignore` 已覆盖 `.scratch/`，密钥文件放用户目录。
- **读取顺序**：进程环境变量 `BF_IMAGEGEN_PROVIDER` / `BF_IMAGEGEN_KEY` → DSH settings 卡片（插件 config，DSH 自己加密/隔离）→ 都没有则工具返回 `UNSUPPORTED` 并给一行中文配置指引。
- **日志**：只打印 `provider`/`model`/`durationMs`/`costCents`/`requestId`；key 统一 `sk-***`（长度也不打）；错误响应体截断 300 字并替换 `Bearer\s+\S+`、`x-goog-api-key[:=]\s*\S+`；禁止把完整请求头写进 `console.log`。
- **轮换**：key 泄露时先吊销再换；插件不落盘 key（settings 由宿主管理），daemon 完全不接触生图 key。

### 3.5 插件工具 `xy_imagegen`（P1.3 实现，当前仅契约）

输入：`{ provider?: "seedream"|"wanx"|"gemini"|"stability", prompt: string, referencePaths?: string[], size?: "1K"|"2K"|"1024x1024", count?: 1|2, outDir?: string }`
输出：`{ files: string[], provider, model, costCents, requestId?, warnings: string[] }`

- 放在 `packages/plugin-ops`（纯 ESM JS、零依赖、Node 24 全局 fetch），**不进 core/daemon**；写盘走 `node:fs/promises`，输出目录默认 `.scratch/imagegen/<YYYYMMDD>/`。
- 工具 spec 标 `access: 'confirm'`、`reason` 写"会调用付费生图接口并写入本机图片文件，需要人工确认。"（门禁由 `tool-middleware.js` 按 specs 自动挂）。
- 失败映射：无 key → `UNSUPPORTED`；限流/超额 → `RATE_LIMITED`；网络 → `NETWORK`；返回结构不符 → `INTERNAL`（手写窄化，禁 `any`）。
- 生成结果必须**人工过目**后才允许写进草稿的 `images`；工具不自动调用 `xy_publish_draft`。

### 3.6 生成图 → 发布链路

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 格式 | **PNG 优先**；jpg/jpeg/heic/webp 也可上传；webp 只在体积受限时用 | 发布页 `accept`（真机校准） |
| 首图 | **1:1 正方形**，建议 1024×1024 或 2048×2048；首图非方形 `checkListing` 给 warn | `policy.ts:209` |
| 张数 | 1–9 张，超过 9 张是 **error** | `policy.ts:57` |
| 文件大小 | 单图上限**待验证**（平台文档未查到；真机用 5–10MB 图试传一次并记录） | 待验证 |
| 命名 | `<sku>-01.png`、`<sku>-scene-01.png`，全部本机绝对路径 | `draft.js` |
| 尺寸探测（零依赖） | PNG 读 IHDR（offset 16/20，大端）；JPEG 扫 SOF0/SOF2 段；WebP 读 VP8X/VP8L/VP8 头。写到 `core` 纯函数 + 单测，供 `firstImageSquare` 判定 | 本方案建议 |
| 上传顺序 | 首图 = 数组第 0 张；CDP `setFileInputFiles` 按数组顺序提交 | `publish.ts:217` |

衔接流程：`xy_imagegen` 出图 → 人审（像不像实物、有无变形/错字）→ 写草稿 `images`（实拍在前、AI 图在后）→ `xy_publish_draft(mode=dry-run)` 校验 → `enqueue`。

### 3.7 prompt 模板（中文，写在 `templates.md` 供 agent 引用）

- **白底主图**：`商品摄影，<品类>正面 45 度，纯白背景，柔和均匀布光，真实材质与颜色，无文字无水印，1:1`。
- **场景图**：`<品类>放在<场景>上，自然光，生活化但整洁，主体占画面 60%，不改变商品外观`。
- **细节图**：`微距特写<部位>，展示<材质/纹理>，浅景深，真实使用痕迹，不美化瑕疵`。
- 统一负向约束：`不要改变品牌标识，不要添加不存在的配件，不要生成文字/水印/价格标签，不要过度磨皮`。
- 图生图时必须附实拍参考图，prompt 里写「保持参考图中的颜色、比例、磨损位置」。

### 3.8 成本速算

- Seedream Lite：20 张/天 ≈ $0.7 ≈ 5 元；通义万相：20 张/天 = 4 元；Gemini Pro：20 张/天 ≈ $2.7；Stability 去背景：20 张 ≈ $1。
- 日预算上限默认 10 元（`maxDailyCostCents=1000`），超限直接拒绝并提示"今日生图预算已用完"，不静默降级到更便宜模型。

## 4. 合规与质量

### 4.1 侵权

- 不使用他人商品图、买家秀、模特图、官方详情页图；不把网图喂给图生图"改一改"（仍属演绎侵权）。
- 生成图不得复刻品牌 logo、IP 角色、明星肖像（谷子/手办类尤其）；必要时用纯色遮挡或在描述说明"示意图，无品牌标识"。
- 盗图投诉在闲鱼可被下架/扣分；保留自己拍摄的原图与 EXIF 作为申诉证据。

### 4.2 误导风险

- AI 图与实物不符属于虚假宣传：颜色、材质、尺寸、配件、瑕疵位置任一不符都可能被投诉/仅退款。
- 强制规则：**首图实拍**；AI 图仅作补充；`usedAiImages=true` 时描述第 3 段必须写「部分图片为 AI 场景示意，实物以实拍图为准」。
- 不得用 AI 图隐藏瑕疵、伪造"全新未拆"、把有划痕修成无划痕。

### 4.3 平台对 AI 图的态度（待验证）

- 未检索到闲鱼官方针对 AI 生成商品图的专门条款（**待验证**，官方协议归档页正文抓取为空：<https://termshub.cn/public/archive/3503>）。
- 可确定的是通用规则：盗图/虚假宣传/极限词会被处理（`policy.ts` 已把可本地判定的部分资产化）。
- 行业趋势：内容平台要求 AI 生成内容标识、电商平台治理 AI 假图（**待验证**，需以闲鱼规则中心最新公告为准）。工程上的保守做法：主动声明 + 实拍主图，成本最低。

### 4.4 发布前 10 条质检

1. 标题 ≤30 字、无 emoji、无极限词；2. 描述 ≥30 字且 4 段齐全；3. 5 个标签不重复、含类目词；4. 无 38 条违禁词；5. 类目不在 20 条禁售内；6. 价格 ≥1 元整数分、偏离市场价 ≤70%；7. 图片 1–9 张、首图 1:1、实拍在前；8. AI 图已声明且不改变实物；9. 发货/包邮/议价/售后写清；10. `xy_publish_draft` dry-run 通过 + 人工确认。

### 4.5 失败与回滚

- 生图失败：不阻塞发布，回退实拍图；把失败原因写进 `warnings`。
- 草稿质检 `ok:false`：拒绝入队，输出逐条修复建议。
- 已入队后发现图文不符：人工下架/编辑，不自动重发（避免重复发布违反幂等）。

## 5. 实施拆分与验收

| 任务 | 产出 | 验收 |
| --- | --- | --- |
| T1 文案 skill 骨架（本次） | `.agents/skills/` 2 个 bundle + 2 个 JSON Schema + 模板/红线 | frontmatter 合法、JSON Schema 可解析、3 个 few-shot 输出符合 schema |
| T2 `xy_imagegen` + 审批门禁 | `packages/plugin-ops/src/imagegen.js`、gate 白名单、单测（假 fetch） | 无 key 返回 `UNSUPPORTED`；不打印 key；写盘路径在 `.scratch/` |
| T3 图片尺寸探测 | `packages/core` 纯函数 + fixture 单测 | PNG/JPEG/WebP 各 1 个 fixture，宽高与方形判定正确 |
| T4 prompt 模板与评测 | `templates.md` 生图段 + 10 条样本（数码/服饰/家居） | 人评"像实物"≥7/10，文字与水印 0 次 |
| T5 真机验证 | 1 次发布（dry-run → 真提交需用户同意） | 首图方形、1–9 张、无平台图片报错 |

## 6. 待验证清单

| 项 | 现状 | 验证方式 |
| --- | --- | --- |
| Seedream 官方单价 | 第三方 $0.035/$0.045 | 火山方舟控制台账单/官方价目页 |
| 即梦独立 API | 未找到独立端点与价目 | 方舟文档/控制台确认是否即梦同源 |
| gpt-image-2 单图价格 | token 价已查，单图折算未核 | OpenAI 官方 image guide 价目表 |
| Gemini 3 Pro Image 单价 | 第三方 $0.134/$0.24 | Google AI 官方 pricing 页 |
| 闲鱼单图大小/描述字数上限 | 未查到 | 真机试传 + 规则中心 |
| 闲鱼 AI 图专门条款 | 未检索到 | 闲鱼规则中心/客服 |
| DSH skill 装载方式 | ✅ 项目根 `.agents/skills` 自动发现（2026-10-22 实测） | 不需要 `customSkillDirs`；迁移后 skill 目录已可见 |

## 7. 来源

- 通义万相图像生成与编辑 API：<https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference>；英文版：<https://www.alibabacloud.com/help/en/model-studio/wan-image-generation-and-editing-api-reference>；价格：<https://help.aliyun.com/zh/model-studio/wan2-7-image>、<https://help.aliyun.com/zh/model-studio/wanx2-1-imageedit>
- Seedream 能力/参数（第三方 quickref，非官方）：<https://raw.githubusercontent.com/a86582751/doubao-seedream-image-skill/main/references/api-quickref.md>
- Seedream 5.0 定价与型号（第三方，2026-09）：<https://www.modellix.ai/blog/seedream-5-api>
- Stability 价格（官方）：<https://docs.stability.ai/pricing>
- Gemini 3 Pro Image 价格（第三方聚合）：<https://inferencebench.io/models/google/gemini-3-pro-image/>
- OpenAI 图像模型 token 价（第三方，2026-08）：<https://www.modellix.ai/blog/openai-image-generation-api-pricing>
- 闲鱼实拍/9 图/方形经验（自媒体，非官方）：<https://www.sohu.com/a/995025242_122606198>
- 仓库内依据：`docs/architecture.md:162,192`、`docs/xianyu-wuli-kit-analysis.md:147`、`docs/end-to-end-chain-and-borrowing.md:69`、`docs/asset-extraction.md:47,144`、`packages/core/src/policy.ts:54-59`、`packages/plugin-ops/src/draft.js`、`packages/plugin-ops/src/tools.js`、`packages/channel-cdp/src/publish.ts:217`
