# ADR 0008：npm 发布用「快照改名」而不是改源码包名

- 状态：已采纳（2026-11-05）
- 关联：[ADR 0001 不 fork 上游 / bundle 交付](0001-*.md)、[发布与安装说明](../publishing.md)
- 实现：`scripts/build-publish.mjs`、`scripts/build-publish.test.mjs`、`.github/workflows/publish.yml`、`LICENSE`

## 背景

用户 2026-11-05 要求「打包 → 发布 npm → 给包名」。核查发现三件事撞在一起：

1. **`@bigfish` 这个 npm scope 不属于用户**。`@bigfish/eslint-config` 等 3 个包的 maintainers 是
   `bigfishtv-developer` / `clay-bigfish` / `jacobclarke-bigfish`（bigfish.tv，第三方），
   2022–2026 一直在发。用户的 npm 账号往 `@bigfish/*` 发会 403。
   具体名 `@bigfish/plugin-ops`、`@bigfish/ops-bundle` 虽然空着，但 scope 归属是另一回事。
2. **源码身份不能改**。本机 DSH desktop profile 用 junction 装的是
   `@bigfish/ops-bundle` / `@bigfish/plugin-ops`，`cordis.yml` 里写的也是这两个名字；
   `client.js` 的 loader id 按 AGENTS §4 必须等于包名。把 `package.json` /
   `cordis.patch.yml` / `client.js` 里的名字直接改成无 scope，宿主会去找
   `node_modules/bigfish-plugin-ops`（不存在）→ **破坏正在运行的 profile**。
   全仓 `@bigfish/(plugin-ops|ops-bundle)` 共 90 处，其中 ~20 处是功能耦合，不是注释。
3. **8 个包全是 `private: true` + `version 0.0.0`**，没有 license / repository / publishConfig，
   根没有 LICENSE，仓库没有 `.github/workflows/`。

用户拍板：发布名用**无 scope 双包** `bigfish-plugin-ops` + `bigfish-ops-bundle`；
发布走 **GitHub Actions OIDC（Trusted Publishing）**，我准备 workflow 并推送，
用户在 npm 网页配置 Trusted Publisher 后打 tag 触发。

## 约束（核实过，不是推测）

- `pnpm pack` 会把 `workspace:*` 自动转成 `"0.0.0"`；但快照要从零依赖、自洽的角度重新生成。
- `grep 'from ["@]@bigfish/'` 在 `packages/plugin-ops` **零命中**：插件运行期自包含，
  不 import 任何 `@bigfish/*` 包（AGENTS §2 零依赖）。⇒ 单独发布一份改名副本可行。
- npm Trusted Publishing（`npm trust` 权威文档，npm/documentation v12 `npm-trust.mdx`）：
  - npm ≥ **11.5.1** 才能 publish via OIDC；`npm trust` CLI 要 ≥ **11.15.0**。
  - **「Package must exist: The package you're configuring must already exist on the npm
    registry.」** ⇒ 纯靠 OIDC 做「首次发布」有先有鸡还是先有蛋的问题：
    要配 Trusted Publisher 先得包存在，要发第一个包先得有凭据。
  - 配置要求 owner / repo / **workflow 文件名**精确匹配；`npm trust github <pkg>
    --file publish.yml --repo qiyuxi24/big-fish --allow-publish`。
  - 账号必须开 2FA；Granular Access Token 的 bypass-2FA 选项与旧式账密都不能用于 trust 命令。
- setup-node advanced-usage.md：OIDC 不用 `NODE_AUTH_TOKEN`；`id-token: write`；
  `package-manager-cache: false`（缓存投毒可能泄露含 OIDC token 的凭据）。

## 决策

1. **源码保持 `@bigfish/*` 不变**，包括 package.json / cordis.patch.yml / client.js loader id /
   test 断言。live profile 不受影响。
2. **发布时生成「自洽快照」**：`scripts/build-publish.mjs <version>` 把
   `packages/plugin-ops` 与 `packages/ops-bundle` 复制到 `.scratch/publish/*`，逐字替换两个包名
   （含 loader id、cordis.patch.yml 的 name、README、@module 注释），补
   `license/repository/publishConfig/files`、去掉 `private`、`workspace:*` 换成真实版本号、
   写新 README、复制根 LICENSE、把 `index.js` 的 `export const version` 改成真实版本。
   自洽性校验：loader id / bundle patch name 必须改到、快照里不得残留 `@bigfish/*`。
3. **发到 npm 的是快照，不是 workspace 包**。workflow 先 `node scripts/build-publish.mjs`，
   再分别在两个快照目录 `npm publish`，顺序先 `plugin-ops` 后 `ops-bundle`（后者依赖前者）。
4. **OIDC 是「日常发布」通道，不是「首次建包」通道**。首次需要用户用一次性凭据
   （granular access token + `npm publish`）把两个包建出来，之后所有发布走 OIDC。
   这一点在 `docs/publishing.md` 里如实写明，不假装 workflow 能自己发第一版。
5. **补 ADR 要求的许可证**：根 `LICENSE` 用 MIT（Copyright (c) 2026 qiyuxi24），
   不复制 `packages/channel-guanjia/LICENSE`（那是第三方 MIT 移植，Copyright kingofmarketing）。

## 被否掉的方案

| 方案 | 为什么不做 |
| --- | --- |
| 直接把源码包名改成无 scope | 破坏正在运行的 DSH profile（junction + cordis.yml + loader id 三处引用） |
| 争取 `@bigfish` scope / 加 peerDependencies | scope 归第三方；AGENTS §4 当前不声明 peerDependencies（离线解析不了） |
| 用 `@qiyuxi24/*` 用户 scope | 用户明确选了「无 scope 双包」 |
| 发布时只改 package.json 的 name | loader id 与 cordis.patch.yml 的 name 不改会导致宿主按错名字取 client.js，装不上 |
| workflow 里用 `NODE_AUTH_TOKEN` 发 | 用户拍板 OIDC；setup-node v5 起移除了哑元，OIDC 不受影响 |
| 声称 OIDC 能发第一版 | `npm trust` 明确要求包已存在；不能把未证实的事说成已跑通 |

## 代价

- 源码里的包名（`@bigfish/*`）与 npm 上的名字（`bigfish-*`）**永久不一致**，每次发布都要走快照脚本；
  忘了跑会被 workflow 与单测拦住。
- 快照目录在 `.scratch/` 下被 `.gitignore` 忽略，靠 `package.json` 的 `files` 白名单保证
  npm 只带运行时文件（不带 `test/`）；实测 `npm pack --dry-run`：plugin 44 文件 / bundle 5 文件。
- OIDC 首次建包仍需用户手动做一次 token 发布；本机 npm 无登录态，无法代做。
- GUI 侧（设置卡片）需重建/重启 DSH 才能验收，与本 ADR 无关但同属「沙箱内验不了」。
