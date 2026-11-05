# 自己用这个项目的「不舒服点」TODO

> 口径：2026-10-27 我在本机把仓库当产品用了两天量级的一次（读代码 + 起隔离 daemon + 打 HTTP + 跑测试 + 读面板源码），
> 只记**我自己当用户会卡住/会骂的地方**。每条带证据（文件:行或实测输出）。
> 证据强度分三种标注：**[实测]** 我亲自跑出来过；**[读码]** 从源码确定，未跑；**[推断]** 需要真机确认。
>
> 未跑的东西（真机发布、扫码登录、`BF_IM=1` 收消息、桌面端面板真实渲染）不在本文的结论范围内。

## 修复进度（2026-10-28）

下面这些条目已经改完了，**保留原始证据**（它是「为什么当初这么改」的依据），逐条状态见表格；
没列出的条目仍在待办里。测试基线：`node scripts/test-all.mjs` → 1283 pass / 0 fail。

| 条目 | 状态 | 改了什么 |
| --- | --- | --- |
| P0-1 测试假绿 | ✅ | 三例注入 `ensureBrowser: noBrowser`；`scripts/test-all.mjs` 设 `BF_TEST_ALL=1`，`ensureLoginBrowser` 在测试里 fail-fast 抛 INTERNAL（不再真起 Chrome 等 30s）；补一条回归测试 |
| P0-2 状态根分裂 | ✅ | `scripts/daemon-service.mjs` 的 `resolveServicePaths` 补传 `env: process.env`；supervisor 侧日志改到 `<状态根>/logs/daemon.log`，与 CLI 同一份 |
| P0-3 supervisor 不写 pid | ✅ | `packages/plugin-ops/src/daemon-supervisor.js` 拉起成功后写 `run/daemon.pid`（health 自报 pid 优先于子进程 pid）；`evaluateServiceState` 改为「/health 有应答就算有实例」，pid 死但端口活报 `unmanaged`；`cmdStop` 在 pid 已死时按端口上的实例处理并清理残留 pid |
| P0-4 单件发布面板无入口 | ✅ | 由 panel-fixer 完成（发布 tab 单件草稿 + 校验并入队） |
| `xy_task_action`/`retry` 说法打架 | ✅ | `batch-format.js` 改成「failed/needs_review 用 retry，leased 卡死用 action release」 |
| 门禁不一致（probe 要两次确认） | ✅ | `rpc-schema.js` 加 `needsConfirm(endpoint, payload)`，`batch.enqueue` 按 `items[].kind` 判定；面板 `useWrite` 支持 `{confirm:false}`，探测按钮一次点击 |
| 失败只有 `❌ [CODE]` | ✅ | `tool-format.js` 加 `ERROR_NEXT_STEPS` / `nextStepFor`，`tool-kit.js` 统一追加 `→ 下一步` |
| `xy_status` 只有裸计数 | ✅ | 加 `statusVerdict()` 结论行 + `worker` 计数 + 队列合计 |
| 任务 id 被截断 | ✅ | `formatTaskLine` 输出全长 id，`taskNextStep` 直接给可粘贴的 `xy_task_retry(taskId="…")` |
| `settings` 静默吞错 | ✅ | `parseSettingsPatch(body, {strict:true})`：未知键 400 并列出可用字段；越界仍夹取，但响应信封顶层多一个 `clamped` 说明 |
| `publish --help` exit 2 | ✅ | `validateCommandFlags` 开头短路 `--help`（未知参数仍报错） |
| `chrome-profile` 三套默认 | ✅ | `core/config.ts` 加 `defaultBrowserProfileDir()`，登录/发布/托管浏览器统一 `<dataDir>/chrome-profile` |
| 日志无轮转 + 整文件读 | ✅ | 两侧都按 8MB 滚动（`MAX_LOG_BYTES` / `DAEMON_LOG_MAX_BYTES`），读侧只读文件末 64KB |
| npm/pnpm 混用 | ✅ | 代码与文档里本仓命令统一 `pnpm …`（`pnpm run dev:web` 属于宿主，未动） |
| 文档数字漂移 | ✅ | README/STATUS/architecture/dev-setup/AGENTS/component-decomposition/handoff/module-architecture 全部对齐实测（数字以命令输出为准） |
| 账号表撑出内容区 / 锁整表 / UTC 日期 | ✅ | 由 panel-fixer 完成（列宽收窄、行级锁、本地日期） |
| 面板「执行器没接线」文案不符 | ✅ | 由 panel-fixer 完成 |
| 数据目录没有一键诊断 | ✅ | 新增 `pnpm doctor`（`scripts/doctor.mjs` + `scripts/lib/doctor.mjs`，只读，25 例单测）；`db:backup` 未做 |
| 两次确认第一次像没反应 | 🔶 部分 | `03-rpc.part.js` 加了 `ARM_TIMEOUT_MS = 5000` 自动过期与行级 `busyKey`；按钮文案仍未变 |
| 面板 3 秒 6–7 个 rpc | 🔶 部分 | `readDaemon` 改成「只有 health 失败才判离线」，其余端点各自降级并列出 `missing`（`03-rpc.part.js`）；界面新增「daemon 在线，但这一轮有 N 项没拉到」提示，账号读不到不再显示成「0 个账号」。**轮询本身还没合并**（概览 6 个读端点 + 发布 tab 自己 3 秒一次 tasks.list + 账号 tab 自己 3 秒一次） |
| 概览页命令不可复制/前台阻塞 | ✅ | 由 panel-fixer 完成：`07-daemon.part.js` 的 `OVERVIEW_COMMANDS` 全部改成 `pnpm daemon:start/status/logs/import-account`（去掉前台阻塞的 `pnpm daemon`），并给每条命令加了「复制」按钮（剪贴板不可用时降级成手动复制提示） |
| 文案 tab 死胡同 | 🔶 部分 | 由 panel-fixer 加了「复制 JSON」按钮 + 只读 textarea + 手动复制降级提示；**但它仍然只产出 `xy_copy_plan` 的参数、不直接执行**（面板不调模型，这是设计边界） |
| 入队三入口互不指路 | 🔶 部分 | 三个工具的 description 都加了「用哪个工具」段：`xy_publish_draft`（单条+文件校验）/ `xy_publish_batch`（多条）/ `xy_task_enqueue`（底层，发货/擦亮/探针等非发布动作，或自己控幂等键）。**入口本身没合并**（还是三个工具） |
| 脏载荷要等 3 秒才报错 | ✅ | 载荷形状规则抽到 `packages/daemon/src/task-payload.ts`（入队期与执行期共用一份）；`POST /tasks` 在入队那一刻校验必填字段，缺字段直接 400 且**不落库**（原来 201 queued → 3 秒后 failed）；`xy_task_enqueue` 的 description 列出每种 kind 的必填字段 |
| 价格字段 `price` vs `priceCents` | 🔶 部分 | 面板 placeholder 已标注「也收 price」；协议本身仍是分 |
| 判断能否开工要连打 3–4 工具 | 🔶 部分 | `xy_status` 已有结论行；仍未合并成一个工具 |
| 无开机自启 / 崩溃重生 | ⬜ | 待 ADR |
| 采集 tab 只能采别人 | ⬜ | R2 待拍板 |


