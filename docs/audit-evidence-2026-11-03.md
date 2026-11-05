# 审计证据索引（2026-11-03）

> 配套 `docs/audit-and-todo-2026-11-03.md`。这里只放**可复现的命令 + 一手输出**，不重复结论。

## 1. 静态基线

```powershell
cd "D:\Github\big fish"
node scripts/test-all.mjs            # 1283 pass / 0 fail / 69 suites / 115 文件 / 23153ms / exit 0
node scripts/build-client.mjs --check # ✔ client.js 与 13 个片段同步（1673 行）/ exit 0
node scripts/doctor.mjs              # 「结论：1 条要修，1 条建议看一眼」/ exit 0
node scripts/dsh-dump.mjs            # ✖ exit 1：Error: spawn EPERM at scripts/dsh-dump.mjs:106:19
git status --porcelain | Measure-Object -Line   # 87
```

`doctor` 的两条：

- ✖ **两份 chrome-profile**：`%LOCALAPPDATA%\bigfish\chrome-profile`（175.7 MB）与 `%USERPROFILE%\.bigfish\chrome-profile`（330.4 MB）并存，登录态不共享。
- ! **残留 pid**：`%LOCALAPPDATA%\bigfish\run\daemon.pid` 指向已不存在的进程。

> `doctor` 输出混入 NUL 与大量空白填充，`read` 工具会判为 binary。处理：`[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8) -replace "`0",''` 折叠空白后重写为无 BOM UTF8。

## 2. daemon 起停的实测坑

| 现象 | 原文 |
| --- | --- |
| 第一次 `pnpm daemon:start` | `✖ EPERM, Permission denied: \\?\C:\Users\34239\AppData\Local\bigfish\run\daemon.pid` |
| 第二次（我在跑隔离实例） | 「发现已运行的 daemon（pid 43472），已登记 pid 文件，未重复启动」→ 但写进 pid 文件的 `dataDir` 是空 |
| `BF_DATA_DIR=""` | `daemon 无法启动：环境变量 BF_DATA_DIR 不能为空`（`packages/core/src/config.ts:52-63` `assertNonEmpty`）→ 必须 `Remove-Item Env:\BF_DATA_DIR`，不能设空串 |
| `node scripts/daemon-service.mjs status` | `✖ daemon 未在运行：pid 文件指向的进程 11720 已不存在` |

沙箱里可用的隔离启动命令：

```powershell
node packages/daemon/src/cli.ts --data-dir "D:\Github\big fish\.scratch\dogfood" --port 47001 --token-path "C:\Users\34239\AppData\Local\bigfish\daemon.token"
```

## 3. daemon 全端点探针（20 条）

脚本：`.scratch/dogfood/probe-http.mjs`（Node `fetch`，因为 `pwsh` 的 `Invoke-WebRequest` 拿 4xx 时 `$_.Exception.Response` 是 `HttpResponseMessage`，`GetResponseStream()` 不存在，改用 `$resp.Content.ReadAsStringAsync().Result` 也常因连接已 dispose 而异常）。

**健康 / 鉴权**

- `GET /health` → 200 `{version:"0.0.0",uptimeMs,pid}`（**不带 token 也可**，符合设计：探活不应要求鉴权）
- `GET /status` 无 token → **401** `{"code":"UNAUTHORIZED","message":"缺少或无效的 daemon token","retryable":false}`

**只读端点全 200**

`/status`（queue/accounts/circuits/worker 四块）、`/accounts`（1 个账号，`savedFieldCount:24, ready:true, loginsExpiresSource:"estimated"`）、`/items` `[]`、`/settings`、`/sellers` `[]`、`/sellers/:id/items`、`/tasks` `[]`、`/events?since=0&limit=2`、`/browser`、`/im/status` `{enabled:false,accounts:[]}`

**错误路径质量（普遍好：稳定 code + 中文短句 + 不回显敏感值）**

