# AGENTS.md — big fish 仓库开发约定

> DSH 每轮会话自动注入本文件。这里只写**不读就会做错**的规则；设计与调研在 `docs/`，架构决策在 `docs/adr/`。
> 项目：面向个人/小商家的闲鱼店铺自动化工具（抓详情、批量发布、自动发货、AI 客服）。
> 底座：开源 DSH（MIT），**不 fork 上游**，以 bundle + Cordis 插件 + 独立 daemon 交付（ADR 0001）。

## 0. 当前阶段

P0：pnpm workspace 骨架 → 最小插件加载跑通 → 空壳打包实测 → 接 daemon。**跑通加载之前不写业务代码。**

## 1. 架构不变量（违反即回退）

1. **daemon 不调 LLM。** 需要模型判断的走插件/agent；daemon 只做确定性动作（登录保活、发布队列、订单监听、发货、擦除、限流）。这是性能与成本的地基。
2. **写操作必须幂等。** 每次发布生成唯一 `uniqueCode` 落库；重试前先查库，禁止盲目重放（源码里硬编码 uniqueCode 的写法是反例）。
3. **单账号写串行。** 默认 QPS ≤ 1；写桶与媒体桶分离计量；**失败不退还预算**；熔断状态原子持久化（参考 `guard.py`/`circuit.json` 的做法）。
4. **凭据只加密落盘。** Windows 用 DPAPI、macOS 用 Keychain；日志、上报、异常栈一律脱敏：`cookie` / `_m_h5_tk` / `tfstk` / `x5sec` / `Authorization` / token **永不打印**。
5. **不复制 GPL/AGPL 代码。** XianyuAutoAgent(GPL-3.0)、xianyu-auto-reply(AGPL-3.0)、xianyu-super-butler(AGPL-3.0) 只借鉴思路；MediaCrawler 禁商用。
6. **业务红线（不是建议）**：不搬运他人商品、不刷单、不代下单、不倒卖数据。违反即拒绝实现。

## 2. 包结构

| 包 | 形态 | 允许依赖 |
| --- | --- | --- |
| `packages/core` | 纯 TS 库 | 无内部依赖；不得 import electron / playwright / dsh |
| `packages/daemon` | 独立 Node 进程 | `core` |
| `packages/plugin-ops` | Cordis 插件 | `core`、DSH 公开导出、daemon 的 HTTP client |
| `packages/ops-bundle` | 声明 `dsh.bundle.patch` 的包 | 只声明发布物组合，无业务逻辑 |

- 包名统一 `@bigfish/*`。
- **禁止跨包相对路径 import**（`../../daemon/src/...`）；跨包只走包名。
- 依赖方向单向：`core ← daemon`、`core ← plugin-ops`；`daemon` 与 `plugin-ops` 互不 import。

## 3. 代码规范

- Node ≥ 24、TypeScript strict、ESM only、`moduleResolution: NodeNext`、pnpm workspace。
- **禁止 `any`**；边界用 `unknown` + zod 校验，内部类型用 `z.infer` 派生。对外输入（工具参数、mtime 响应、配置文件）一律先校验再用。
- 错误：只用 `class XianyuError extends Error`，带稳定 `code`（`AUTH_EXPIRED | RISK_CONTROL | RATE_LIMITED | VALIDATION | NETWORK | BUS_STATE | UNKNOWN`）。禁止裸 `throw "字符串"`、禁止 `catch {}` 吞异常。
- **金额一律整数分（cent），时间一律整数毫秒**，禁止浮点相乘（mtop 字段本身就是分）。
- 所有 IO 必须有超时（默认 15s）并透传 `AbortSignal`；重试只对幂等请求，退避用 `min(60 * 2^(n-1), 1800)` 秒。
- 文件 ≤ 400 行、函数 ≤ 60 行。复杂分支写"为什么"，不写"做了什么"。
- 标识符/commit 用英文，注释与用户可见文案用中文。
- 不新增依赖除非必要（禁 lodash/moment/dayjs，用原生）；新依赖需在 PR 说明体积与替代方案。
- 日志用结构化 JSON（稳定字段名），INFO 以上才落盘。

## 4. DSH 插件规则

- 只用**公开导出**与稳定扩展点：`ctx.tools.register / defineTool`、`ctx.on('tools/pre-execute')`、settings 卡片、cron → `agent.followup()`、client-module（GUI）、`ctx.jobs.start`。**禁止**引用 `@deepseek-ai/dsh-*` 的 `/src/*`、`/lib/*` 深层路径。
- peerDependencies 精确 pin 到当前安装版本（当前 `0.1.5-rc.2`）；升级上游单独提交，并全量回归。
- `cordis.patch.yml` 里一行是**整段替换 `config`**：覆盖时必须把该行原有 key 全部重述（上游注释明确写了这点）。
- 工具命名统一 `xy_` 前缀；**写类工具必须挂审批门禁**（`tools/pre-execute` 返回 ask/deny），读类可自动放行。
- 长任务用 `ctx.jobs.start`，不要在工具 `execute` 里阻塞几十分钟。
- client 侧代码与 host 侧物理隔离（两个 tsconfig 聚合），client 不得 import host 包。