## P0 —— 会让人用不下去（先修这四条）

### P0-1 测试基线是「假绿」：同一台机器，两次全量跑结论不同

**[实测]** 同一会话内跑 4 次 `node scripts/test-all.mjs`（**代码一行没改**）：

| 次数 | 结果 | 耗时 |
| --- | --- | --- |
| 第 1 次（全量） | tests 1232 / pass **1229** / fail **3** | 112147ms |
| 第 2 次（全量） | tests 1232 / pass 1232 / fail 0 | 22804ms |
| 单独跑 `packages/daemon/test/login.test.ts` | pass 18 / fail 0 | 2223ms / 3150ms / 4276ms（波动 2 倍） |

三条红全部在 `packages/daemon/test/login.test.ts` 的 `loginAndSave`（含
`:446 「超时 → UNAUTHORIZED，且一条凭据都不写」`）：
`actual: 'NETWORK'` / `expected: 'UNAUTHORIZED'`，每条 **30056ms**（正好一个 30s 超时）。

原因（**[读码]** 确定 + **[实测]** 抓到现行）：这些用例没注入 `ensureBrowser`，落到
`packages/daemon/src/login.ts:351` 的默认实现
`deps.ensureBrowser ?? ((port) => ensureLoginBrowser(port, deps.browserProfileDir))`，
而 `packages/daemon/src/login.ts:316` 是
`userDataDir: profileDir ?? join(homedir(), '.bigfish', 'chrome-profile')`
——**单元测试会真的去起一个 Chrome**：

