# 开发环境与运行方式（P0）

## 前置

- Node **≥ 24**（本机用 Node 24：TS 类型擦除 + `node:sqlite` 都依赖它）
- pnpm 11.7（`packageManager` 已固定，`corepack enable` 即可）
- 类型检查借用 DSH checkout 的 tsc（见下），仓库自身不装 devDependencies

## 安装

本机 registry 不可达，**必须离线安装**：

```sh
pnpm install --offline --ignore-scripts
```

如果 `.pnpm-store` 里没有需要的包，会报 `ERR_PNPM_NO_OFFLINE_META`。P0 的运行时零第三方依赖，所以正常构建根本不需要联网；workspace 内各包用 `node_modules` 里的符号链接互相引用。

## 测试与类型检查

```sh
node scripts/test-all.mjs             # 全量：packages/**/test + integration/**
node scripts/test-all.mjs packages/core   # 只跑某个包（按路径前缀过滤）
node scripts/test-all.mjs integration     # 只跑跨层集成测试
node scripts/typecheck.mjs            # core + daemon 的 tsc --noEmit
```

- 不用 `node --test`、不用 vitest：沙箱禁止 spawn，脚本在单进程里顺序 import 测试文件再由 `node:test` 汇总。
- `scripts/typecheck.mjs` 依次探测 `BF_TSC` → 仓库 `node_modules/typescript` → DSH checkout 的 tsc；找不到就打印提示并以非 0 退出。也可以用 `BF_TSC=/path/to/tsc` 指定。

## 起 daemon

```sh
node packages/daemon/src/cli.ts --help
node packages/daemon/src/cli.ts --print-config
node packages/daemon/src/cli.ts --data-dir .scratch/daemon --port 47001
```

- 数据目录默认 `%LOCALAPPDATA%\bigfish`（win32）/ `~/.local/share/bigfish`；`--data-dir` 会重算 db / 凭据 / 熔断 / token 四个路径。
- `--port 0` 让系统分配端口（冒烟用）；默认 47001。
- 首次启动在数据目录生成 `daemon.token`（32 字节 hex，0600）。**token 不进版本库**，插件按同一路径读取。
- 只允许绑定回环地址；`--host` 给非回环值会直接以退出码 1 拒绝。
- 日志是一行一条 JSON（`{"t":...,"level":"info","name":"bigfish-daemon","msg":"daemon 已启动","url":...}`）。

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
| `ExperimentalWarning: SQLite` | `node:sqlite` 是实验 API | 正常，忽略 |

## 本机环境的坑

- `ops_bash` 里的 curl/wget 对外网返回 000；需要联网时用 `run_code` 内的 Node `fetch`（见 AGENTS.md）。
- 沙箱禁止 spawn 子进程，所以测试脚本、daemon 启动都在单进程内完成；`scripts/dsh-dump.mjs` 是唯一例外（它会 spawn DSH CLI，在本机 danger-full-access 下可用）。
- 临时文件统一放 `.scratch/`（已 gitignore）。
