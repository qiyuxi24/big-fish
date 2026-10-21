---
name: xianyu-listing-audit
description: 质检闲鱼 listing 草稿：标题字数、四段结构、5 个标签、违禁词、禁售类目、价格与图片规则、AI 图声明，输出问题码 JSON 与逐条修复建议。
whenToUse: 草稿已写好要发布前自检、用户问"这条 listing 有什么问题"、或批量发布前做合规抽检时。
---

# 闲鱼 listing 质检

## 目标

对一份草稿做**确定性检查**，输出问题码与修复建议。检查逻辑必须与 `packages/core/src/policy.ts` 的 `checkListing` 对齐（码名也沿用其 `PolicyIssueCode`，勿改名）；skill 只补文案结构类检查（四段、标签数、AI 图声明），不替代 `checkListing`。

## 输入

- 草稿 JSON（`xianyu-listing-copy` 的输出，或用户手写草稿）。
- 可选：`marketPriceCents`、`categoryPath`、`imageMeta`（每张图的宽度/高度，用于方形判定）。

## 检查项

共 **18 个问题码**：10 个与 `packages/core/src/policy.ts` 的 `PolicyIssueCode` 同名同义（error/warn 级别一致），8 个为 skill 独有的文案结构/路径校验。逐条映射见 `references/audit-codes.md`。

| 码 | 级别 | 判定 |
| --- | --- | --- |
| `TITLE_EMPTY` | error | 标题 trim 后为空 |
| `TITLE_TOO_LONG` | warn | `Array.from(title).length > 30` |
| `TITLE_EMOJI` | warn | 命中 `\p{Extended_Pictographic}` |
| `TITLE_KEYWORD_STUFF` | warn | 同一词重复 ≥3 次，或 title 含「包邮/特价/秒杀」等交易词 |
| `DESC_TOO_SHORT` | warn | `Array.from(desc.replace(/\s/g,"")).length < 30` |
| `DESC_MISSING_PARAGRAPH` | error | `descParagraphs` 不足 4 段或有空段 |
| `TAGS_COUNT` | warn | `tags` 不是 5 个，或有重复、格式不是 `#词` |
| `DESC_FORBIDDEN_WORD` | error | 描述命中 `xianyu-listing-copy/references/red-lines.md` 的违禁词（38 条，与 `FORBIDDEN_WORDS` 同源） |
| `CATEGORY_FORBIDDEN` | error | `categoryPath` 任一段命中禁售类目（20 条） |
| `PRICE_INVALID` | error | 不是 ≥100 的整数分 |
| `PRICE_DEVIATION` | warn | 与 `marketPriceCents` 偏离 >70% |
| `IMAGE_COUNT` | error | 图片数不在 1–9 |
| `IMAGE_FIRST_NOT_SQUARE` | warn | 有 `imageMeta` 且首图宽高不等 |
| `IMAGE_NOT_ABSOLUTE` | error | 图片路径不是本机绝对路径（`D:/…`、`/…`、`\\\\server\\…`） |
| `IMAGE_EXT` | error | 扩展名不在 png/jpg/jpeg/heic/webp |
| `AI_IMAGE_UNDISCLOSED` | warn | 草稿标了 AI 图但描述没有"AI/示意/以实拍为准"字样 |
| `FLAW_MISSING` | warn | 第 3 段没有任何瑕疵/「无瑕疵」表述 |
| `SHIP_MISSING` | warn | 第 4 段没写发货/包邮/自提/议价/售后中的至少两项 |

## 输出

只输出 JSON：

```json
{
  "ok": false,
  "score": 72,
  "issues": [
    { "code": "TITLE_TOO_LONG", "field": "title", "severity": "warn", "message": "标题 33 字，超过 30", "fix": "删掉「几乎全新」与「国行」，压到 30 内" }
  ],
  "summary": "3 个 warn、1 个 error；error 修正后才可入队"
}
```

- `ok` 只由 error 级问题决定（与 `checkListing` 语义一致）。
- `score`：100 起，每个 error −15、每个 warn −5，下限 0；仅用于排序，不参与发布判定。
- `fix` 必须给出可执行的改写（删哪个词/换成什么），不写"建议优化"。
- 不修改草稿本体；修复由 `xianyu-listing-copy` 或用户完成。

## 与工具衔接

质检通过后仍必须跑 `xy_publish_draft(mode="dry-run")` —— skill 无法替代 daemon 侧 `checkListing` 与真机表单校验。
