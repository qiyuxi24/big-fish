# 开发环境与运行方式（P1.1）

## 前置

- Node **≥ 24**（本机用 Node 24：TS 类型擦除 + `node:sqlite` 都依赖它）
- pnpm 11.7（`packageManager` 已固定，`corepack enable` 即可）
- 类型检查借用 DSH checkout 的 tsc（见下），仓库自身不装 devDependencies

## 安装

本机 registry 不可达，**必须离线安装**：

```sh
pnpm install --offline --ignore-scripts
```

如果 `.pnpm-store` 里没有需要的包，会报 `ERR_PNPM_NO_OFFLINE_META`。运行时零第三方依赖，workspace 内各包用 `node_modules` 里的符号链接互相引用（daemon 额外依赖 `@bigfish/channel-mtop`，同样走 workspace 链接）。

## 测试与类型检查

```sh
node scripts/test-all.mjs                   # 全量：379 tests / 379 pass
node scripts/test-all.mjs packages/core     # 只跑某个包（按路径前缀过滤）
node scripts/test-all.mjs integration       # 只跑跨层集成测试
```

| 包 | 用例数 |
| --- | --- |
| core | 112 |
| daemon | 69（含 5 条 runtime 全链路集成） |
| channel-mtop | 53 |
| channel-cdp | 49 |
| channel-guanjia | 62 |
| plugin-ops | 32 |
| integration | 2 |

- 不用 `node --test`、不用 vitest：沙箱禁止 spawn，脚本在单进程里顺序 import 测试文件再由 `node:test` 汇总。
- `scripts/typecheck.mjs` 在本沙箱会因 `spawnSync node.exe EPERM` 报错（不是类型错误）。**直跑 tsc**：

```sh
node 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/typescript/bin/tsc' \
  --noEmit --pretty false -p packages/daemon/tsconfig.json \
  --typeRoots 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/@types'
```

把 `packages/daemon` 换成 core / channel-mtop / channel-cdp / channel-guanjia 即可逐包检查；plugin-ops 与 ops-bundle 是纯 JS，不参与类型检查。

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

## 装进真实 DSH profile（手工）

在 `~/.dsh/profiles/<your-profile>/` 下：

1. `package.json` 的 `dependencies` 加 `"@bigfish/ops-bundle": "link:D:/Github/big fish/packages/ops-bundle"`；
2. `dependencies` 里同时要有 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`（版本 `0.1.5-rc.2`）；
3. `dsh.profile.bundles` 里按顺序写 `@deepseek-ai/dsh-base`、`@bigfish/ops-bundle`、`@deepseek-ai/dsh-web-app`；
4. `dsh plugin --profile <your-profile> pnpm install`（或复用 `scripts/dsh-dump.mjs` 的 junction 手法）。

## 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_MODULE_NOT_FOUND` 指向 `./index.ts` | `package.json` 的 main/exports 写成了 `.ts` | 插件包必须指向 `./index.js` |
| Cordis 报 `cannot get property "tools" without inject` | 插件没声明注入 | `export const inject = ['tools']` |
| 插件工具没出现 | bundle 层没装配 / patch 行 id 冲突 | 跑 `node scripts/dsh-dump.mjs`，看 `--dump-config` 里有没有 `bigfish-ops` 行 |
| daemon 起不来，退出码 1 | 端口占用 / 非回环 host / 数据目录不可写 | 看 stderr 的第一行；`--print-config` 核对路径 |
| 插件返回 `[UNAUTHORIZED]` | token 文件缺失或路径不一致 | 核对 `--token-path` 与插件 `tokenPath` 配置 |
| 任务一直 `failed` 且错误含 `UNSUPPORTED` | 该操作还没接通道（publish/deliver/reply） | 预期行为，见 architecture §6/§11 |
| 任务 `failed` 且错误含 `登录态`/`AUTH_EXPIRED` | 没往凭据库写过该账号，或凭据过期 | 先用 `credentials.save()` 导入（P1.2 会有二维码入口） |
| `ExperimentalWarning: SQLite` | `node:sqlite` 是实验 API | 正常，忽略 |
| `bundle <url> loaded without registering "<id>"` | `client.js` 里 `__ModuleLoader__.load({id})` 与包名不一致 | id 必须等于 loader entry 包名 |
| `layout.selectPanel: main panel "bigfish" is not registered` | 只注册了 `sidebar.panellist` 没注册 `main` | 两个插槽成对注册（见 client-plugin-sidebar.md） |
| 点栏位没反应 | 用 textContent 匹配命中了外层 `<nav>` | 精确点 `button[aria-label="BigFish 闲鱼运营"]` |

## 本机环境的坑

- `ops_bash` 里的 curl/wget 对外网返回 000；需要联网时用 `run_code` 内的 Node `fetch`（见 AGENTS.md）。
- 沙箱禁止 spawn 子进程，所以测试脚本、daemon 启动都在单进程内完成；`scripts/dsh-dump.mjs` 是唯一例外（它会 spawn DSH CLI，在本机 danger-full-access 下可用）。
- 临时文件统一放 `.scratch/`（已 gitignore）。
