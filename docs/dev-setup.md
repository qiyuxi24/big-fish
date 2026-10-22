# 开发环境与运行方式（P1.2）

## 前置

- Node **≥ 24**（本机用 Node 24：TS 类型擦除 + `node:sqlite` 都依赖它）
- pnpm 11.7（`packageManager` 已固定，`corepack enable` 即可）
- 类型检查借用 DSH checkout 的 tsc（见下），仓库自身不装 devDependencies

## 安装

本机 registry 不可达，**必须离线安装**：

```sh
pnpm install --offline --ignore-scripts
```

如果 `.pnpm-store` 里没有需要的包，会报 `ERR_PNPM_NO_OFFLINE_META`。运行时零第三方依赖，workspace 内各包用 `node_modules` 里的符号链接互相引用（daemon 额外依赖 `@bigfish/channel-mtop` 与 `@bigfish/channel-cdp`，同样走 workspace 链接）。

## 测试与类型检查

```sh
node scripts/test-all.mjs                   # 全量（27 suites，约 12s）
node scripts/test-all.mjs packages/core     # 只跑某个包（按路径前缀过滤）
node scripts/test-all.mjs integration       # 只跑跨层集成测试
```

- **本文件不重复具体用例数**：数字随开发漂移（AGENTS §0 已裁过「同一个数字出现过 6 个版本」），以这次命令的实际输出为准；能力状态看 `docs/STATUS.md`。
- `ops-bundle` 只声明 bundle patch，无测试。

- 不用 `node --test`、不用 vitest：沙箱禁止 spawn，脚本在单进程里顺序 import 测试文件再由 `node:test` 汇总。
- `scripts/typecheck.mjs` 在本沙箱会因 `spawnSync node.exe EPERM` 报错（不是类型错误）。**直跑 tsc**：

```sh
node 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/typescript/bin/tsc' \
  --noEmit --pretty false -p packages/daemon/tsconfig.json \
  --typeRoots 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/@types'
```

把 `packages/daemon` 换成 core / channel-mtop / channel-cdp / channel-guanjia / channel-im 即可逐包检查（6 个 TS 包均 0 错误）；plugin-ops 与 ops-bundle 是纯 ESM JS、没有 tsconfig，**不在类型检查覆盖内**（靠 JSDoc + 单测）。

## 项目级 skill（`.agents/skills/`）

DSH 的 `skill-filesystem` 只扫**项目根**两个目录：`.dsh/skills/`（本机私有，不提交）与 `.agents/skills/`（仓库共享，随 git 提交）。每个根只看下一层 `<name>/SKILL.md`（或平铺 `<name>.md`），不递归；frontmatter 必须含 kebab-case `name` + `description`，缺失/非法只 warn 后忽略。

本仓的 2 个文案 skill 已从 `skills/` **迁到 `.agents/skills/`**（`git mv`，2026-10-22）：

```
.agents/skills/
  xianyu-listing-copy/   SKILL.md + references/{input-schema.json,output-schema.json,templates.md,red-lines.md}
  xianyu-listing-audit/  SKILL.md + references/audit-codes.md
```

- 放在仓库里即被自动发现，**不需要** `customSkillDirs`，也不需要复制/软链到 `.dsh/`（迁移后当前会话的 skill 列表立刻出现两个 `xianyu-listing-*`，已实测）。
- **`skills/` 不会被发现**——这就是迁移原因；不要再在仓库根建 `skills/`。
- 目录名与 frontmatter `name` 保持一致，否则装载按 name 走会错位。
- 插件侧提示词里的 `SKILL_PATH`（`packages/plugin-ops/src/copy.js`）要跟着改成 `.agents/skills/xianyu-listing-copy`，否则提示词指向不存在的路径。
## 起 daemon

```sh
node packages/daemon/src/cli.ts --help
node packages/daemon/src/cli.ts --print-config
node packages/daemon/src/cli.ts --data-dir .scratch/daemon --port 47001
```

- 启动即装配**完整运行时**（`startDaemonRuntime`）：SQLite store → 队列 → 商品仓储 → 凭据 → 限流 → 熔断 → 执行器 → worker → HTTP 服务。**worker 默认自动开始轮询**，所以起 daemon 就会执行队列里的任务。
- 数据目录默认 `%LOCALAPPDATA%\bigfish`（win32）/ `~/.local/share/bigfish`；`--data-dir` 会重算 db / 凭据 / 熔断 / token 四个路径。
- `--port 0` 让系统分配端口（冒烟用）；默认 47001。
- 首次启动在数据目录生成 `daemon.token`（32 字节 hex，0600）。**token 不进版本库**，插件按同一路径读取。
- 只允许绑定回环地址；`--host` 给非回环值会直接以退出码 1 拒绝。
- 日志是一行一条 JSON（`{"t":...,"level":"info","name":"bigfish-daemon","msg":"daemon 已启动","url":...,"workerOwner":...}`）。
- `SIGINT` 优雅退出：先停 worker（release 在飞任务）再关 HTTP 与 store。

