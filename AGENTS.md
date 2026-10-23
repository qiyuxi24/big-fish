# AGENTS.md — big fish 仓库开发约定

> DSH 每轮会话自动注入本文件。这里只写**不读就会做错**的规则；设计与调研在 `docs/`，架构决策在 `docs/adr/`。
> 项目：面向个人/小商家的闲鱼店铺自动化工具（抓详情、批量发布、自动发货、AI 客服）。
> 底座：开源 DSH（MIT），**不 fork 上游**，以 bundle + Cordis 插件 + 独立 daemon 交付（ADR 0001）。

## 0. 当前阶段

> **现状、能力矩阵与下一步的唯一事实源是 [`docs/STATUS.md`](docs/STATUS.md)。** 本节只留一句话状态与硬约束；不要在这里或别处重复测试数字/能力状态（历史上同一个数字出现过 6 个版本）。

- **P0 → P1.2 全部完成并提交**（基线 `main @ 5ffda24`，2026-10-21）：core 契约 / daemon HTTP（13 条路由）+ SQLite 队列 + worker + 执行器 / mtop 读通道（详情、擦亮、商家 + 全量商品、参考采集）/ CDP cookie + 发布步骤机 / 登录态导入 + 扫码登录 + 令牌自动刷新 / 插件 14 个 `xy_*` 工具 + 侧边栏面板（6 个模块 tab）/ 2 个文案合规 skill / `channel-im` 解析层（未接线）。
- **产品结构（用户 2026-10-21 拍板，同日纠正过一次）**：**一个插件**；插件入口只在侧边栏（`sidebar.panellist` + `main`），**四个模块（发布 / 账号 / 发布前处理 / 采集参考）是侧边栏面板内部的 tab**，不占会话顶部。加模块 = `plugin-ops/client.js` 的 `PANEL_TABS` 追加一项 + `PanelBody` 补一行分支。**不要再注册 `conversation.view`**（主页面必须在侧边栏面板里）。
- **真实能力边界**：`probe`/`polish` 真通 mtop；`publish` 默认 dry-run、`--submit` / `BF_PUBLISH_SUBMIT=1` 才真提交，**真机只成功过 3 次、都是单件、都是「学习笔记」类目**（2 次 CLI 直发 + 1 次队列路径；受网页端类目支持矩阵限制，3 次均已下架）；批量入队 + 失败重放 + 账号级 pacing + 发布侧风控识别**都有代码、只有单测**；账号只有只读摘要（面板内导入/扫码未做，需 host rpc + ADR）；采集参考只到 R1 只读统计（`POST /reference` 真机跑通单件，**不下载他人图片、不照抄文案、不跨账号复制**）；`deliver`/`reply` 仍 `UNSUPPORTED`。
- **当前主线**：先把模块拆开、一个一个做——发布（单件真机已通、批量未真机）→ 账号（只读摘要已通）→ 发布前处理（文案/生图/设置页）→ 采集参考（R1 只读统计已落地，R2 自有商品搬家待拍板）。验收口径见 `docs/auto-publish.md`，状态看 `docs/STATUS.md` §4.1。P2 自动发货押后。
- **未跑通的路径不得声称成功**（批量发布、发布失败重放、风控识别、pacing 校准、账号面板内导入、预处理都没真机跑通；采集只真机跑过单件解析）。需要用户拍板的事见 `docs/STATUS.md` §4.3。

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
| `packages/daemon` | 独立 Node 进程 | `core`、`channel-mtop`（执行器调读接口）、`channel-cdp`（登录态导入 + CDP 发布） |
| `packages/plugin-ops` | Cordis 插件（**纯 ESM JS**） | 无第三方依赖；不 import `@bigfish/core`（自带最小 client 与错误映射） |
| `packages/ops-bundle` | 声明 `dsh.bundle.patch` 的包 | 只声明发布物组合，无业务逻辑 |
| `packages/channel-mtop` | TS 库（纯函数） | `core`；mtop 签名/信封/cookie 归一/ret 分类，不发请求 |
| `packages/channel-cdp` | TS 库 | `core`；CDP 连接/页面/启动/发布步骤机，传输与 spawn 可注入 |
| `packages/channel-guanjia` | TS 库 | `core`；闲管家开放平台客户端（MIT 移植），**不含 placeOrder** |
| `packages/channel-im` | TS 库 | `core`；IM 帧解析 / 消息归一化 / 会话状态机，**未接 daemon** |

- 包名统一 `@bigfish/*`。
- 语言边界：`core`/`daemon` 用 TS（Node 24 直接跑，无构建）；`plugin-ops`/`ops-bundle` 用纯 ESM JS + JSDoc（它们被宿主直接 import，见 ADR 0002）。
- **运行时零第三方依赖**。新增依赖必须先写 ADR：说明为什么 node 内置不够、体积多少、离线安装怎么办。
- **禁止跨包相对路径 import**（`../../daemon/src/...`）；跨包只走包名。
- 依赖方向单向：`core ← daemon`、`core ← plugin-ops`、`core ← channel-*`；`daemon` 与 `plugin-ops` 互不 import，channel 包之间也互不 import（P1.1 由 daemon 调 channel）。

