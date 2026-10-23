# Client 插件与侧边栏栏位（P0.5）

本文件记录「在 DSH Web GUI 侧边栏注册 big fish 栏位」的完整机制、调试方法与实测坑。
代码只有一处：`packages/plugin-ops/client.js`（手写 loader bundle、519 行、零依赖、无构建；四模块面板都在这一个 bundle 里，
行数上限放宽到 700，本轮任务口径收紧到 520）。面板里的 daemon 状态是**真实数据**：走
`ctx.connection.rpc.call('/bigfish', endpoint)` 每 3 秒轮询只读端点（见 §1.1）。

## 1. 机制（源码核实，DSH 0.1.5-rc.2）

宿主 `packages/client/modules/src/index.ts` 扫描**已激活的 loader entry**：entry 的包名必须等于
loader 登记的 `options.name`、fiber 存在且未 disabled；然后读该包 `package.json` 的
`dsh.client` 与 `exports["./client"]`，把 bundle 文件按包名的单资源 / combo 路由下发。
缺 bundle 会抛 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。

所以一个包要"有前端"，需要三件事：

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js", "./cordis.patch.yml": "./cordis.patch.yml" },
  "dsh": { "client": { "platform": "web", "inject": [] } }
}
```

### bundle 格式（唯一被执行的形态）

```js
window.__ModuleLoader__.load({
  id: '@bigfish/plugin-ops',          // 必须等于 loader entry 的包名
  factory: (require) => {             // materialization 时执行一次
    const react = require('react')
    // ...
    return { apply, inject: ['slots', 'connection'] }
  },
})
```

- **id 不匹配**会报 `bundle <url> loaded without registering "<id>"`。
- 可 `require` 的平台静态模块**只有 9 个**（`packages/client/web/src/seed.ts` 的 `getStaticModules()`）：
  `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
  其它一律 require 不到——想用 UI 组件库就得落进这 9 个模块。

### 注册侧边栏栏位 + 主区域

两个插槽必须成对注册，否则点栏位会抛 `layout.selectPanel: main panel "<id>" is not registered`：

| 插槽 | 声明位置 | 注册 metadata |
| --- | --- | --- |
| `sidebar.panellist` | `packages/client/ui-sidebar/src/client/contract/slots.ts:32` | `{ name, id, order, label }`，label 同时是可见文本 / 无障碍名 / 折叠 tooltip |
| `main` | `packages/client/ui-layout/src/client/index.ts:66`（keyed） | `{ name: 'main', key: <id> }` |

用 `ctx.slots.inject(name, () => ctx.slots.register(...))` 包住注册：等插槽声明就绪再注册，
直接 register 早于声明会在加载期抛错。插槽由 ui-sidebar / ui-layout 声明，所以插件
`inject` 要包含 `'slots'`。

### 模块 tab 放在**面板内**，不注册会话顶部 tab（2026-10-21 纠正）

最初把两个模块注册成会话 header 的 tab（slot `conversation.view`）。用户 2026-10-21 明确纠正：
**主页面要在侧边栏那个面板里**，顶部 tab 不是我们的位置。现在改为面板内 tab：

| 事实 | 取值 |
| --- | --- |
| 模块清单 | `client.js` 的 `PANEL_TABS`：`publish-batch`（自动发布，默认）/ `account`（账号）/ `copy`（文案）/ `reference`（采集）/ `overview`（概览）/ `diagnose`（诊断） |
| 分发 | `PanelBody({ tab, copyProps, connection })` 按 `tab` 返回对应模块组件；模块组件只返回 section 列表，**不自带页头**（页头 + tab 栏在 `BigFishPanel` 骨架里） |
| 注册项 | **只有** `sidebar.panellist`（id `bigfish`、order 30、label `BigFish 闲鱼运营`）与 `main`（key `bigfish`）。单测断言 `registered.length === 2` 且**没有** `conversation.view` |
| 加模块 | `PANEL_TABS` 追加一项 + `PanelBody` 补一行分支 |
| 「账号」分区（第 2 个 tab，2026-10-23） | 动态账号表（`data-role='account-table'`）：账号 / 登录状态徽标 / 最近检测 / 凭据更新 / 字段数 / 操作。进 tab 自动跑 `accounts.verify`（模块级 `verifyCache` 60s 内不重打，手动「检测」强制刷新）；失败只落该行徽标（`在线` / `已过期` / `无法确认 · 网络异常|风控拦截|被限流` / `检测中` / `未检测`），不降级整页。「重新导入」「扫码登录」是写类：点两次才发（第一次只把按钮改成「确认导入」/「确认扫码」并显示一行提示，第二次才带 `confirm:true`）。空列表显示「还没有导入账号」+ 两个入口 |
| 「采集」分区（第 4 个 tab） | 只读统计入口：填 `itemIds` / `sellerId` 生成 `xy_reference_collect` 参数 JSON，展示价格带 / 标题长度 / 类目分布 / 高频卖点词 / 图片数 / 商家量级字段说明 + 三条红线（不下载他人图片、不照抄文案、不跨账号复制）。纯 UI：不联网、不调工具、不产出可发布草稿 |