| 请求 | 响应 |
| --- | --- |
| `GET /camera` | **404 `未知路由：GET /camera`** → T5 未实现，与 STATUS 一致 |
| `/sellers/does-not-exist/items` | 400 `商家 id 必须是纯数字串：does-not-exist` |
| `/tasks?state=bogus` | 400 `state 非法：bogus` |
| `/events?since=-1` | 400 `since 必须是非负整数：-1` |
| `/events?limit=99999` | 400 `task event limit 必须在 1..1000 之间，实际为 99999` |
| `POST /resolve {link:"随便一句话"}` | 400 `没有在输入里找到链接：随便一句话` |
| `POST /market/brief {categoryId,sellerId}` | 400 `categoryId 与 sellerId 只能给一个` |
| `POST /reference {accountId}` | 400 `参考采集需要 itemIds 或 sellerId 至少一个` |
| `POST /tasks {kind:"bogus"}` | 400 `kind 非法：bogus` |
| `POST /tasks {}` | 400 `kind 非法：undefined` ← **内部值泄漏，应为「缺少 kind 字段」** |
| `POST /accounts/does-not-exist/verify` | 400 `账号不存在：does-not-exist` |

**三条不一致**

1. `POST /im/reply` 在 `BF_IM` 未开时 → **HTTP 500** + `code:"UNSUPPORTED"`「IM 通道未开启」。语义是「不支持」，500 会让人以为服务端崩了。
2. `GET /batches/b-does-not-exist` → **HTTP 404 但信封 `code:"VALIDATION"`**。
3. `PUT /settings {"keepAliveIntervalMs":5}` → 200 且返回 `keepAliveIntervalMs: 60000` + 顶层 `"clamped":{"keepAliveIntervalMs":60000}`。夹紧**有**说明（这部分已修好），但 `packages/plugin-ops/src/client.js:102` 只 `return payload.data` → **面板永远拿不到 `clamped`**。

`POST /shutdown` → 202 `{stopping:true,pid:37812}` 并真的优雅退出（exit 0）。

## 4. 15 个 `xy_*` 工具逐个真调

| 工具 | 结果 | 备注 |
| --- | --- | --- |
| `xy_ping` | ✅ 健康时 5 行（版本/地址/token/health/auth） | 失败路径**不走** `nextStepFor`（`tools.js:79-82` 自拼文案） |
| `xy_status` | ✅「现在能开工：队列是空的」+ 5 行 | 质量好 |
| `xy_accounts_list` | ✅ `共 1 个账号 … ✅ 可写 \| 24 字段 \| 更新于 1 天前` | 「✅ 可写」实际是「字段齐备」，易被误读成「现在能写闲鱼」 |
| `xy_items_list` | ✅ 空态 | 文案含内部代号「P1」（`tools.js:253,257`） |
| `xy_market_brief` | ✅ 空态给了可执行下一步 + 红线 | 但 **`tools.js:354` 的参数说明与实际行为相反**（说「两条件都要满足」，`routes-market.ts:77` 是直接拒绝） |
| `xy_copy_plan` | ✅ 45 行提示词（skill 路径 + 5 条风格约束 + 事实 JSON + 输入输出契约 + 【待补】imagePaths + 【下一步】） | 无 imagePaths 时仍正常返回、不报错，设计正确 |
| `xy_publish_draft`（dry-run） | ✅ 输出草稿/标题/价格/图片/字数/分类/运费 + 模式说明 + 校准命令 | **相对路径读不到**（见下） |
| `xy_publish_batch`（dry-run，3 条含 1 条非法） | ✅ `合计：可入队 2 / 批内重复 0 / 非法 1` | 单条非法不拖垮整批 |
| `xy_task_retry("t-does-not-exist")` | ✅ `[VALIDATION] 任务不存在` + 下一步 | 但正常路径每次弹确认（只动本地队列） |
| `xy_task_action(ack,"t-nope")` | ✅ 错误文案准确 | **真实任务会 100% 失败**（P0-2） |
| `xy_tasks_list` | ✅ 全局计数 + 空列表 | 不回 total；无 batchId/accountId 过滤 |
| `xy_reference_collect(["1095534136427"])` | ✅ **真机跑通** | 见下 |
| `xy_daemon_health` | ✅ | — |
| `xy_import_account` | 未测（写操作） | — |
| `xy_task_enqueue` | **被用户拒绝** | 门禁有效 |