- 跑 `login.test.ts` 的同时轮询进程表，**抓到了 `chrome.exe`**（23:54:30）；
- `packages/channel-cdp/src/launch.ts:87` 的 `DEFAULT_LAUNCH_TIMEOUT_MS = 30_000`
  就是那三条 30056ms 的来源：Chrome 起得来 → 用例 ~0.7s 过；Chrome 起不来 → 等满 30s 再抛 `NETWORK`；
- 用的 profile 是 **`~/.bigfish/chrome-profile`**，也就是 `login.ts:89` 注释里「留着可复用已登录态」的那个
  ——**跑一次单测就会去碰用户真账号的 profile 目录**（实测 mtime 被反复刷新）；
- 本会话 4 次运行里 **2 红 2 绿**，没有任何代码变化。

**为什么痛**：a) 新人按 README 第一条命令就跑，直接 3 red；b) 绿/红取决于本机有没有真 Chrome 和端口 9222 的状态，
CI 与本地结论不可比；c) 就算全绿也要白等 90 秒在「等一个永远不会来的浏览器」上；
d) 文档写的基线数字（`README.md:35` = 1204 / `docs/STATUS.md:56` = 1232 / ~21s / `docs/dev-setup.md:22` = 27 suites 约 12s）
没有一个对得上实测。

**改法**：`loginAndSave` 三例显式注入 `ensureBrowser: async () => async () => {}`；
给「注入缺失就真起浏览器」加一道测试期互斥（`process.env.NODE_TEST_CONTEXT` 之类存在时 fail-fast）；
`verifySessionOnServer` 在无网时快速失败而不是等满 30s。基线数字统一改成「以命令输出为准」。

### P0-2 两条拉起路径各写各的状态：`pnpm daemon:status` 看的是另一个目录

**[实测]** `node scripts/daemon-service.mjs status` 打印：

```
状态文件 C:\Users\34239\.bigfish\run\daemon.pid
日志     C:\Users\34239\.bigfish\logs\daemon.log
```

而插件拉起的 daemon 日志在 `%LOCALAPPDATA%\bigfish\plugin.log` + `%LOCALAPPDATA%\bigfish\daemon.log`
（实测两个目录**同时存在**，各有各的 Chrome profile 与日志）。

根因（**[读码]** + **[实测]** 逐函数验证）：

```
node -e "import('./scripts/lib/daemon-service.mjs')..."
  resolveServicePaths({env:process.env}).pidPath → C:\Users\34239\AppData\Local\bigfish\run\daemon.pid
  resolveServicePaths({}).pidPath                → C:\Users\34239\.bigfish\run\daemon.pid   ← 实际走这条
```

`scripts/daemon-service.mjs:102` 调用 `resolveServicePaths({ stateDir })` 漏传 `env`，
`scripts/lib/daemon-service.mjs:135` 于是 `const env = input.env ?? {}`，
win32 分支 `:119-126` 拿不到 `LOCALAPPDATA` 就 `return join(home, '.bigfish')`。
`docs/dev-setup.md:86` 与脚本自带 usage 都承诺「默认 `%LOCALAPPDATA%\bigfish`」。
现有测试测不到：`scripts/lib/daemon-service.test.mjs:114` 显式传了 `env`。

**为什么痛**：面板把 daemon 拉起来了，你去 `pnpm daemon:logs` 看日志，看到的是**另一份文件**，
而且是空的或者上个月的——排障直接走进死胡同。

### P0-3 supervisor 不写 pid 文件 → `daemon:status` 与 `daemon:stop` 都对活着的 daemon 说「没在跑」

**[读码]** `packages/plugin-ops/src/daemon-supervisor.js` 全文没有写 pid 文件的代码（`grep pid`
只命中 `:261` 一句日志文案），而 `scripts/daemon-service.mjs:192-199` 启动后会 `writePidRecord`。