**为什么回退（历史存档，别再踩）**：`conversation.view` 是会话 header 的 list 插槽
（声明于 `packages/client/ui-conversation/src/client/contract/slots.ts:156`，metadata `{ name, id, order, label }`，
`id` 必填、`label: string | (() => string)`），tab 条只在「非 blank 会话 + `main` 选中 `conversation` + `tabs.length > 1`」
时渲染——点侧边栏 BigFish 栏位，`main` 换成 `bigfish`，tab 条连同会话一起离开 DOM。也就是说我们的模块 tab
**天然和「面板」互斥**，用户点到侧边栏入口后反而看不见它们。所以按用户要求收回到面板内部。

### 1.1 实时状态：client → host rpc（只读轮询）

面板不再只放静态说明：「自动发布」与「诊断」两个分区顶部都渲染 `DaemonView`，数据来自

```js
ctx.connection.rpc.call('/bigfish', '<endpoint>', payload) // → { ok: true, value } | { ok: false, error }
```

| 端点 | payload | 面板用途 |
| --- | --- | --- |
| `health` | `{}` | 版本、已运行时长 |
| `status` | `{}` | 队列各状态计数（queued/leased/done/failed/needs_review） |
| `accounts` | `{}` | 账号列表（`accountId` / `updatedAt` / `savedFieldCount` / `ready`），「账号」tab 与 `DaemonView` 共用 |
| `accounts.verify` | `{ accountId }` | 登录态校验：真调一次 mtop `head`，返回 `{accountId, online, checkedAt, refreshed, code?, message?}`；`_m_h5_tk` 过期会顺手刷新并回写凭据。**只读**，不挂 `confirm`；40s 超时 |
| `accounts.import` | `{ confirm: true, accountId? }` | 「重新导入」：从本机 Chrome 读 cookie 并加密落盘。写类，`confirm:true` 必需 |
| `accounts.login` | `{ confirm: true, accountId? }` | 「扫码登录」：打开闲鱼登录页等扫码（最长 180s）。写类，`confirm:true` 必需 |
| `settings.get` | `{}` | copyStyle / defaultCategory / publishMinIntervalMs |
| `tasks.list` | `{ limit: 50 }` | 反查最新一轮批次的 `batchId`（daemon 没有批次列表端点） |
| `batches.get` | `{ id: <batchId> }` | 最近批次的 total 与非零 counts；失败只丢这一行，不拖垮主状态 |
| `events.list` | `{ since, limit: 200 }` | 任务步骤事件流增量（`{items,nextSince}`），喂「工作流树」；**独立于主快照**，失败只降级工作流区 |
| `daemon.start` | `{}` | 「进程管理」区：让宿主 supervisor 拉起 daemon（`force` 跳过 30s 冷却），返回 `{status}` |
| `daemon.stop` | `{ confirm: true }` | 「进程管理」区：`POST /shutdown` → 每 250ms 探 `/health` 直到不可达，返回 `{stopped, alreadyStopped}`；写端点，缺 `confirm` 直接 VALIDATION |

- 5 个必需端点（`health`/`status`/`accounts`/`settings.get`/`tasks.list`）任一失败（`{ok:false}` / 抛异常 / 传输层 reject / 宿主没有 `connection` 服务）→ 整块降级为
  一行 `未连接后台（daemon 未启动）` + 一句可执行提示（宿主已尝试自动拉起；仍不行就手动 `pnpm daemon:start`），
  **不抛错、不 console.error**。