## 5. 测试

- vitest。`core` 纯函数行覆盖 ≥ 80%。
- **禁止在本仓与 CI 直连真实闲鱼接口。** 通道测试用脱敏 fixture（`tests/fixtures/*.json`）回放请求/响应。
- 限流、熔断、退避、幂等必须有单测：注入假时钟与假随机数，不 `sleep` 等真实时间。
- daemon 端到端用本地 fake mtop server（`node:http`）。
- 真人验证只用**测试小号**，不在主账号上试发布。
- 提交前跑 `pnpm typecheck && pnpm lint && pnpm test`（P0 建立后启用）。

## 6. Git

- Conventional Commits：`feat|fix|refactor|docs|test|chore|perf(scope): 中文摘要`。
- 一个提交一个主题；不留注释掉的代码、调试 `console.log`。
- 分支 `feat/xxx`、`fix/xxx`；`main` 始终可构建。
- **禁止提交**：凭据/cookie、`*.db`、`research/repos/`、`.scratch/`、构建产物、任何 > 2MB 文件（先问）。

## 7. 本机环境的坑（实测，非通用）

### 7.1 run_code 必须兜异常

```ts
const jobs = { a: tools.web_fetch({ url: u1 }), b: tools.ops_bash({ command: c }) }
const settled = await Promise.allSettled(Object.values(jobs))
settled.forEach((s, i) => {
  if (s.status === "rejected") { console.log("FAILED", Object.keys(jobs)[i], String(s.reason).slice(0, 200)); return }
  console.log(Object.keys(jobs)[i], (s.value as any)?.stdout?.text ?? JSON.stringify(s.value).slice(0, 500))
})
```

裸 `Promise.all([...tools...])` 只要一个 reject 就整程序崩溃、已完成结果全丢（历史 7 次 `CODE_RUN_FAILED` 皆此因）。单调用用 try/catch，循环里逐次 try。

### 7.2 取 GitHub 文件走 api.github.com

| 路径 | 结果 |
| --- | --- |
| `raw.githubusercontent.com/...` | `WEB_PROVIDER_ERROR`，不可用 |
| `cdn.jsdelivr.net/gh/.../*.py` | 返回 octet-stream → `WEB_UNSUPPORTED_CONTENT_TYPE`，不可用 |
| `api.github.com/repos/{o}/{r}/contents/{path}` | ✅ 首选（`Accept: application/vnd.github.raw` 得原文） |
| `ghfast.top/https://github.com/{o}/{r}/archive/...tar.gz` | ✅ 整仓下载（配 `tar -xzf`） |

### 7.3 网络出口只有 run_code 里的 Node fetch

`ops_bash` 的 `curl`/`wget` 对外网返回 000，python 直连失败；本地回环同理。要联网就在 run_code 里 `await fetch(...)`，或 `tools.web_search` / `tools.web_fetch`。

### 7.4 临时文件写 `.scratch/`

`write` 工具写 `/tmp` 会被沙箱拒绝；中间产物统一放 `D:\\Github\\big fish\\.scratch\\`（已 gitignore），交付物放 `docs/`、`research/`。

### 7.5 compress 参数

只接受 `{ content: [{ startId, endId, summary }] }`；传 `{ m00100: "..." }` 会报 "no valid ranges parsed"。

### 7.6 grep / find 必须限定范围

对 `$HOME`、`node_modules`、整个 DSH checkout 递归扫描会 60–120s 超时（已发生 2 次）。限定目录 + `--include`，结果 `| head -n`。

### 7.7 长命令设 timeoutMs

`ops_bash` 默认 120s；扫描/启动类显式给 `timeoutMs`，轮询用固定次数，不用无界 sleep。

### 7.8 Hindsight 当前离线，不要调用

全部 `ECONNREFUSED 127.0.0.1:9077`；daemon 未起，且本沙箱 Python 无外网、embedding 不可得。已在本仓库禁用（`~/.hindsight/coding-agent.json`），重启 DSH 生效。恢复条件：可达的 LLM + embeddings 端点，或 cloud token，或放开 Python 网络。

## 8. 报告口径

引用工具产物时注明来源与命令；失败要写进最终答复，不静默重试掩盖。修改本文件后告知用户「下次会话生效」。