**[读码]** 判定顺序也有问题：`scripts/lib/daemon-service.mjs:219-235` 的 `evaluateServiceState`
先看 pid 记录，`processAlive === false` 就判 `stale-pid`，**不看 `/health`**；
`:229` 的 `unmanaged` 分支（健康响应在、pid 文件不在）才会报真实 pid 并 exit 0——顺序刚好写反，
「pid 残留 + daemon 活着」这个最常见组合永远落进最坏的分支。
stop 侧 `scripts/daemon-service.mjs:231-235` 对 stale pid 直接
`console.log('· 进程 ... 已不存在，清理残留 pid 文件'); return 0`。

**[实测] 端到端复现**（隔离目录，daemon 真的活着）：

```
$ curl 127.0.0.1:47992/health
{"ok":true,"data":{"version":"0.0.0","uptimeMs":4888,"pid":8500}}

$ node scripts/daemon-service.mjs status --state-dir .scratch/stale-e2e     # exit 1
✖ daemon 未在运行：pid 文件指向的进程 999999 已不存在
  注意：端口 47992 上仍有 /health 响应（pid 8500），可能是另一个实例

$ node scripts/daemon-service.mjs stop --state-dir .scratch/stale-e2e       # exit 0
· 进程 999999 已不存在，清理残留 pid 文件

$ curl 127.0.0.1:47992/health                                                # 还活着
{"ok":true,"data":{"version":"0.0.0","uptimeMs":5502,"pid":8500}}
```

**为什么痛**：用户的常态就是「面板拉起 + pid 是残留的/是别人的」。`stop` 返回 0 让人以为停了，
daemon 继续抢队列继续发；`status` 说没跑，用户不敢重启（怕重复发布）——这是最伤信任的一类 bug。
（对照：`start` 反而安全——`scripts/daemon-service.mjs:150-163` 先探 `/health`，拿到 pid 就接管登记。
所以症状是「stop 停不掉 / status 说没跑 / start 说已接管」，三句话互相矛盾。）

**改法**：supervisor 拉起成功后调用同一套 `writePidRecord`（这样 pid 残留就不再是常态）；
`stale-pid` 分支先看 health，有响应就按 `unmanaged` 报真实 pid；stop 在「pid 已死但端口有 health」时
必须先确认归属再决定动不动作，而不是 `return 0`。
`docs/dev-setup.md:177` 的故障表把 `--token-path` 换成 `BF_TOKEN_PATH`（面板拉起的 daemon 没有这个命令行参数）。

### P0-4 唯一真机验证过的路径（单件发布）在面板里没有入口

**[读码]** `packages/plugin-ops/src/client-bundle/09-publish.part.js:65`
`const ready = valid.length >= 2 && invalid.length === 0`，`:66` 文案「先粘贴至少 2 条合法草稿」。
而工具层 `packages/plugin-ops/src/batch.js:147-159` 只要求「至少一个非空数组」。

**为什么痛**：按 `docs/STATUS.md:245` 的自述，**真机真提交成功过 4 次、全是单件**，批量只跑过 dry-run。
也就是说：验证得最充分的路径，恰恰是 UI 不给走的路径。用户第一次上手只能被迫走没验证过的批量。

## P1 —— 每天都硌手

### 文案 tab 是死胡同：17 个参数摊成 JSON，不执行也不可复制
**[读码]** `08-panel.part.js:47` `onSubmit: () => setCopyForm(previous => ({ ...previous, submitted: true }))`（只置位，不调 rpc）；
`04-ui.part.js:62-67` 的注释写「便于复制或直接在对话里让模型执行」，但组件只有 `h('pre', ... JSON.stringify(request, null, 2))`；
全仓 `grep clipboard|execCommand` **零命中**。
→ 点完只是出现一大块 JSON，用户得手选长文本再粘进对话框。**改法**：复制按钮 + 只读 textarea，或直接「一键把参数交给 agent」。

