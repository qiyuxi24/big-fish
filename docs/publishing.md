# 发布与安装说明（bigfish 插件双包）

> 本文是**给维护者（人）看的 runbook**：哪些步骤已经在 CI 里、哪些必须你在
> npmjs.com 网页手动做、以及本机为什么发不了。不是给 LLM 的指令。
> 背景与取舍见 [ADR 0008：npm 发布用快照改名](adr/0008-npm-publish-snapshot.md)。

## 包名（要发给别人 / 自己记的就这两个）

| npm 包名 | 内容 | 依赖 |
| --- | --- | --- |
| **`bigfish-plugin-ops`** | 运营插件本体：16 个 `xy_*` 工具、侧边栏面板、设置卡片 | 运行期零依赖 |
| **`bigfish-ops-bundle`** | 产品 bundle：声明 `dsh.bundle.patch` 把插件装进 DSH profile | `bigfish-plugin-ops`（同版本） |

- GitHub 仓库：<https://github.com/qiyuxi24/big-fish>
- 许可证：MIT（仓库根 `LICENSE`，Copyright (c) 2026 qiyuxi24）
- 版本由 git tag / workflow_dispatch 输入决定，**源码里的 `0.0.0` 不发布**。

### 为什么不是 `@bigfish/*`

仓库源码里的包名是 `@bigfish/plugin-ops` / `@bigfish/ops-bundle`（本机 DSH profile
的 junction 与 `cordis.yml` 在用，不能改）。但 npm 上的 `@bigfish` scope 属于第三方
bigfish.tv（`@bigfish/eslint-config` 等包的 maintainers 是 `bigfishtv-developer` 等），
用户账号往这个 scope 发会 403。所以发布名去掉 scope，由 `scripts/build-publish.mjs`
在发布时生成一份**整体自洽**的改名快照（loader id、cordis.patch.yml 的 name、
README 一起改），源码保持原样。详见 ADR 0008。

## 已经就位的东西（本仓库已提交）

- `LICENSE`（MIT）
- `scripts/build-publish.mjs <version>`：生成 `.scratch/publish/{plugin-ops,ops-bundle}` 快照
- `scripts/build-publish.test.mjs`：快照自洽性单测（5 个用例）
- `.github/workflows/publish.yml`：OIDC 发布流水线
- 本文档 + ADR 0008

本地验证过（2026-11-05，沙箱内）：

```
node scripts/build-publish.mjs 0.1.0        # 改写 40 个文件
node scripts/test-all.mjs scripts/build-publish.test.mjs   # 5 pass / 0 fail
# 两个快照目录里 npm pack --dry-run：
#   bigfish-plugin-ops   44 文件 / 184231 B（只带 index.js client.js cordis.patch.yml src/ LICENSE README）
#   bigfish-ops-bundle    5 文件 /   2090 B
```

## 发布流水线怎么工作

`.github/workflows/publish.yml` 触发条件：push `v*` tag（如 `v0.1.0`），或手动
`workflow_dispatch` 填 version。步骤：

1. `actions/checkout@v7` + `actions/setup-node@v7`（Node 24、`package-manager-cache: false`）。
2. `npm i -g npm@^11.5.1`（OIDC 要求 npm ≥ 11.5.1）。
3. `node scripts/build-publish.mjs <version>` 生成快照。
4. **先**在 `.scratch/publish/plugin-ops` 跑 `npm publish`，**再**在 `ops-bundle` 跑
   （顺序不能反：bundle 依赖 plugin）。
5. 全程不设 `NODE_AUTH_TOKEN`：npm 自己用 GitHub 签发的 OIDC ID token 换短期凭据，
   并自动附带 provenance。

`permissions` 必须是 `contents: read` + `id-token: write`。Trusted Publisher 配置里的
owner / repo / **workflow 文件名（`publish.yml`）** 必须与实际运行身份精确匹配，
否则即便包存在也会 `E404 Not Found`（actions/setup-node advanced-usage.md）。

## ⚠️ 首次发布：必须你手动做一次（本机发不了）

本机（DSH 沙箱）**没有 npm 登录态**：`npm whoami` → `ENEEDAUTH`，
`NPM_TOKEN` / `NODE_AUTH_TOKEN` 全 absent，`gh auth status` → not logged in。
所以以下两步只能你在**普通终端**做，本会话无法代做，也不该把凭据塞进仓库。