- **daemon 自动拉起（2026-10-22）**：宿主侧 rpc 桥在拿到 `error.code === "NETWORK"` 时调
  `supervisor.ensure()`（`packages/plugin-ops/src/daemon-supervisor.js` + `daemon-watch.js`）：只认回环 `daemonUrl`，
  用同一份 `dataDir`/`tokenPath` detached spawn 同仓 `packages/daemon/src/cli.ts`，20s 内轮询 `/health`；
  30s 冷却、并发单飞，日志 `<dataDir>/plugin.log`（拉起决策）与 `<dataDir>/daemon.log`（daemon 输出）。
  关掉：config `autoStartDaemon: false`；覆盖 node/入口：config `nodePath` / `daemonEntry`。
  面板首次轮询（3s 内）就会触发，所以「打开面板 → 自动出现在线」是预期行为；测试不触发（注入假 bridge）。
- 轮询：`POLL_MS = 3000`，`useEffect` 里 `setInterval`，cleanup 里 `alive = false` + `clearInterval`；
  依赖只有 `connection`（宿主句柄稳定，切 tab 不重复起定时器）。
- 写类端点全部走同一套 `useWrite` 两段式（第一次点只上膛改文案，第二次才带 `confirm:true`）：`accounts.import` / `accounts.login`（账号表）、
  `batch.enqueue`「校验并入队」（草稿集下方）、`tasks.retry`「重试」（任务表 failed/needs_review 行）、`settings.put`「保存设置」（设置表单）、`daemon.stop`（进程管理）。
  写成功后回读：入队/重试后重拉 `tasks.list`，保存设置后重拉 `settings.get` 回填。
- 任务表 `TasksTable` 的数据由 `PublishBatchView` 持有，按 `POLL_MS = 3000` 轮询（与 daemon 快照同一个周期）：
  daemon 侧状态是异步推进的（排队 → 执行中 → 完成/失败），只拉一次会永远停在入队瞬间。
- **面板内启停 daemon（2026-10-22）**：`DaemonView` 在线/离线两个分支都渲染「进程管理（daemon 是常驻后台监听进程）」区：
  说明 daemon 在后台常驻、worker 轮询队列执行发布/擦亮/探针、面板只是看板；`daemon-start`（在线时禁用）与 `daemon-stop`（离线时禁用）两个按钮。
  停止是**两段式**：第一次点只上膛并提示「再点一次「确认停止」才会停 daemon：在飞任务会被中断（任务保持 queued，下次启动后继续）」，
  第二次才带 `{confirm:true}` 调 `daemon.stop`；失败时把 host 侧 `error.message` 直接显示在 `data-role='daemon-manage-notice'` 行。
  host 侧实现在 `plugin-ops/src/daemon-control.js`（`startDaemon` 走 supervisor、`stopDaemon` 探测→关停→轮询），daemon 侧新增 `POST /shutdown`（`packages/daemon/src/lifecycle.ts`，202 后 `setImmediate` 触发优雅退出）。

> ⚠️ **宿主 bug 已有插件侧绕过（2026-10-22，DSH 0.1.5-rc.2）**：宿主 `connection` 插件的 `rpc` getter 用**自己的** ctx 注册路由
> （`packages/client/connection/src/rpc-host.ts:80` 的 `const owner = this.ctx`，并在 `:178-181` 执行 `owner.webServer.register(route)`），
> 而该插件 `inject` 只有 `['credentials']`——所以外部插件调 `ctx.connection.rpc.handle('/bigfish', …)` 必抛
> `cannot get property "webServer" without inject`。
> 插件现在的做法：官方通道失败时回退到自建 `webServer` 兼容路由（`packages/plugin-ops/src/host-route.js`），
> 请求/响应信封与状态码和宿主一致，鉴权走 `connection.requestRejection`（fail-closed，拿不到鉴权就不注册）；
> 宿主修好后自动优先走官方通道。隔离 dev host 已实测：带登录 cookie `POST /bigfish/health` 返回 200 与真实 daemon 数据、
> 无 cookie 返回 401，加载日志出现 `rpcChannel:"registered-webServer"` 且无 webServer 报错。
> 桌面端需重启一次 DSH 进程（旧进程里没有新插件代码）。细节与建议的宿主侧修法见
> [adr/0004-client-host-rpc.md](adr/0004-client-host-rpc.md) §已知阻塞。

### 1.2 工作流树：把「现在在干嘛」画出来（2026-10-23）