### 入队三个入口互不指路，而且脏载荷要等 3 秒才报错
**[实测]** `POST /tasks`（隔离 daemon）带 `{"kind":"publish","dedupeKey":"probe-empty-1","payload":{}}`
→ **201 `state: "queued"`**；3 秒后同一条变成 `state: "failed"`，
`lastError: "任务载荷缺少非空字符串字段 accountId"`。
**[读码]** `packages/plugin-ops/src/tool-specs-publish.js:42` 的 `required: ['draftPath']` 里没有 accountId，
`batch.js:130-137` 才在 enqueue 模式抛「enqueue 模式必须给 accountId」。
**[读码]** `tools.js:146`（`xy_task_enqueue`）/ `tool-specs-publish.js:26`（`xy_publish_draft`）/ `:57`（`xy_publish_batch`）
三个都能入队，description 都没有「什么时候用哪个」。
→ **改法**：入队前同步校验必填载荷（201 之后再失败等于骗人）；三个工具的 description 各加一段「用这个 vs 用那个」。

### 面板每 3 秒打 6–7 个 rpc，一个端点失败整页变「未连接后台」
**[读码]** `03-rpc.part.js:8` `const POLL_MS = 3000`；`:99-114` 一轮打
`health / status / accounts / settings.get / tasks.list(limit:50)` + 条件 `batches.get`；
`:103` `if (!health.ok || !status.ok || !accounts.ok || !settings.ok || !tasks.ok) return null`（任一失败 → 整页 offline）；
`:141-172` 的 `useWorkflowEvents` 另起一个 3 秒 `events.list`；`11-account.part.js:96-101` 账号 tab 再一个 3 秒 pull。
→ **改法**：按当前 tab 订阅所需端点；单端点失败只把那张卡置灰，不要把整页判死。

**已修一半（2026-10-28）**：判定改成「只有 health 失败才判离线」——`health` 是 public 且最便宜的端点，
daemon 活着它就通；其余四个端点各自失败只记进 `missing` 数组，界面显示
「daemon 在线，但这一轮有 N 项没拉到：status、accounts…」，并把读不到的那几项显式写成
「这轮没读到（不是 0 个，别照着这个以为没账号）」「这轮没读到队列计数」——
**不再拿默认值冒充真值**（以前 accounts 读不到会显示「0 个账号」，用户以为没账号就去重新导入）。
回归测试：`packages/plugin-ops/test/client-bundle.test.mjs` 的「rpc 返回 error 信封」与
「rpc 抛异常」两条用例已改成断言「status 挂 → 降级不是离线」「accounts 挂 → 不是 0 个账号」。

**还没做**：轮询本身没合并。概览 tab 3 秒打 6 个读端点 + 事件流 3 秒一次 `events.list`，
发布 tab 自己再 3 秒一次 `tasks.list`，账号 tab 自己再 3 秒一次 —— 同一个 3 秒节拍下多套定时器各打各的，
没有共享缓存。

### 两次确认的第一次「看起来像没反应」
**[读码]** `03-rpc.part.js:79` 首次点击只 `setState({ armed: key, result: { kind: 'hint', text: texts.hint } })`，
按钮文案从「重试」变「确认重试」（`09-publish.part.js:33`）、「保存设置」变「确认保存」（`07-daemon.part.js:23`）、
「探测详情」变「确认探测」（`08b-items.part.js:92`）——两字之差，而且**没有自动撤销**（全仓
`grep setTimeout|clearTimeout` 在 client-bundle 里零命中，armed 状态会一直挂着）。
→ **改法**：armed 后整按钮高对比态 + 5 秒自动撤销 + `aria-live` 提示。

### 失败只有一句 `❌ [CODE]`，没有下一步
**[读码]** `tool-kit.js:86` `` `❌ [${error.code}] ${error.message}${error.retryable ? '（可稍后重试）' : ''}` ``；
`03-rpc.part.js:36` `catch { return { ok: false, code: '', message: '' } }` → 面板侧连 ID 都没有；
`11-account.part.js:45` 空文本回落成「操作失败」。
→ **改法**：建一张 code → 「下一步做什么」的映射表，工具层与面板共用。

### 任务 id 是 36 字符 UUID，处处被截断且不可复制
**[读码]** `packages/core/src/queue.ts:106` `randomUUID()`；`tool-format.js:259` `` `${task.id.slice(0, 8)}…` ``；
`09-publish.part.js:29` `id.slice(0, 16)`。
→ 想 `xy_task_retry` 或对日志时拿不到完整 id。**改法**：单元格 `title` 放全长 + 复制按钮；工具输出补一句 `xy_task_retry(taskId="<完整>")`。