更关键的是 npm 官方 `npm trust` 文档（npm/documentation v12 `npm-trust.mdx`）明确写了：
**「Package must exist: The package you're configuring must already exist on the npm registry.」**
即 Trusted Publisher 必须配在「已存在的包」上；而配 Trusted Publisher 又需要 npm 登录。
⇒ **纯靠 OIDC 发第一版有先有鸡还是先有蛋的问题**，不要指望 workflow 自己建出包。
（npm 的「prospective / 未存在包」支持本会话无法核实——`web_search` 挂了、
`docs.npmjs.com/trusted-publishers/` 内容被截断——所以按最保守路径写。）

### 第 0 步：开 2FA

`npm trust` 命令要求账号级 2FA 已开启；Granular Access Token 的 bypass-2FA 选项
与旧式账密都不能用于 trust 命令。先在 <https://www.npmjs.com/settings> 开 2FA。

### 第 1 步：用一次性凭据把两个包「建出来」（只做一次）

```bash
# 在普通终端、已 npm login 的机器上：
git clone https://github.com/qiyuxi24/big-fish.git && cd big-fish
npm login                       # 账号要开 2FA；登录态只留在你本机
node scripts/build-publish.mjs 0.1.0

cd .scratch/publish/plugin-ops && npm publish --access public && cd -
cd .scratch/publish/ops-bundle && npm publish --access public && cd -
```

发完确认：

```
npm view bigfish-plugin-ops version
npm view bigfish-ops-bundle version
```

### 第 2 步：给两个包配 Trusted Publisher（网页或 CLI，各一次）

网页：npmjs.com → 包页 → Settings → **Trusted Publisher** → GitHub Actions →
填 owner `qiyuxi24` / repo `big-fish` / workflow file `publish.yml`（无 environment）。

CLI 等价（npm ≥ 11.15.0）：

```bash
npm trust github bigfish-plugin-ops --file publish.yml --repo qiyuxi24/big-fish --allow-publish
npm trust github bigfish-ops-bundle --file publish.yml --repo qiyuxi24/big-fish --allow-publish
npm trust list bigfish-plugin-ops
```

一个包目前只能有一条 trust 配置；要改就先 `npm trust revoke --id <id>`。

### 第 3 步：之后所有发布走 OIDC（不用 token）

```bash
git tag v0.1.1 && git push origin v0.1.1       # 自动触发 workflow
# 或 GitHub → Actions → Publish to npm (OIDC) → Run workflow 填 version
```

到 Actions 页面确认两次 `npm publish` 都成功；再用 `npm view` 核对版本。

> 若第 1 步发的是 `0.1.0`，第 3 步的 tag 必须是**没发过的新版本**（`0.1.1` 等），
> 否则 npm 报 `E403 You cannot publish over the previously published versions`。

## 安装（给用这个插件的人）

这两个包是 **DSH / Cordis 插件**，不是普通 Node 库；`npm i` 之后还要在 DSH profile
里声明 bundle（顺序在 `dsh-base` 之后、web/headless 之前）。两种装法：

**A. 用 bundle（推荐）** —— profile 的 `package.json` 加依赖，`dsh.profile.bundles` 里
写 `bigfish-ops-bundle`。bundle 的 `cordis.patch.yml` 会带默认 config
（`daemonUrl` / `writeGate` / `enabled`）。

**B. 只装插件** —— profile 里写 `bigfish-plugin-ops`，并自己写 `cordis.patch.yml`
的 `insert:` 行（`id: bigfish-ops`，`name: "bigfish-plugin-ops"`）。注意
**每一行是整段替换 config**，覆盖已有行必须把该行原有 key 全部重述。

装完**重启一次 DSH 桌面应用**（`scripts/dsh-install.mjs` 的注释也这么说）。
侧边栏会出现 BigFish 面板；宿主设置页的插件卡片里有「是否启用」开关
（关掉会真反注册 16 个工具，省掉每轮工具 schema 固定税）。

## 本地排障与已知限制（如实记录）

- `pnpm --dir packages/* pack` 出来的 tarball 名字是 `bigfish-*.tgz`，但内容是
  `@bigfish/*` + `private: true` + `0.0.0`，**不能直接发**；发的是 build-publish 快照。
- `node scripts/dsh-dump.mjs` 在 DSH 沙箱里 `spawn EPERM`（AGENTS §5 禁止 spawn），
  改动装配层后用 `packages/ops-bundle/test/cordis-patch.test.mjs` 做静态断言补偿。
- GUI 设置卡片需重建/重启 DSH 才能真机验收，沙箱内看不到。
- `ops-bundle` 的 `dependencies` 在快照里从 `workspace:*` 换成确切版本号，
  `client.js` 的 loader id 也换成无 scope 名——三处必须一致，单测会拦。