### 4.1 相对路径坑（原文）

```
draftPath: ".scratch/dogfood/draft-ok.json"
→ ❌ [VALIDATION] 读不到草稿文件：.scratch/dogfood/draft-ok.json（检查路径是否存在、是否有读权限）
```

插件进程的 cwd 不是工作区，**必须传绝对路径**，而错误文案没提示这一点。

### 4.2 草稿层零合规校验（关键证据）

构造的恶意草稿：标题 40+ 字、描述含「政治 违禁 代购 走私 假货 高仿 复刻」、图片指向不存在的 `no-such-image.jpg`、`category: "根本不存在的类目"`。

```
→ dry-run 全部放行
→ 只回显「分类：根本不存在的类目（发布时会按下拉选项实际点选）」
```

`packages/plugin-ops/src/draft.js` 实际只校验 4 项：desc 非空 / priceCents 正整数 / images 非空且绝对路径 / shipping 枚举。

### 4.3 `xy_reference_collect` 真机输出（唯一打通闲鱼的链路）

```
参考分析：1 件
价格带 ¥39~¥39（中位=均值）
标题 24 字 / 图片 1 张 / 有描述 100%
类目 50023914 ×1
结构：主图 方 0 / 竖 1 / 横 0 / 混 0 / 未测 0；标题均 4 段、描述均 7 句；带标签 100%、含行动号召 100%
```

注意：`xy_reference_collect` 是**纯统计、不落库**——采完之后 `xy_market_brief` 仍然是空的。要入库得走 `POST /sellers/collect` 或 `POST /reference` + confirm。

## 5. 审批门禁实测（重要正面结论）

用户在 21:50 把宿主审批策略改成 `never`、文件策略改成 `danger-full-access`。但以下三次仍被**拒绝**：

- `xy_publish_batch(mode="enqueue")` → `Error: the user rejected tool "xy_publish_batch"`
- `xy_task_enqueue(kind="deliver")` → `Error: the user rejected tool "xy_task_enqueue"`
- `xy_publish_draft(mode="enqueue")` → 同样被拒

说明**插件侧门禁不依赖宿主 approval policy**，是自己通过 `tools/pre-execute` 返回 ask/deny（`packages/plugin-ops/src/tool-middleware.js`）。**这是好设计**：即使用户关掉全局审批，写闲鱼的入口依然被拦。

反面例子：`reply` 不在 `CONFIRM_TASK_KINDS` 里（`rpc-schema.js:61`），所以 `xy_task_enqueue{kind:"reply"}` **不会**被拦，而它真的会给买家发消息。

## 6. 代码级证据（我逐条 read 过的）