### 概览页给的命令既不能点也不能复制，而且混着 npm 与 pnpm
**[读码]** `07-daemon.part.js:8` `OVERVIEW_COMMANDS = ['npm run daemon', 'npm run daemon:import-account', 'npm run dsh:dev -- --fresh']`，
`:126` 渲染成 `<code>`；其中 `npm run daemon` 是**前台阻塞**的 `node packages/daemon/src/cli.ts`——照抄会把会话卡住。
而 `package.json` 声明 `packageManager: pnpm@11.7.0`，文档里 `pnpm daemon:start` 5 次 / `npm run daemon:start` 3 次混用。
→ **改法**：换成 `pnpm daemon:start` / `pnpm daemon:status`，并加复制按钮；全仓统一 pnpm。

### 从来没有「打开日志」这个入口
**[读码]** client-bundle 里 `grep 日志|lastError` 只命中 logo 与 login。
`07-daemon.part.js:39-44` 的进程管理卡只有「启动 / 停止」两个按钮 + 一句 notice；
而 supervisor 的三种失败文案（`daemon-supervisor.js:239/243/265`）只写进 `plugin.log`。
`daemon-supervisor.js:303` 的 `status()` 明明已经返回了 `lastError` / `logFile` / `daemonLog`，面板没取。
→ 点「启动 daemon」没起来时界面什么都不说。**改法**：把 supervisor status 的 `lastError` 渲染进 notice，并给日志路径。

### 价格字段名分裂：面板写 `price`，工具与 skill 写 `priceCents`
**[读码]** `09-publish.part.js:88` placeholder `{"title":"...","price":990,...}`；
`02-draft.part.js:120` `priceCents = Number(draft.price)`；
`draft.js:43-46` 只认 `record.priceCents` 并报「草稿的 priceCents 必须是正整数（单位：分）」；
`.agents/skills/xianyu-listing-copy/SKILL.md` 的 few-shot 用 `priceCents`。
→ 从 skill 抄出来的草稿贴进面板会缺 `price`，从面板 placeholder 抄出来的贴给工具会缺 `priceCents`。
**改法**：`parseDraftLines` 两者都认，placeholder 统一 `priceCents`。

### `settings` 写接口静默吞掉拼错的键，还静默夹紧越界值
**[实测]** `PUT /settings` body `{"publishMinIntervallMs":999999,"typoKey":"x"}` → **200**，
返回体里 `publishMinIntervalMs` 仍是默认 `180000`，**没有任何警告**；
`PUT /settings` body `{"maxBatchItems":-5}` → 200，值变成 `1`（静默夹紧）。
**[实测]** 方法不对时 `POST /settings` → HTTP **405**，但信封里 `code: "VALIDATION"`；`POST /publish` → 404 同样 `code: "VALIDATION"`。
→ 用户拼错一个字母，以为设置生效了。**改法**：未知键直接 400 并列出可接受的键名；夹紧时在响应里带 `clamped` 说明；405/404 用独立 code。

### `publish --help` 报错退出 2
**[实测]** `node packages/daemon/src/cli.ts publish --help` → **exit 2** + stderr「publish 子命令必须用 --draft 指定草稿 JSON 文件」；
`--help` 与 `import-account --help` 都正常 exit 0。
**[读码]** 根因是 `packages/daemon/src/cli-args.ts:174` 的 `validateCommandFlags` 先执行，
早于 `packages/daemon/src/cli.ts:82-85` 的 `if (options.help) { io.stdout(HELP_TEXT); return 0 }`。
→ **唯一会真写闲鱼的子命令，恰好是唯一 `--help` 会报错的**。**改法**：`--help` 在参数校验前短路。

