# skills/：BigFish 的 DSH skill 集

这些 skill 由 **DSH agent** 装载执行，daemon 不认识它们。仓库运行时零依赖，skill 本身只是 markdown + JSON Schema。

## 装载

DSH 只扫描每个 skill 根**下一层**的 `<name>/SKILL.md`（或平铺 `<name>.md`），不递归。二选一：

- **推荐（团队）**：DSH settings 的 `customSkillDirs` 指向本目录（rank 300）。字段准确路径待验证。
- **本机**：把 `xianyu-listing-copy`、`xianyu-listing-audit` 复制/软链到 `.dsh/skills/`（rank 100，免配置，不提交 `.dsh/`）。

## 约定

- frontmatter 必须含 kebab-case `name` 与 `description`；可选 `whenToUse`。
- 输出一律**纯 JSON**（无 markdown 围栏），便于直接喂给 `xy_publish_draft`。
- 所有判定阈值以 `packages/core/src/policy.ts` 为准；改词表/阈值时同步 `references/red-lines.md` 与 `audit-codes.md`。
- 见 `docs/copywriting-and-imagegen-plan.md` 的方案与合规边界。