| 断言 | 文件:行 | 实际内容 |
| --- | --- | --- |
| 幂等键全表唯一、不含 accountId | `packages/core/src/store.ts:38` | `dedupe_key TEXT NOT NULL UNIQUE,` |
| 工具侧幂等键不含 accountId | `packages/plugin-ops/src/draft.js:120-133` | canonical 数组 9 项，无 accountId |
| fnv1a 只有 32 位 | `packages/plugin-ops/src/draft.js:109-117` | `(hash >>> 0).toString(16).padStart(8,'0')` |
| owner 兜底字面量 | `packages/plugin-ops/src/tools.js:209` | `const owner = args.owner ?? deps.owner ?? 'bigfish-plugin'` |
| 参数说明撒谎 | `packages/plugin-ops/src/tools.js:201` | 「租约持有者名，默认取本机主机名。」 |
| worker owner | `packages/daemon/src/runtime.ts:285` | `owner: options.owner ?? 'daemon-' + String(process.pid)` |
| 租约校验要求全等 | `packages/core/src/queue.ts:288-297` | `if (task.state !== 'leased' \|\| task.leaseOwner !== leaseOwner) fail(...)` |
| **RISK_CONTROL 被吞** | `packages/daemon/src/cdp-publish.ts:115-121` | `if (!result.ok) { throw new XianyuError({ code: 'INTERNAL', ... }) }` —— 不看 `result.code` |
| **details 被丢** | `packages/core/src/errors.ts:88-90` | `toApiError() { return { code, message, retryable } }` —— `this.details`（`:84` 存的）没带上 |
| 插件 DaemonError 无 details | `packages/plugin-ops/src/client.js:19-31,97` | 构造函数只收 `{retryable, cause}` |
| notFound 降级 | `packages/daemon/src/routes-shared.ts:58-65` | 注释「core 没有 NOT_FOUND 码」→ 但 `errors.ts:8-24` 早就有 |
| `reply` 漏门禁 | `packages/plugin-ops/src/rpc-schema.js:61` | `new Set(['publish','deliver','polish'])` |
| batch 超时倒挂 | `packages/plugin-ops/src/tool-specs-publish.js:76` | `timeoutMs: 60_000`；而 `batch.js:261-303` 串行 ≤20 × 15s |
| batch 中止逻辑 | `packages/plugin-ops/src/batch.js:294-300` | NETWORK/UNAUTHORIZED → `abortedReason`，剩余条目标 failed「未尝试」 |
| polish 不读响应 | `packages/daemon/src/operations.ts:148-156` | `async polishItem(...): Promise<void> { await callMtop(...) }` |
| reference 泄露 desc | `packages/channel-mtop/src/reference.ts:248,261` | `const desc = pickDesc(item)` → `...(desc === undefined ? {} : { desc })` |
| 价格缺失变 0 | `packages/channel-mtop/src/reference.ts:249` | `const priceCents = pickPriceCents(item) ?? 0` |
| items.list 不支持过滤 | `packages/plugin-ops/src/client.js:139` | `listItems: () => request('/items')`（daemon 侧支持 3 个 query） |
| 发布间隔死配置 | `packages/plugin-ops/src/batch.js:318-320` | 只读 `process.env.BF_PUBLISH_MIN_INTERVAL_MS` |
| msgpack 原型洞 | `packages/channel-im/src/msgpack.ts:100-101` | `record[key] = value` 直接赋值 |
| msgpack BigInt | `packages/channel-im/src/msgpack.ts:70-75,145-160` | 64 位整数 → `bigint` |

## 7. 零命中（「文档说有、代码里没有」）

```powershell
Select-String -Path packages -Pattern 'uniqueCode'     # No matches  ← AGENTS.md:20 / architecture.md:82 / p1.3-plan.md:116 都声称有
Select-String -Path packages -Pattern 'xy_circuit_reset' # 只有 tool-format.js:298,326 两处文案指向它，工具不存在
Select-String -Path packages -Pattern 'publishMinIntervalMs' # daemon/src 零命中
Select-String -Path packages -Pattern 'captureJson'     # 只有 page.ts:152 定义 + test/page.test.ts 使用，生产零调用
```

## 8. `TODO/FIXME/HACK` 复核

`Select-String 'TODO|FIXME|HACK|XXX'` 全仓 19 处命中，但绝大多数是误命中（`channel-cdp/src/dom.ts` 的 `toDomError` 相关行、`channel-mtop/src/api.ts:12`、`plugin-ops/test/category-templates.test.mjs:111`）。

**真 TODO 只有 2 处（同一处代码）：** `packages/plugin-ops/src/client-bundle/07-daemon.part.js:128` 与 `:160`，生成物 `packages/plugin-ops/client.js:1018`/`:1050` 是它的副本。

→ `docs/STATUS.md` §3「只剩 1 处」**口径成立**。

