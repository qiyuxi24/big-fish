# @bigfish/ops-bundle

只做一件事：声明 `dsh.bundle.patch`，把 `@bigfish/plugin-ops` 插进 DSH profile。

- `cordis.patch.yml` 内容是一行 `insert`：`id: bigfish-ops` / `name: "@bigfish/plugin-ops"`，并给默认 config（`daemonUrl`、`writeGate`）。
- 注意：patch 里一行是**整段替换 config**，覆盖时必须重述所有 key。
- 用法：profile 的 `dsh.profile.bundles` 里写 `@bigfish/ops-bundle`（顺序在 dsh-base 之后、web/headless 之前）。
- 验证：`node scripts/dsh-dump.mjs`。