daemon 在 T1 加了 `GET /events`（`task_events` 表的增量视图），面板侧是它的唯一消费者：

- **轮询**：`useWorkflowEvents(connection)`（`client.js`）每 `POLL_MS` 调一次 `events.list { since, limit: 200 }`；
  `since` 存在闭包里（React setState 是异步的，放 state 里会重复拉同一段），成功后推进到 `nextSince`，
  本地缓冲最多 300 条（`EVENT_BUFFER_LIMIT`），长开侧边栏不会无限长。
- **聚合**：`groupEventsByTask(events)` 按 `taskId` 首次出现顺序成树，节点 `{taskId,batchId,state,steps[]}`；
  任务状态只认 `kind === 'task.state'` 的事件，步骤事件（`kind === 'task.step'`）只进 `steps[]`——
  否则步骤的 `started/done` 会把任务状态覆盖成步骤状态。
- **渲染**：`WorkflowTree` 挂在「自动发布」页 `DaemonView` 之后，只显示最近 6 个任务 × 每任务最近 6 步；
  结构锚点 `data-role='workflow-tree' / 'workflow-task'(data-task-id) / 'workflow-step'(data-step-state)`，
  失败步骤用 `S.badText`。空态/降级各有独立文案（「还没有步骤事件…」/「事件流拉取失败…」），
  **不影响**上面 daemon 实时状态块。
- **两种降级要分开说**（2026-10-23 实锤后补）：`callRead` 失败时把 `error.code` 带回 UI。
  `code === 'UNSUPPORTED'` 只可能是「宿主进程里加载的是重启前的旧插件、handler 表里没有 events.list」，
  文案直接写「重启 DSH 桌面应用后自动恢复」；其余（`NETWORK` 等）才是 daemon 离线，写「启动 daemon 后恢复」。
  现场症状就是两者混在一起：面板 daemon 状态块全部正确（5 个老端点都在旧代码里），
  只有工作流区报错，用户会以为「daemon 在线但面板坏了」，其实坏的是宿主里的插件版本。
- **为什么 3 秒轮询而不是订阅**：宿主的 connection rpc 没有推送语义（ADR 0004 决策 6），
  `ctx.jobs.start` 那套是给「异常唤醒主会话」用的，面板可见时按需拉更便宜。
- 测试：`client-bundle.test.mjs` 里 5 条（树渲染与`data-step-state`、游标推进不重拉、`UNSUPPORTED` → 重启文案、`NETWORK` → daemon 离线文案、空流提示），
  `rpc.test.mjs` 2 条（白名单字段透传、非法 `since/limit/taskId/batchId` → VALIDATION 且不触达 daemon），
  `client.test.mjs` 1 条（查询串拼接）。

### 1.3 异常唤醒：daemon 出事时把消息推到会话里（2026-10-23，host 侧）

面板只在「有人在看」时有用；发布是 daemon 异步跑的，失败时用户往往已经切走。这里用宿主公开扩展点补一条**主动通知**：

- **数据源**：同 `events.list`，但由 host 侧 `startAlertWatcher`（`src/alert-watch.js`）每 10s 拉一次，游标与去重集合都在内存里。
- **口径**：只认 `kind === 'task.state'` 且 `state` 为 `failed` / `needs_review` 的事件（`src/alerts.js` 的 `isAlertEvent`）；
  `task.step` 不推——步骤太密，推给会话等于刷屏。
- **不打扰历史**：启动时先翻页把游标定在「现在」（`primeAlertCursor`，最多 20 页），昨天的失败不会在插件加载时炸出来。
- **怎么推**：拼一条 `{role:'user', content:[{type:'text',…}], source:{kind:'plugin', form:'notice', summary}}`，
  调 `agent.followup(message)` 注入最近创建的顶层会话（`ctx.get('agents').roots()` 取最后一个）。
  插件零依赖，所以没有 import `@deepseek-ai/*`，形状照宿主 `createUserMessage` 手写。
- **不刷屏**：同一事件 id 只推一次；同轮多条合并成一条（「⚠️ 闲鱼自动发布出现 N 条异常」+ 最多 5 条明细 + 另有 N 条 + 下一步建议）；
  daemon 离线导致连续失败只记**一条** warn，恢复后自动继续。