### `chrome-profile` 有三套默认位置，本机已经长出两份
**[读码]** `packages/daemon/src/cli.ts:151` 与 `packages/daemon/src/runtime.ts:167` 用
`join(dirname(config.dbPath), 'chrome-profile')`；`packages/daemon/src/login.ts:316` 用
`join(homedir(), '.bigfish', 'chrome-profile')`（`:89` 注释也这么写）；`packages/daemon/src/managed-browser.ts:12` 注释又说是 `<dataDir>/chrome-profile`。
**[实测]** 本机 `%LOCALAPPDATA%\bigfish\chrome-profile` 与 `~/.bigfish/chrome-profile` **都在**。
另外 `publish` 显式拒绝 `--data-dir`（`cli-args.ts:163-172`），想用隔离 profile 做 dry-run 没有入口。
→ **改法**：抽 `resolveProfileDir(config)` 统一；`publish` 接受 `--data-dir` 或 `--profile-dir`。

### 日志无轮转，读日志整文件进内存
**[读码]** `packages/core/src/logger.ts:39-41` 的 `DEFAULT_SINK` 只写 stdout，`createLogger` 没有文件 sink 也没有上限；
落盘靠 `scripts/lib/daemon-runtime.mjs:219` 与 `packages/plugin-ops/src/daemon-supervisor.js:342` 的 `openSync(path, 'a')`；
读侧 `scripts/lib/daemon-runtime.mjs:279-288` 与 `scripts/daemon-service.mjs:369-373` 都是 `readFileSync` 整读再切尾
（`MAX_LOG_TAIL = 1000` 只限制打印行数，不限制读进来的字节）。
→ 过夜跑日志无限涨，`pnpm daemon:status` 自己先卡住。**改法**：按大小滚动的文件 sink；`logTail` 只读文件末 64KB。

### 判断「现在能不能开工」要连打 3–4 个工具
**[读码]** `tool-format.js:269-282` 的 `formatStatus` 只有 4 行（daemon / 队列 / 账号 / 熔断），
没有「在飞任务」「下次可发布时间」，也没有任何建议；
`tools.js:142` 的 `共 N 条` 返回的是**本轮取回的条数**不是队列总数（`limit ?? 20` 且无分页提示）。
对比之下 `tools.js:105-124` 是唯一带 3 行引导的返回。
→ **改法**：`xy_status` 加一行结论（「现在能发 / 卡在 X」）；`xy_tasks_list` 返回 total 与各 state 计数（daemon 侧 `worker.stats()` 已有）。

### 文档数字与事实漂移（作为「唯一事实源」的 STATUS 也在漂）
**[实测/读码]**
- `README.md:21` 说面板 6 tab 是「自动发布 / 账号 / 文案 / 采集 / 概览 / 诊断」，
  实际 `01-head.part.js:20-27` 的 `PANEL_TABS` 是 概览 / 账号 / 采集 / 文案 / 发布 / 商品，**没有「诊断」**；
- `README.md:21` 说 14 个 `xy_*` 工具，实际 15 个（`grep "name: 'xy_"` 数出来 15）；
- `README.md:21` 说 `channel-im`「未接 daemon」，实际 `routes-im.ts` 已接（`GET /im/status`、`POST /im/reply`）；
- 用例数：README 1204 / STATUS 1232·~21s / dev-setup 27 suites·~12s，实测 1232·69 suites·22.8s（绿）/112s（红）；
- daemon 路由：`AGENTS.md:11` 写「13 条路由」、`docs/STATUS.md:75` 写「24 条」，实际注册 **29 条**
  （`status 3 + accounts 6 + tasks 7 + items 3 + seller 4 + market 1 + settings 2 + im 2 + lifecycle 1`）。
→ **改法**：这些数字改成「跑命令看输出」，或者由测试断言写进文档。

## P2 —— 攒着一起改

