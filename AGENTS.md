# AGENTS.md — big fish 仓库开发约定

> DSH 每轮会话自动注入本文件。这里只写**不读就会做错**的规则；设计与调研在 `docs/`，架构决策在 `docs/adr/`。
> 项目：面向个人/小商家的闲鱼店铺自动化工具（抓详情、批量发布、自动发货、AI 客服）。
> 底座：开源 DSH（MIT），**不 fork 上游**，以 bundle + Cordis 插件 + 独立 daemon 交付（ADR 0001）。

## 0. 当前阶段

P0 **已完成**：workspace 骨架 + core 契约 + daemon HTTP/队列 + plugin-ops 7 个工具，测试/类型检查/真 DSH loader 装配三项验收全绿（见 `docs/architecture.md`、ADR 0002）。
P0.5 **已完成**：Web GUI 侧边栏栏位「BigFish 闲鱼运营」（`packages/plugin-ops/client.js`，手写 loader bundle），CDP 截图与 HMR 均已实测（见 `docs/client-plugin-sidebar.md`）。

P1.0 **已完成**：组件拆解——`channel-mtop` / `channel-cdp` / `channel-guanjia` 三个通道包（契约与实施状态见 `docs/component-decomposition.md`）。

P1.1 **已完成**：daemon 运行时装配（`runtime.ts`）+ worker 领租约执行 + 执行器能力矩阵 + `/items` 落库 + `/status` 的 accounts/circuits/worker；`probe/polish` 已接 mtop 真实通道，`publish/deliver/reply` 显式 `UNSUPPORTED`（宁可失败不留假成功）。全仓 379 tests、5 个 TS 包类型检查 0 错误，见 `docs/architecture.md`。

P1.2 **填表链路已完成并真机校准，真提交未验证**：
1. **登录态导入**：`npm run daemon:import-account` / `POST /accounts/import` / 插件 `xy_import_account` 从带 `--remote-debugging-port` 的浏览器读 goofish cookie → `CredentialStore` 加密落盘；accountId 默认取 `unb`。Cookie 读取按 `Storage.getCookies` → `Network.getAllCookies` 自动降级（Edge 155 已移除后者）。
2. **CDP 发布步骤机 + daemon 发布通道**：`packages/channel-cdp/src/publish.ts`（打开发布页 → 传图 → 富文本文案 → 计价 → 价格/包邮 → 地址 → 必填预检 → 提交校验）；`packages/daemon/src/cdp-publish.ts` 接到 daemon（先比对浏览器 `unb` 与期望账号，防发错号）。**默认 dry-run，只填表不提交**；队列任务只有 `BF_PUBLISH_SUBMIT=1` 才真提交。
3. **插件侧**：`xy_publish_draft`（默认只给命令，`mode=enqueue` 才入队）与侧边栏面板；共 9 个 `xy_*` 工具。
4. **真机校准（2026-10-21，Edge 155 + CDP 9222）**：dry-run 全绿；选择器/填写原理/限制见 `docs/architecture.md` §13。**地址搜索在 CDP 下不回显结果**，只能从「常用地址/附近地址」匹配；类目由页面 AI 识别，工具不自动选。全仓 477 tests、5 个 TS 包类型检查 0 错误。

下一步：真提交跑一次（`--submit`，测试小号，需用户同意）验证「发布成功页 → item id」链路。**在真提交验证通过前，不要让任何代码路径声称「发布成功」。**

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
- 标识符/commit 用英文，注释与用户可见文案用中文。
- 不新增依赖除非必要（禁 lodash/moment/dayjs，用原生）；新依赖需在 PR 说明体积与替代方案。
- 日志用结构化 JSON（稳定字段名），INFO 以上才落盘。

## 4. DSH 插件规则

- 只用**公开导出**与稳定扩展点：`ctx.tools.register / defineTool`、`ctx.on('tools/pre-execute')`、settings 卡片、cron → `agent.followup()`、client-module（GUI）、`ctx.jobs.start`。**禁止**引用 `@deepseek-ai/dsh-*` 的 `/src/*`、`/lib/*` 深层路径。
- 当前**不声明** `peerDependencies`（离线安装解析不了 `@deepseek-ai/*`）；插件按「运行期零依赖 + 只用宿主公开扩展点」写。将来能联网安装时，再 pin 到宿主版本（当前 `0.1.5-rc.2`）并全量回归。
- `cordis.patch.yml` 里一行是**整段替换 `config`**：覆盖时必须把该行原有 key 全部重述（上游注释明确写了这点）。
- 工具命名统一 `xy_` 前缀；**写类工具必须挂审批门禁**（`tools/pre-execute` 返回 ask/deny），读类可自动放行。
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
- 真人验证只用**测试小号**，不在主账号上试发布。
- 提交前必须跑：`node scripts/test-all.mjs` + 逐包 tsc（见上）；改了插件装配再跑 `node scripts/dsh-dump.mjs`。

## 6. Git

- Conventional Commits：`feat|fix|refactor|docs|test|chore|perf(scope): 中文摘要`。
- 一个提交一个主题；不留注释掉的代码、调试 `console.log`。
- 分支 `feat/xxx`、`fix/xxx`；`main` 始终可构建。
- **禁止提交**：凭据/cookie、`*.db`、`research/repos/`、`.scratch/`、构建产物、任何 > 2MB 文件（先问）。
- **删除第三方材料（`research/repos/`、下载缓存、逆向证据）前必须**：①先列「尚未逆向完成项」清单并写进 `docs/asset-extraction.md`；②标出还没有结论的靶点（哪条调用链/哪个端点未还原）；③等用户明确确认。**「facts 已吸收」≠「逆向完成」**——2026-10-20 曾因一句「榨干后删除」把 886MB（含 3 套商业包原文件）全部 `rm -rf`，而 A/B 的核心发货、发布调用链当时并未还原；`rm -rf` 不进回收站、无 VSS 权限即不可恢复。

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

### 7.10 改文件前必须先读

edit/write 之前必须先用 read 读过该文件，否则报 file has not been read（本会话踩过 2 次）。大文件用 offset/limit 读目标段。

## 8. 报告口径

引用工具产物时注明来源与命令；失败要写进最终答复，不静默重试掩盖。修改本文件后告知用户「下次会话生效」。