---
name: xianyu-listing-copy
description: 把闲鱼商品的原始信息改写成可发布的 listing 草稿：标题≤30字、4段式描述、5个话题标签，输出纯 JSON，供 xy_publish_draft 校验与入队。
whenToUse: 用户要求写/改闲鱼商品标题或描述、生成发布草稿、批量改写 listing，或把商品信息转成 xy_publish_draft 入参时。
---

# 闲鱼 listing 改写

## 目标

输入一份商品事实（JSON），输出一份可直接交给 `xy_publish_draft` 的草稿 JSON。**只做事实重写，不编造卖点、不改实物属性**。发布页只有标题与描述两个文本字段，没有独立标签字段；5 个话题标签写进描述末尾。

## 前置

- 输入契约：`references/input-schema.json`；输出契约：`references/output-schema.json`。
- 模板与 few-shot：`references/templates.md`；红线：`references/red-lines.md`。
- 阈值与 `packages/core/src/policy.ts` 对齐：标题 ≤30 字（warn）、描述 ≥30 字（warn）、图片 1–9 张（error）、首图 1:1（warn）、38 条违禁词（error）、20 条禁售类目（error）。

## 语言风格（tone）

风格是**注入变量**：不改变四段式结构与事实来源，只改变措辞与详略。取值与 `xy_copy_plan` 的 `styleId` 同集合：

| id | 名称 | 一句话 |
| --- | --- | --- |
| `plain`（默认） | 闲鱼口语 | 短句直给，像老买家聊天，不客套 |
| `warm` | 亲切安利 | 带使用感受与推荐理由，语气温和 |
| `professional` | 参数党 | 参数与成色逐条列清楚 |
| `urgent` | 急出清仓 | 节奏快、直奔交易条件（不写虚假紧迫） |
| `story` | 场景氛围 | 场景开头，但参数与瑕疵必须完整保留 |

执行要求：**风格与事实冲突时事实优先**（例如 `urgent` 也不能承诺「当天必发」）；风格词不占标题的检索词位置；风格不能挤掉瑕疵与交易说明。

## 步骤

1. **归一化输入**：价格已是整数分；成色按枚举；瑕疵保留「位置 + 现象 + 实拍可证」；缺必填字段不要猜，记 `warnings` 并输出 `ok:false`。
2. **判定类目**：有 `categoryHint` 时回填；没有则给 3 个 `categoryCandidates`（path + confidence）。发布页类目由页面 AI 识别，工具不自动选，这里只做提示。
3. **写标题**：公式 `[品牌/系列] + [品类词] + [核心规格/型号] + [成色或差异点]`。前 15 字放最值钱的检索词；不写价格、不写「包邮」；无 emoji；无极限词（见红线）。用 `Array.from(title).length` 计到 ≤30。
4. **写描述四段**（段间空行，每段 1–3 句，第 4 段末尾追加标签行）：
   - 第 1 段「是什么」：品牌 + 型号 + 规格 + 成色，第一句给结论；
   - 第 2 段「为什么出/适合谁」：真实使用场景与出售原因；
   - 第 3 段「细节与瑕疵」：功能、配件清单、逐条瑕疵；`usedAiImages=true` 时在这段写「部分图片为 AI 场景示意，实物以实拍图为准」；
   - 第 4 段「交易说明」：发货/自提、包邮与否、议价规则、售后边界。
5. **写 5 个标签**：`#` + 词，按「1 类目大词 + 2 精准型号/属性词 + 1 场景词 + 1 状态/人群词」；不重复堆砌，必须能在标题/描述里找到语义依据。标签行拼成 `#a #b #c #d #e`。
6. **自检**：逐条对照 `references/red-lines.md`；标题超字先删形容词再删规格；命中违禁词就换词；仍有 error 级问题则 `ok:false`，不要带病交付。
7. **输出**：只输出 JSON 对象（= `output-schema.json` 的结构），字段顺序按 schema；`desc` 必须包含四段与标签行，`descParagraphs` 只放四段正文。

## 输出要求

- **纯 JSON**：不加 markdown 围栏、不加解释、不输出注释。
- `draft.images` 原样使用调用方给的绝对路径，不重命名、不转码、不生成路径。
- `draft.priceCents` 保持整数分；`shipping` 只能是 `free`/`none`。
- `variants` 给 0–3 套备选（按 `variantCount`），每套必须同样过自检。

## 与工具衔接

0. 只有最小事实（商品名/成色/价格）时，先调 `xy_copy_plan(styleId, productName, condition, priceYuan)` 拿注入好的提示词；它只读、不调模型，会带出风格约束、契约路径与「待补项」（如图片路径）。
1. 输出草稿 JSON 后，先调 `xy_publish_draft(mode="dry-run")`，把草稿文件路径传给它；dry-run 只读、不写队列。
2. 人工确认价格、图片、AI 图声明。
3. 确认后才 `mode="enqueue"`；`xy_publish_draft` 会走人工审批门禁。**不要自己发布，也不要在 daemon 里调模型。**

## 红线（详见 references/red-lines.md）

- 不写绝对化用语、假货术语、医疗功效、收益承诺；不碰禁售类目。
- 不虚构材质/尺寸/配件/瑕疵状态；不用 AI 图掩盖瑕疵。
- 虚拟资源不写「永久」「包更新」等无法履约承诺，不含盗版/破解/账号共享。
- 标题不用 emoji，不堆砌关键词，不复制他人商品文案。

## 示例（few-shot 完整版见 references/templates.md）

```json
{"ok":true,"draft":{"title":"iPhone 13 128G 星光色 电池89 无维修","desc":"iPhone 13 128G 星光色，国行，电池健康 89%，无维修史。\n\n换 16 后闲置，适合当备用机或给家人用，日常拍照和续航都够。\n\n边框有两处细微磕碰（图 3），屏幕无划痕，配件只有原装充电线。\n\n顺丰包邮，可小刀，当天发货；二手商品非质量问题不退。\n\n#数码 #iPhone13 #二手手机 #备用机 #闲置","descParagraphs":["iPhone 13 128G 星光色，国行，电池健康 89%，无维修史。","换 16 后闲置，适合当备用机或给家人用，日常拍照和续航都够。","边框有两处细微磕碰（图 3），屏幕无划痕，配件只有原装充电线。","顺丰包邮，可小刀，当天发货；二手商品非质量问题不退。"],"tags":["#数码","#iPhone13","#二手手机","#备用机","#闲置"],"categoryCandidates":[{"path":["数码","手机"],"confidence":0.95}],"priceCents":129900,"shipping":"free","images":["D:/photos/iphone13-01.png"]},"variants":[],"warnings":[]}
```

注意：示例里的 `\n` 是 JSON 字符串内的转义；实际输出 `desc` 用真实换行也可以，但必须是合法 JSON。