## 3. 代码规范

- Node ≥ 24、ESM only、pnpm workspace；TS 部分是 strict + `moduleResolution: NodeNext`，无构建产物（`exports` 指向 `./src/index.ts`）。
- **禁止 `any`**；边界一律 `unknown` + 手写窄化校验函数（P0 零依赖，没有 zod，见 ADR 0002；能装依赖后再评估引入）。对外输入（工具参数、HTTP 响应、配置文件）先校验再用。
- 错误：只用 `class XianyuError extends Error`，带稳定 `code`（`VALIDATION | AUTH_EXPIRED | RISK_CONTROL | RATE_LIMITED | CIRCUIT_OPEN | NETWORK | STORAGE | UNSUPPORTED | INTERNAL | UNAUTHORIZED | UNKNOWN`）。禁止裸 `throw "字符串"`、禁止 `catch {}` 吞异常。
- **金额一律整数分（cent），时间一律整数毫秒**，禁止浮点相乘（mtop 字段本身就是分）。
- 所有 IO 必须有超时（默认 15s）并透传 `AbortSignal`；重试只对幂等请求，退避用 `min(60 * 2^(n-1), 1800)` 秒。
- 文件 ≤ 400 行、函数 ≤ 60 行。复杂分支写"为什么"，不写"做了什么"。
- **client bundle 例外（2026-10-23 起，见 ADR 0006）**：宿主每个包只下发**一个** client bundle（`exports["./client"]` 只能指向单文件），所以面板源码拆成 `packages/plugin-ops/src/client-bundle/*.part.js`（**每个仍 ≤ 400 行**），产物 `packages/plugin-ops/client.js` 由 `node scripts/build-client.mjs` 纯 concat 生成。产物是**运行时交付物，必须提交**，但**不要直接编辑**：首行有生成物标记，`test/client-parts.test.mjs` 校验「片段拼接 == 产物」。加分区 = 加一个 `NN-模块.part.js`，不要把已有片段撑爆。
- 标识符/commit 用英文，注释与用户可见文案用中文。
- 不新增依赖除非必要（禁 lodash/moment/dayjs，用原生）；新依赖需在 PR 说明体积与替代方案。
- 日志用结构化 JSON（稳定字段名），INFO 以上才落盘。

## 4. DSH 插件规则

- 只用**公开导出**与稳定扩展点：`ctx.tools.register / defineTool`、`ctx.on('tools/pre-execute')`、settings 卡片、cron → `agent.followup()`、client-module（GUI）、`ctx.jobs.start`。**禁止**引用 `@deepseek-ai/dsh-*` 的 `/src/*`、`/lib/*` 深层路径。
- 当前**不声明** `peerDependencies`（离线安装解析不了 `@deepseek-ai/*`）；插件按「运行期零依赖 + 只用宿主公开扩展点」写。将来能联网安装时，再 pin 到宿主版本（当前 `0.1.5-rc.2`）并全量回归。
- `cordis.patch.yml` 里一行是**整段替换 `config`**：覆盖时必须把该行原有 key 全部重述（上游注释明确写了这点）。
- 工具命名统一 `xy_` 前缀；**写闲鱼 / 写磁盘 / 写外部系统的工具必须挂审批门禁**（`tools/pre-execute` 返回 ask/deny），读类可自动放行。**本地队列状态流转不算写外部**：`xy_task_action` 的 ack/fail/release 不挂门禁（2026-10-21 裁决；release 只影响本地队列可达性，不触达闲鱼）。
- 长任务用 `ctx.jobs.start`，不要在工具 `execute` 里阻塞几十分钟。
- client 侧代码与 host 侧物理隔离（两个 tsconfig 聚合），client 不得 import host 包。
- **client bundle 是手写 loader 产物**：`window.__ModuleLoader__.load({ id: '<包名>', factory })`，
  导出 `{ apply, inject }`；`id` 必须等于包名，且 `package.json` 同时声明 `exports["./client"]` 与 `dsh.client.platform`。
- client 里**只能** `require` 宿主 9 个静态模块（react、react/jsx-runtime、react-dom、react-dom/client、
  @deepseek-ai/cordis、@deepseek-ai/dsh-client-store / -ui-slots / -ui-primitives / -ui-dockkit）；
  禁止直接摸 `document.` / `localStorage` / `fetch(`（client 单测会断言这三样不出现）。
- 侧边栏栏位要**成对注册** `sidebar.panellist`（id/order/label）与 `main`（key），且必须用
  `ctx.slots.inject(...)` 包住；插槽早于声明注册会在加载期抛错。细节见 `docs/client-plugin-sidebar.md`。

## 5. 测试