- **不空转**：没有活着的 agent 时只注册 `agent/created` 监听、不 arm 定时器；定时器 `unref()`，不拖住 DSH 退出。
- **配置**：插件 config `enableAlerts`（默认开）；关掉就不会注册监听。
- 测试：`test/alerts.test.mjs` 12 条（判定/去重/文案/提示语/消息形状）、`test/alert-watch.test.mjs` 11 条
  （定基线/游标/合并/agent 消失后补推/连续失败只 warn 一条/stop 后不再 tick）、`config.test.mjs` 与 `apply.test.mjs` 各补配置与加载断言。
- **未做**：面板未读角标、真机 failed 场景（沙箱里 CDP 起不来，需普通终端跑一次失败发布）。

## 2. 调试（一条命令）

```sh
node scripts/dsh-dev.mjs --fresh   # 造隔离 DSH_HOME(.scratch/.dshdev)，起 web 到 127.0.0.1:47080
                                  # 注意：本沙箱禁止 junction，隔离实例只能在沙箱外起（见 §3 坑 10）
node scripts/dsh-shot.mjs          # headless Chrome 通过 CDP 打开、点栏位、断言面板、截图
                                  # （断言 6 个 tab + 自动发布页结构 + 账号表徽标落定；离线时走降级断言）
node scripts/dsh-shot.mjs --hmr    # 改 client.js → 断言不刷新页面就换文案 → 自动还原
node scripts/dsh-dev.mjs --stop    # 停实例
```

- `dsh-dev.mjs`：写 profile（bundles = base + `@bigfish/ops-bundle` + web-app）、junction 借本机
  `~/.dsh/profiles/node_modules`（dsh-base 装在那里）、detached spawn `dsh --profile bigfish-dev --no-open`、
  从日志取 `dsh web: <url>` → token 换 `dsh-auth-*` cookie（要求 303）→ 抓 `globalThis["__DSH_BOOT__"]`
  断言 `@bigfish/plugin-ops` 在 entries 里。
- `dsh-shot.mjs`：零依赖 CDP（`scripts/lib/cdp.mjs`）。先关掉首跑弹窗（「继续」= 内测声明，
  「稍后配置」= 隔离 home 缺 API Key），再点栏位、断言副标题与卡片文案、`Page.captureScreenshot`。
- 截图落 `.scratch/shots/bigfish-sidebar.png`（`--hmr` 另存 `-hmr.png`）。

## 3. 实测坑（都踩过，别再踩）

1. **点栏位必须精确匹配 `button[aria-label="BigFish 闲鱼运营"]`。** 外层 `<nav aria-label="全局面板">`
   的 `textContent` 也含这段文字，按文本匹配会先命中 NAV，`click()` 毫无反应——表现为"点了没换面板"。
   命中后还要派发 `pointerdown/mousedown/click`（React 合成事件）。
2. **单资源 bundle 路由是 404，正常。** `GET /plugins/@bigfish/plugin-ops/client.js` 与带 rev 的
   单资源路径都 404；只有 combo `GET /plugins/??@bigfish/plugin-ops/client.js&rev=<rev>` 返回 200。
   验证热更新要取 combo 路径。
3. **`chrome --headless=new --virtual-time-budget=... --screenshot` 会挂死。** 页面常驻 WebSocket/SSE，
   虚拟时间永不收敛。用常驻 headless + CDP 截屏。
4. **热更新后主区域会回落到会话欢迎页。** HMR 拆掉 fiber 重挂，侧边栏行还在，但 ui-layout 的
   activePanelId 被重置；此时再点一次栏位即显示新文案。`ctx.layout` 只有写接口
   （`selectPanel/toggleSidebar/openRightbar/closeRightbar`），**没有读 activePanelId 的 API**，
   所以插件无法在 apply 里自动恢复选择——这是已知代价，不是 bug。