## 常驻运行（过夜跑）

前台 `npm run daemon` 关终端即丢现场；需要过夜跑时用 `scripts/daemon-service.mjs`（detached 子进程 + 日志文件 + pid 文件）：

```sh
npm run daemon:start                          # 后台起，等 /health 就绪后打印 pid/端口/日志路径
npm run daemon:status                         # pid + 进程 + /health 三判据，附带 uptime 与日志尾部
npm run daemon:logs                           # 看日志尾部（默认 40 行；-- --tail 100 调整）
npm run daemon:stop                           # 优雅停止（超时强杀），并确认端口释放
npm run daemon:restart                        # stop + start
npm run daemon:start -- --port 47002 --data-dir .scratch/daemon-live
```

- 状态目录（pid + 日志）默认 `%LOCALAPPDATA%\bigfish`，非 Windows 用 `~/.bigfish`：pid 在 `run/daemon.pid`（JSON：pid/port/host/startedAt/dataDir/logPath），日志在 `logs/daemon.log`（daemon 的结构化 JSON 行原样落盘）。
- 状态目录与数据目录分离：`--data-dir` 只换 daemon 的 SQLite/token/凭据，pid 与日志仍固定在状态目录；需要完全隔离（如本地验证）时加 `--state-dir .scratch/daemon-state`。
- 单实例：已有 pid 且 `/health` 可达 → 提示「已在运行」并退出 0，不会重复起；pid 残留但进程已死 → 自动清理；pid 丢了但端口上有 daemon 应答 → 接管补写 pid 文件；端口被别的进程占 → 退出 1 并提示换端口。
- 端口：`--port` > 环境变量 `BF_PORT` > 47001；常驻模式不接受 `--port 0`（无法轮询固定端口）。
- 退出码：`0` 成功 / `1` 失败（`status` 在 daemon 未运行时也返回 1，便于脚本判断） / `2` 参数错误。
- 停止语义：POSIX 发 `SIGTERM`，daemon 的 handler 会先停 worker（release 在飞任务）再关 HTTP/store，是真正的优雅退出。**Windows 无法向别的进程投递可捕获信号**：先尝试 `taskkill /PID <pid> /T`（控制台程序一般失败），回落 `TerminateProcess`，相当于崩溃退出；10s 未退出再 `taskkill /T /F` 强杀。因此 Windows 上 stop 依赖 crash-safe 设计：SQLite WAL + 队列任务租约（60s TTL）保证重启后能恢复，不会重复发布（uniqueCode 幂等）。
- `logs` 只读尾部、不 `-f` 跟随，避免占住终端；`--tail` 最多 1000 行。
- daemon 是 detached 子进程：关掉当前终端不会带走它；需要停止用 `npm run daemon:stop`（或 `status` 拿 pid 后手动结束）。
- 真机验证（隔离数据与状态，避免打扰已导入账号）：`npm run daemon:start -- --port 47999 --data-dir .scratch/svc/data --state-dir .scratch/svc/state` → `status` 看到 pid / 端口 / uptime → `stop` 确认「端口已释放」。

### 手动冒烟一次 probe（不发外网）

daemon 用的是真 mtop 传输，没有登录态时任务会以 `AUTH_EXPIRED` 失败——这本身就是正确结果。要验证「校验→限流→凭据→通道」的顺序，跑集成测试更省事：

```sh
node packages/daemon/test/runtime.test.ts
```

它用假 transport + 临时目录 + 真 HTTP，断言 probe 落库、无凭据不调通道、publish 进 `UNSUPPORTED` 等 5 条链路。**不要**用真实账号跑（AGENTS §5）。

## 在隔离 DSH_HOME 里验证插件装配

不碰用户自己的 `~/.dsh`：

```sh
node scripts/dsh-dump.mjs           # 造临时 profile + --dump-config 断言插件行已装配
node scripts/dsh-dump.mjs --smoke   # 再真实启动一次 web（端口 0），等插件打印加载日志
node scripts/dsh-dump.mjs --keep    # 保留 .scratch/.dshcheck 便于排查
```

- profile 名固定 `bigfish-dev`，bundles = `[@deepseek-ai/dsh-base, @bigfish/ops-bundle, @deepseek-ai/dsh-web-app]`。
- 脚本会去 `~/.dsh/profiles[/<name>]/node_modules` 找一个已装 `@deepseek-ai/dsh-base` 的目录，用 **junction** 借用（不复制、不重新安装）。
- 需要 DSH CLI：默认找 `C:/Users/34239/Documents/GitHub/deepseek-harness/apps/cli/lib/bin.js`，可用 `DSH_CHECKOUT` 覆盖。

