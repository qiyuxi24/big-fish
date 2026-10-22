# 问题码与 core/policy.ts 的映射

`xianyu-listing-audit` 共 **18 个问题码**：其中 **10 个沿用 `packages/core/src/policy.ts` 的 `PolicyIssueCode` 同名同义**（下表），另 **8 个为 skill 独有**（见下文）。改任一侧时必须同步另一侧与 skill 的检查表。

| audit 码 | core 码 | 级别 | 来源 |
| --- | --- | --- | --- |
| `TITLE_EMPTY` | `TITLE_EMPTY` | error | `policy.ts:162` |
| `TITLE_TOO_LONG` | `TITLE_TOO_LONG` | warn | `policy.ts:166`，阈值 30 |
| `TITLE_EMOJI` | `TITLE_EMOJI` | warn | `policy.ts:168` |
| `DESC_TOO_SHORT` | `DESC_TOO_SHORT` | warn | `policy.ts:176`，阈值 30 |
| `DESC_FORBIDDEN_WORD` | `DESC_FORBIDDEN_WORD` | error | `policy.ts:180` |
| `PRICE_INVALID` | `PRICE_INVALID` | error | `policy.ts:189`，下限 100 分 |
| `PRICE_DEVIATION` | `PRICE_DEVIATION` | warn | `policy.ts:198`，阈值 70% |
| `IMAGE_COUNT` | `IMAGE_COUNT` | error | `policy.ts:207`，1–9 张 |
| `IMAGE_FIRST_NOT_SQUARE` | `IMAGE_FIRST_NOT_SQUARE` | warn | `policy.ts:210` |
| `CATEGORY_FORBIDDEN` | `CATEGORY_FORBIDDEN` | error | `policy.ts:223` |

skill 独有（core 不做）：

| 码 | 级别 | 说明 |
| --- | --- | --- |
| `DESC_MISSING_PARAGRAPH` | error | 四段结构缺失；发布页是富文本，结构错了可读性差、权重低 |
| `TAGS_COUNT` | warn | 5 个标签是文案规范，不是平台字段 |
| `TITLE_KEYWORD_STUFF` | warn | 关键词堆砌/交易词进标题 |
| `IMAGE_NOT_ABSOLUTE` / `IMAGE_EXT` | error | 发布链路要求本机绝对路径与 accept 白名单 |
| `AI_IMAGE_UNDISCLOSED` | warn | 合规要求，见 `docs/copywriting-and-imagegen-plan.md` §4.2 |
| `FLAW_MISSING` / `SHIP_MISSING` | warn | 二手交易纠纷高发项 |

注意：`policy.ts` 的 `checkListing` 只看 `title`/`description`/`priceCents`/`imageCount`/`firstImageSquare`/`marketPriceCents`/`categoryPath`；skill 的 `descParagraphs`/`tags` 是文案层概念，`desc` 才是提交字段。