5. **Windows 上脚本结束不要 `process.exit()`。** fetch 连接关闭时会崩
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c, line 76`；
   设 `process.exitCode` 让它自然退出。
6. **vm 单测里跨沙箱对象原型不同。** 用 `node:vm` 执行 bundle 后，注册进去的对象不是宿主 realm 的对象，
   `assert.deepStrictEqual` 整对象比较会失败；逐字段 `assert.equal`。函数组件要手动渲染
   （`if (typeof node.type === 'function') return toText(node.type(node.props))`）才能取文本。

7. **模块 tab 只存在于 BigFish 面板内部。** 点侧边栏栏位 → `main` 换成 `bigfish` → 看到面板页头 + 6 个模块 tab
   （自动发布默认 / 账号 / 文案 / 采集 / 概览 / 诊断）。**不要把模块注册到 `conversation.view`**：那条 tab 只在会话视图里，
   且与「点了侧边栏入口就进面板」互斥（详见上一节）。
8. **list 插槽（如 `conversation.view`）注册项必须带 `id`。** 漏了会在 `register` 时直接抛错；
   `label` 缺了只是退化成用 `id` 当文案。当前实现不再用 list 插槽，保留这条备查。
9. **本沙箱里点不到真实 GUI 的 tab（浏览器与输入注入全被拒）。** 要给面板拍"点开某模块"的实测：
   - Chromium 系（Chrome/Edge/Electron 自起）起不来：`platform_channel.cc:112] Check failed ... 拒绝访问 (0x5)`；
     Firefox nightly `-headless -screenshot` 退出码 1/255、不产 PNG；
   - 给桌面端已有窗口注入输入也不行：`SetCursorPos` → Access denied；UIA/MSAA 跨进程取控件 → `Access is denied`；
     `PostMessage` 的 `WM_MOUSEMOVE/WM_LBUTTONDOWN` 被 Chromium 忽略；
   - 可行做法（2026-10-21 实测）：把桌面端窗口置前台，用 DPI-aware 的 GDI 截图
     （`SetProcessDpiAwarenessContext(-4)` + `CopyFromScreen`）拍静态画面；想拍"切换后"的面板就借 client 热更新——
     往 `client.js` 的 `apply` 末尾临时插一段 `window.setTimeout(...)`，在 DOM 里找到
     `[aria-label="BigFish 闲鱼运营"]`（或 `[data-role="panel-tab"]` 里文案匹配的元素）派发
     `pointerdown/mousedown/click`，宿主 stat-poll ~500ms 推新 bundle、页面自动重挂（不需要浏览器、不需要输入注入），
     截完图立刻 `git checkout -- packages/plugin-ops/client.js` 还原。这段临时代码**不能进提交**
     （单测断言 bundle 里没有 `document.`）。
10. **新的 DSH_HOME 在本沙箱起不来（boot 阶段要建 fallback junction）。**
   `node scripts/dsh-dev.mjs --fresh` 报 `建 junction 失败 … EPERM`；手工造好 profile 后前台跑
   `dsh --profile bigfish-dev` 报 `EPERM: symlink … @deepseek-ai/dsh`，栈是
   `packages/boot/app-boot/lib/index.js:426 ensureSymlink ← healProfilesModuleFallbackLocked`。
   本沙箱禁止一切 symlink/junction（连 `%TEMP%` 下都 Access is denied），所以隔离实例只能在沙箱外起；
   `--dump-config` 不触发 heal，仍可用来核对装配。
## 4. 测试

`packages/plugin-ops/test/client-bundle.test.mjs`（33 条）：用 `vm.runInNewContext` 跑 client.js，
stub `window.__ModuleLoader__.load` 捕获注册、假 `react`（`useState` **按组件身份分槽**：`__enter(type)` / `__exit(prev)`
切换当前组件，父子组件不会串位；`useEffect` 只登记，由 `__flush()` 执行、`__unmount()` 跑 cleanup），
假 `setInterval/clearInterval` 时钟（可 `advance()`、可查 `size`/`period`），假 `ctx.slots` 与假 `connection.rpc`，断言：

- loader id 与包名一致（`@bigfish/plugin-ops`）；
- factory 懒执行：加载 bundle 时**不**调 `require`，apply 时才 require `react`；
- `inject` 恰好 `['slots', 'connection']`；`apply` 通过 `inject` 只注册两项：`sidebar.panellist`
  （id `bigfish` / order 30 / label `BigFish 闲鱼运营`）与 `main`（key `bigfish`），并断言**没有** `conversation.view` 注册；
- 「账号」模块（`openTab('账号')`）9 条用例：进 tab 自动 `accounts.verify` 一次 + 徽标「在线」+ 六列/三按钮齐全且不含 cookie 值；
  两账号（在线/过期）分行、`AUTH_EXPIRED` 只标该行「已过期」不整页降级；verify 失败（`NETWORK` / rpc 出错）→「无法确认 · …」；
  点「检测」强制重打且请求中按钮 disabled；导入两次确认（第一次不发请求、文案「确认导入」；第二次 `payload.confirm === true` 且带 `accountId`）；
  扫码同理（第二次先出「等待扫码…（最长 180s）」）；空列表给「还没有导入账号」且不调 verify；
  来回切 tab 60s 内不重复 verify；`updatedAt` 渲染成相对时间（`20749 天前 · 字段齐备`）；
- 图标 `🐟`、active=true 时 opacity 1、否则 0.72、size 下限 12；
- 面板内 6 个 tab（自动发布/账号/文案/采集/概览/诊断），默认选中「自动发布」，点击后内容与 `aria-selected` 同步切换；
- 「采集」模块只读：讲清统计口径与红线，不出现图片直链、不产出可发布草稿；
- 标题副标题在任意 tab 都在；
- 入口按钮 disabled，并用 title 指向对应工具；
- 文案风格区 5 个 chip、默认选中 `plain`、点击后 `aria-pressed` 转移；
- 填完商品名 + 价格后「生成文案请求」可用，产出的是 `xy_copy_plan` 参数 JSON（面板不调模型）；
- 面板内嵌风格表与 `src/copy.js` 的 `COPY_STYLES` 不漂移（id/label/summary 逐项比对）；
- 「自动发布」模块（默认 tab）：流水线四步、草稿集输入框、类目矩阵、发布命令都在；
- 草稿集逐行解析：内联 JSON 合法 / JSON 坏 / 缺 `images` / `.json` 路径 / 非法行，逐行给 `data-ok` 与提示；
- 至少 2 条合法草稿才启用「生成批量发布请求」：禁用时用 title 说明原因；产出 `xy_publish_batch` 参数
  JSON（`mode` dry-run/enqueue、`draftPaths`/`drafts`、可选 `accountId`），任何输入变化都会撤销旧 JSON；
- **rpc 在线**：假 connection 回放 6 个只读端点 + `events.list` → 面板出现 `在线 · v0.3.0 · 已运行 2 分钟`、`1 个账号 · 1 个可写`、
  队列五态计数、`batch-new · 共 4 …`、`文案风格 warm（亲切安利） · 默认类目 电子资料 · 发布间隔 180 秒`；
  并断言调用顺序 `health/status/accounts/settings.get/tasks.list/events.list/batches.get`、channel `/bigfish`、
  `tasks.list` payload `{limit:50}`、`events.list` payload `{since:0, limit:200}`、`batches.get` payload `{id:'batch-new'}`（跨 realm 按字段断）；
- **降级三条路**：error 信封（`status` 返 `{ok:false}`，且不再发 `batches.get`）、rpc 同步 throw / Promise reject、
  宿主没有 `connection` 服务 → 都只出现一行 `未连接后台（daemon 未启动）`，渲染不抛错；
- **工作流树 4 条**：事件聚合成「任务 → 步骤」并断言 `data-role` / `data-step-state`、游标按 `nextSince` 推进不重拉、
  `events.list` 缺失时只降级工作流区（daemon 状态块仍在线）、空流给「执行任务时才会写」的解释；
- **轮询生命周期**：`clock.period === 3000`、发布页三个定时器（daemon 快照 + 工作流事件流 + 任务表）；
  推进时钟时 `tasks.list` 必须再次发起（只拉一次会把任务永远停在入队瞬间）；`__unmount()` 后 `clock.size === 0`，推进时钟不再新增 rpc 调用；
- 「诊断」页同样显示实时状态，切 tab 不重复起轮询；
- bundle 里没有 `localStorage`、`document.`、`fetch(`，且确实出现 `RPC_CHANNEL = '/bigfish'` 与 `connection.rpc.call`
  （client 只能通过 ctx 拿能力，不直接摸 DOM/网络）。

## 5. 未做（P1 再评估）

- 写类端点已全部接 UI（`accounts.import` / `accounts.login` / `tasks.retry` / `batch.enqueue` / `settings.put` / `daemon.stop`，都是「点两次才发 `confirm:true`」，2026-10-23）；
  还缺的是**批次进度可视化**（`batches.get` 已能读，任务表只显示单条任务）、多账号入队（面板只认 daemon 里的唯一账号）。
- 文案风格区只到「可交互组请求」：选风格 → 填商品名/价格/成色 → 产出 `xy_copy_plan` 参数 JSON；**真正的文案生成在 agent 侧**（面板不联网、不调模型），谁执行与面板解耦。
- 没有服务端推送（SSE/WebSocket）到 client：P1 要展示队列进度时需要一条 daemon → 插件 → client 的通道。
- 没有 `settings` 卡片（daemonUrl / tokenPath 现在只能写 `cordis.patch.yml`）。
- 「账号」模块的自动检测会真调一次 mtop `head`（`accounts.verify`）：60s 缓存 + 手动刷新，但**多账号同时进 tab 会挨个串行打**；
  还没有定时保活（只在打开面板/点检测时探测），也没有「凭据更新后自动重检测」的钩子。
- 「自动发布」模块 = 实时 daemon 状态（只读轮询）+ 草稿集校验 + **「校验并入队」把内联草稿写进 daemon 队列**（两次确认）+ 任务表（`failed`/`needs_review` 可重试）+ 设置表单保存；
  真正的发布由 daemon worker 执行，面板只组参数与发起入队（执行与 UI 解耦）。
- 「采集」模块只到「生成 `xy_reference_collect` 参数 JSON」：真正采集由 agent 调工具（daemon `POST /reference`），
  面板不联网；真机只跑过单件 itemIds 路径，sellerId / 多件 / 面板点击调工具都没验证。
- `scripts/dsh-shot.mjs` 现在覆盖 6 个 tab（自动发布 / 账号 / 文案 / 采集 / 概览 / 诊断）：
  断言 tab 条与默认选中、自动发布页的 daemon 状态块与流水线、账号表徽标落定（在线/已过期/无法确认）、
  文案风格芯片切换、概览与诊断的契约文案，daemon 离线时走降级断言。2026-10-23 13:05 在 danger-full-access
  下用 headless Chrome 实跑 exit 0（截图 `.scratch/shots/bigfish-sidebar{,-account}.png`）。
## 6. 热调试：在真实 DSH 里看到自己改的效果

两条路，按需选。

### A. 隔离 dev 实例（推荐日常改 UI 用，不碰你正在用的 DSH）

```bash
npm run dsh:dev -- --fresh          # 造 .scratch/.dshdev 隔离 DSH_HOME 并启动，默认 47080
npm run dsh:shot -- --hmr           # 可选：headless 自检 + 热更新断言 + 截图
npm run dsh:dev -- --stop           # 停
```

启动会打印带 token 的 URL（`http://127.0.0.1:47080/?token=…`），用浏览器打开即可。这个实例
只装 `dsh-base + @bigfish/ops-bundle + dsh-web-app`，与你的日常 profile 完全隔离，改坏了不影响你。
改 `packages/plugin-ops/client.js` 保存 → 页面**不刷新**即换新版（`dsh-client-hmr` stat-poll）。

### B. 装进你自己的 DSH profile（日常使用，重启一次）

```bash
npm run dsh:install                      # 默认 profile: desktop（~/.dsh/profiles/desktop）
npm run dsh:install -- --dry-run         # 只看改动
npm run dsh:install -- --uninstall       # 撤销
```

脚本做的事（`scripts/dsh-install.mjs`，幂等）：

1. profile `package.json` 的 `dependencies` 加 `"@bigfish/ops-bundle": "link:<repo>/packages/ops-bundle"`；
2. 把 `@bigfish/ops-bundle` 插进 `dsh.profile.bundles`（`dsh-base` 之后、`dsh-web-app` 之前）；
3. 在 profile 的 `node_modules/@bigfish/` 下建两个 junction 指向本仓 `packages/{ops-bundle,plugin-ops}`；
4. 改动前备份成 `package.json.bak-bigfish-<ts>`。

**装完必须完全退出并重开 DSH 桌面应用一次**（bundle 列表只在启动时读取）。之后侧边栏出现
「BigFish 闲鱼运营」（🐟），并且**继续改 `client.js` 同样热替换、不用再重启**。

为什么不用 `dsh plugin --profile desktop add`：它转发 pnpm，而 `ops-bundle` 依赖
`@bigfish/plugin-ops: workspace:*`，profile 侧解析不了 workspace 协议（离线也无 registry）。
junction + 手写 bundle 行是等价结果，且可控可回滚。

注意：`desktop` profile 由 Electron 独占管理，`dsh --profile desktop --dump-config` 会直接拒绝
（`profile "desktop" is managed exclusively by the Electron application`），所以装完无法用 CLI 预检，
只能靠重启后的界面确认；dev 实例（A）承担 CI 式验证。