## 9. 行数超限复核

| 文件 | 工作树 | HEAD | 结论 |
| --- | --- | --- | --- |
| `packages/plugin-ops/src/tool-format.js` | 426 行 | 331 行 | 未提交改动撑破的 |
| `packages/plugin-ops/src/daemon-supervisor.js` | 504 行 | 366 行 | 同上 |

唯一行数断言只扫 client-bundle 片段（`packages/plugin-ops/test/client-parts.test.mjs:37-42`），不覆盖 `src/*.js`。

## 10. 测试真实性的边界

- `packages/plugin-ops/test/*.mjs` 全部跑在 `vm.runInNewContext` + 自造假 React（`client-bundle.test.mjs:19-94`），**不是真 DOM**。
- 真验到的：两次确认全链（`:470/:491/:591/:611/:1132/:1462/:1650/:1758`）、上膛 5s 自动撤销（`:1873`）、轮询生命周期（`:1312/:1361`）、降级语义（`:1274/:1289/:439/:1389`）、行级锁（`:1951/:1978`）、幂等键（`:1758/:2006`）。
- 弱/固化的：概览整体（`:820`）、发布流水线文案（`:988`）、采集红线（`:1111`）、tab 骨架（`:741/:785/:804`）；`:1032-1049` 只断言 `JSON.parse(pre).drafts.length === 1` → **把死胡同固化成契约**；全 2031 行 **0 处**断言 `items.list` 收到 `accountId`；`:866` 反向把「文案页只有 2 个 input」写死。
- `packages/core/test/` 纯假时钟；`packages/daemon/test/` 无真 Chrome 且有护栏（`BF_TEST_ALL=1` 时 `login.ts:315-322` 把 `launchChrome` 换成一行 INTERNAL）。
- `scripts/` 生命周期无自动化（`daemon-service.test.mjs:2-3`、`doctor.test.mjs:2` 都明确不 spawn 不连端口）→ `cmdStop` 五态分支只靠人读。
- **没有**双 owner 并发 lease 同一行、**没有**「publish 已提交但 ack 前崩溃」的重放用例。
- 没有任何**协议快照回归**（golden snapshot）：真机抓包只以「手抄进注释/手写 payload」存在，闲鱼改版后跑测试发现不了字段名变化。
- `channel-mtop` 与 `channel-guanjia` 没有 `package.test.ts`，`exports`/零依赖/无 `any` 三条无自动守护。

## 11. 本次明确未验的（不要当已验证）

- 任何写闲鱼的真机动作（发布提交、擦亮、扫码登录、发货、回复）——门禁拦下了
- 真实浏览器渲染下的面板行为（沙箱不能起 Chrome 渲染进程，AGENTS §7.11）
- 宿主内 `client.js` 的真实加载
- `pnpm accept:publish`（需普通终端）
- `scripts/dsh-dump.mjs`（spawn EPERM）
- macOS/Linux 上的路径行为（只能在 Windows 上实测）

## 12. 环境坑（下次审计直接抄）

1. `ops_bash` 本机不可用：`ENOENT ... dsh-ops/runtime/win32-x64/bash-ipc/provenance.json` → 全部改 `pwsh`。
2. `pwsh` 管道给 `Select-Object` 对中文宽字符会产大量空白填充（曾把输出撑到 14KB 被截断）→ 重定向到文件再 `Get-Content -Tail` 或 `read`。
3. `pwsh` 的 `Invoke-WebRequest` 拿 4xx 时 `$_.Exception.Response` 是 `HttpResponseMessage`，**`GetResponseStream()` 不存在**；`$resp.Content.ReadAsStringAsync().Result` 在连接 dispose 后也会异常 → 用 Node 脚本 `fetch` 最稳。
4. 临产文件写 `.scratch/`（已 gitignore）；`write` 工具写 `/tmp` 会被拒。
5. 隔离 daemon 用 `--data-dir .scratch/dogfood --port 47001`；`/shutdown` 会真的停它。