- **`xy_task_action` 与 `xy_task_retry` 的说法互相打架**：`batch-format.js:56` 说「卡住或待审的任务用 `xy_task_action`」，`tools.js:206-210` 说「若任务已 failed / needs_review，请用 `xy_task_retry`」，而 `packages/core/src/queue.ts:188-199` 的 `requeueTask` 只收 failed/needs_review。→ 统一成「failed/needs_review 用 retry；leased 卡死用 action release」。
- **门禁不一致**：只读的 `probe` 要走两次确认（`08b-items.part.js:90` 标题写「（只读）」但 `:42` 走 `batch.enqueue`，`batch.enqueue` 在 `rpc-schema.js:59-67` 的 `WRITE_ENDPOINTS` 里），反向的 `daemon.start`（`rpc.js:96`）完全免确认。→ 确认下沉到 kind 级；`daemon.start` 也进 `WRITE_ENDPOINTS`。
- **面板说「执行器没接线」，daemon 里其实两个都在**：`09-publish.part.js:49`「发货 / 客服两项灰着：daemon 执行器还没接线」、`01-head.part.js:33-36` 的 `UNSUPPORTED_KINDS` 同口径；而 `packages/daemon/src/executors.ts:156-181` 的 `{ probe, polish, publish, deliver, reply }` 都在，`reply` 只是需要 `BF_IM=1`。→ 文案改成「默认关闭，`BF_IM=1` 可用」，按 daemon 实际能力置灰。
- **账号表 7 列约 916–968px，撑出 860px 内容区**：`11-account.part.js:8` `ACCOUNT_GRID = '92px minmax(88px, 1fr) 136px 112px 100px 172px 268px'` vs `10-styles.part.js:27` `content: { maxWidth: '860px' }`。**[推断]** 需要窄窗真机截图确认。→ 操作列改图标 + 溢出菜单。
- **一次写操作锁整张表**：`11-account.part.js:63` `busy = writes.state.busy || switching !== ''`，`:169-172` 四个按钮全 disabled。→ busy 降到行级。
- **擦亮幂等键用 UTC 日期**：`08b-items.part.js:14` `new Date().toISOString().slice(0, 10)`，北京时间 00:00–08:00 会算成前一天。→ 用本地日期。
- **数据目录没有一键诊断/清理/备份**：`package.json` 18 个 scripts 里没有 `doctor` / `clean` / `db:backup`。实测数据目录含 5 类状态：`account-state.json`、`bigfish.db`(+`-wal` 28872B / `-shm`)、`settings.json`、`daemon.token`、`credentials/`，外加 `daemon.log`、`plugin.log`、`chrome-profile/`。→ 加 `pnpm doctor`（打印 state-root 解析结果 + 两份日志路径与大小 + db/wal 大小 + token 存在性 + pid 状态）+ `pnpm db:backup`（`VACUUM INTO`）。
- **无开机自启 / 崩溃重生**：`docs/STATUS.md:248` 自认；`daemon-watch.js:60` 只在 rpc 拿到 NETWORK 时才 `supervisor.ensure(reason)`。→ 单独出 ADR。
- **采集 tab 只能采别人**：`seller-routes.ts:36-40` 只有 `/resolve`、`/sellers/collect`、`/sellers/:id/items`，R2「自有商品搬家」还挂在待拍板（`docs/STATUS.md` §4.3）。

## 一次性验证过的「没有问题」的清单（省得下次重复怀疑）

- `node packages/daemon/src/cli.ts --help` → exit 0，帮助完整可读；`--bogus` → exit 2 + USAGE_HINT；
  `--host 0.0.0.0 --port 47199` → exit 1「daemon 只允许绑定回环地址」；`--print-config` → exit 0，四个路径都跟着 `--data-dir` 变。
- 隔离 daemon 4 秒内起来（`--data-dir .scratch/preview-final --port 47991`），日志只有 SQLite ExperimentalWarning + 一条 `daemon 已启动`；
  数据目录只有 `bigfish.db`/`-shm`/`-wal`/`daemon.token`(64 字节)，`settings.json` 只在第一次 PUT 后出现。
- 鉴权：无 token → `UNAUTHORIZED`；`/health` 公开不校验（符合设计）。
- 空态返回干净：`/accounts`、`/tasks`、`/items` → `[]`。
- `import-account --chrome-port 9223`（端口没人听）→ exit 1「连不上 DevTools（端口 9223）：先带 --remote-debugging-port 启动 Chrome」——这条文案可操作。
- 全量 tsc：`node scripts/typecheck.mjs` 本会话 6 包全过（`✔ core/daemon/channel-* 类型检查通过`）；
  另一份只读审计在同一台机器上遇到 `spawnSync node.exe EPERM` → 报「类型检查失败」——**同一脚本两种结果**，属于 P1 的「文案把人带偏」一类，不是类型错误。