## 热调试 client 插件（侧边栏栏位）

```sh
node scripts/dsh-dev.mjs --fresh   # 隔离 DSH_HOME(.scratch/.dshdev)，起 web 到 127.0.0.1:47080
node scripts/dsh-shot.mjs          # CDP 打开页面、点栏位、断言面板文案、截图 .scratch/shots/
node scripts/dsh-shot.mjs --hmr    # 改 client.js 后不刷新页面断言新文案，然后自动还原
node scripts/dsh-dev.mjs --stop    # 停实例
```

- 手写 `packages/plugin-ops/client.js` 即可，**不需要** `pnpm run dev:web`：web-app bundle 无条件挂 `client-hmr`，
  宿主按 mtime+size 轮询 bundle，经 `/plugins/events` SSE 推 `rebuilt`，浏览器原地换插件。
- HMR 后主区域会回落到会话欢迎页（activePanelId 被重置），**再点一次侧边栏栏位**即可看到新面板。
- 机制细节、路由 404 现象与 6 个实测坑见 [client-plugin-sidebar.md](client-plugin-sidebar.md)。

## 装进真实 DSH profile（脚本）

```sh
node scripts/dsh-install.mjs --dry-run     # 先看会改什么
node scripts/dsh-install.mjs               # 装进 ~/.dsh/profiles/desktop
node scripts/dsh-install.mjs --profile web # 换 profile
node scripts/dsh-install.mjs --uninstall   # 撤销（备份文件保留）
```

脚本会：写 profile `package.json` 的 `dependencies`（`link:<repo>/packages/ops-bundle`）、把
`@bigfish/ops-bundle` 插到 `dsh.profile.bundles` 的 `dsh-base` 与 `dsh-web-app` 之间、在 profile 的
`node_modules/@bigfish/` 建 junction 指向本仓、改动前备份 `package.json.bak-bigfish-<ts>`。

- **装完要完全退出并重开 DSH 桌面应用一次**：bundle 列表只在启动时读取。
- 之后继续改 `packages/plugin-ops/client.js` 是热替换，**不用再重启**。
- `desktop` profile 由 Electron 独占，`dsh --profile desktop --dump-config` 会被拒绝；装完只能在界面确认。
- 手工等价步骤：`dependencies` 加 link、`dsh.profile.bundles` 插一行、`node_modules/@bigfish` 建 junction，
  然后重启；不需要 pnpm install。

## 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_MODULE_NOT_FOUND` 指向 `./index.ts` | `package.json` 的 main/exports 写成了 `.ts` | 插件包必须指向 `./index.js` |
| Cordis 报 `cannot get property "tools" without inject` | 插件没声明注入 | `export const inject = ['tools']` |
| 插件工具没出现 | bundle 层没装配 / patch 行 id 冲突 | 跑 `node scripts/dsh-dump.mjs`，看 `--dump-config` 里有没有 `bigfish-ops` 行 |
| daemon 起不来，退出码 1 | 端口占用 / 非回环 host / 数据目录不可写 | 看 stderr 的第一行；`--print-config` 核对路径 |
| 插件返回 `[UNAUTHORIZED]` | token 文件缺失或路径不一致 | 核对 `--token-path` 与插件 `tokenPath` 配置 |
| 任务一直 `failed` 且错误含 `UNSUPPORTED` | 该操作还没接通道（publish/deliver/reply） | 预期行为，见 architecture §6/§11 |
| 任务 `failed` 且错误含 `登录态`/`AUTH_EXPIRED` | 没往凭据库写过该账号，或凭据过期 | 先跑 `npm run daemon:import-account`（从浏览器导入 cookie）或 `npm run daemon:login`（扫码登录，已实现） |
| `ExperimentalWarning: SQLite` | `node:sqlite` 是实验 API | 正常，忽略 |
| `bundle <url> loaded without registering "<id>"` | `client.js` 里 `__ModuleLoader__.load({id})` 与包名不一致 | id 必须等于 loader entry 包名 |
| `layout.selectPanel: main panel "bigfish" is not registered` | 只注册了 `sidebar.panellist` 没注册 `main` | 两个插槽成对注册（见 client-plugin-sidebar.md） |
| 点栏位没反应 | 用 textContent 匹配命中了外层 `<nav>` | 精确点 `button[aria-label="BigFish 闲鱼运营"]` |

## 本机环境的坑

- `ops_bash` 里的 curl/wget 对外网返回 000；需要联网时用 `run_code` 内的 Node `fetch`（见 AGENTS.md）。
- 沙箱禁止 spawn 子进程，所以测试脚本、daemon 启动都在单进程内完成；`scripts/dsh-dump.mjs` 是唯一例外（它会 spawn DSH CLI，在本机 danger-full-access 下可用）。
- 临时文件统一放 `.scratch/`（已 gitignore）。