- 用 `node:test`，**不用 vitest / `node --test`**：沙箱禁止 spawn，`scripts/test-all.mjs` 在单进程里顺序 import 所有 `packages/**/test/**/*.test.(ts|mjs)` 与 `integration/**/*.test.mjs`，可传路径前缀过滤。
- 类型检查：`node scripts/typecheck.mjs`（探测 `BF_TSC` → 本地 → DSH checkout 的 tsc）。**本沙箱里这个脚本会因 `spawnSync node.exe EPERM` 报错**（不是类型错误），改用：
```sh
node 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/typescript/bin/tsc' --noEmit --pretty false -p packages/<pkg>/tsconfig.json --typeRoots 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/@types'
```
- **禁止在本仓与 CI 直连真实闲鱼接口。** 通道测试用脱敏 fixture 回放请求/响应。
- 限流、熔断、退避、幂等必须有单测：注入假时钟与假随机数，不 `sleep` 等真实时间。
- daemon 端到端用本地 fake mtop server（`node:http`）；跨层用 `integration/`（不依赖 spawn）。
- **真人验证账号纪律（2026-10-21 用户纠正）：本机唯一已导入的账号 `2206569289277` 是用户的大号，不是测试小号。** 默认只跑 `dry-run`；真发（`--submit` / `BF_PUBLISH_SUBMIT=1`）必须用户明确点头、一次一件、文案正常、发完 1 分钟内立即下架并留 itemId + 截图证据。不要反复发同一条商品。
- 提交前必须跑：`node scripts/test-all.mjs` + 逐包 tsc（见上）；改了插件装配再跑 `node scripts/dsh-dump.mjs`；**改了 `src/client-bundle/*.part.js` 必须再跑 `node scripts/build-client.mjs`**（只校验用 `node scripts/build-client.mjs --check`）。

## 6. Git

- Conventional Commits：`feat|fix|refactor|docs|test|chore|perf(scope): 中文摘要`。
- 一个提交一个主题；不留注释掉的代码、调试 `console.log`。
- 分支 `feat/xxx`、`fix/xxx`；`main` 始终可构建。
- **禁止提交**：凭据/cookie、`*.db`、`research/repos/`、`.scratch/`、构建产物、任何 > 2MB 文件（先问）。
- **删除第三方材料（`research/repos/`、下载缓存、逆向证据）前必须**：①先列「尚未逆向完成项」清单并写进 `docs/asset-extraction.md`；②标出还没有结论的靶点（哪条调用链/哪个端点未还原）；③等用户明确确认。**「facts 已吸收」≠「逆向完成」**——2026-10-20 曾因一句「榨干后删除」把 886MB 里的大部分（13 个开源仓库 + 雾里商业包）`rm -rf` 掉且不可恢复（只剩 A/B 两套商业包），而 A/B 的核心发货、发布调用链当时并未还原；`rm -rf` 不进回收站、无 VSS 权限即不可恢复。

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

### 7.9 安装与 tsc 只能「借」

- registry 不可达：装依赖必须 `pnpm install --offline --ignore-scripts`；给 workspace 包写 `peerDependencies` 引用 `@deepseek-ai/dsh-*` 会 `ERR_PNPM_NO_OFFLINE_META`。
- 仓库不装 devDependencies；tsc 与 `@types/node` 都在 DSH checkout（`scripts/typecheck.mjs` 会自动找）。
- 插件包 `main`/`exports` 必须指向 `./index.js`（写成 `.ts` 会 ERR_MODULE_NOT_FOUND）；插件必须 `export const inject = ['tools']`，否则 Cordis 报 `cannot get property "tools" without inject`。

### 7.11 沙箱里不能做真机发布验收（CDP 渲染进程起不来）

DSH 沙箱内 Chrome **进程**能起来（要加 `--no-sandbox --disable-crash-reporter --disable-breakpad`，否则 crashpad 的 OpenProcess 被拒 → 退出码 4294930433），但**渲染进程起不来**：page target 上 `Runtime.evaluate` 对 `about:blank` 也超时、`Storage.getCookies`/`Network.getCookies` 超时。发布步骤机依赖页面填表/选类目，所以：

- 真机发布/验收一律**交用户在普通终端跑**：`pnpm accept:publish`（= `scripts/publish-acceptance.mjs`，自起 dry-run daemon、跑完即停）。
- 沙箱内起的 daemon 对默认数据目录（`%LOCALAPPDATA%/bigfish`）是**只读**的：`POST /tasks` 会报 `STORAGE: attempt to write a readonly database`；要写就用 `--data-dir` 指到 workspace 内。
- `ops_bash` 调用结束会杀掉整棵进程树：**常驻进程（daemon / dev host）只能在同一次调用内验证**，跨调用保活要用 `pwsh` 的 `run_in_background`，但别指望它活过本会话。

### 7.12 改文件前必须先读（旧号，见 7.10）

edit/write 之前必须先用 read 读过该文件，否则报 file has not been read（本会话踩过 2 次）。大文件用 offset/limit 读目标段。

## 8. 报告口径

引用工具产物时注明来源与命令；失败要写进最终答复，不静默重试掩盖。修改本文件后告知用户「下次会话生效」。