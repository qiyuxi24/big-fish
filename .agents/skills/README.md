# .agents/skills/：BigFish 的 DSH 项目级 skill 集

这些 skill 由 **DSH agent** 装载执行，daemon 不认识它们。仓库运行时零依赖，skill 本身只是 markdown + JSON Schema。

## 装载

DSH 的 `skill-filesystem` 只扫**项目根**的 `.dsh/skills` 与 `.agents/skills` 两个根，每个根只看**下一层**的 `<name>/SKILL.md`（或平铺 `<name>.md`），不递归。本目录就是项目级 skill 根（2026-10-22 从 `skills/` 迁入，`git mv`）：

- **零配置**：克隆仓库后 DSH 启动即自动发现，不需要 `customSkillDirs`，也不需要复制/软链到 `.dsh/`。
- 迁移后当前会话的 skill 目录立刻出现 `xianyu-listing-audit` / `xianyu-listing-copy`（实测）。
- 目录名必须等于 frontmatter 的 `name`，否则按 name 装载会错位。

## 约定

- frontmatter 必须含 kebab-case `name` 与 `description`；可选 `whenToUse`。
- 输出一律**纯 JSON**（无 markdown 围栏），便于直接喂给 `xy_publish_draft`。
- 所有判定阈值以 `packages/core/src/policy.ts` 为准；改词表/阈值时同步 `references/red-lines.md` 与 `audit-codes.md`。
- 见 `docs/copywriting-and-imagegen-plan.md` 的方案与合规边界。
