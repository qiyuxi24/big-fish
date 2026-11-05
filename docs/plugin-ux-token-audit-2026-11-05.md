# 插件可用性 / token 消耗 / 失败会话 审计报告

> 一次性审计报告（2026-11-05），**不是**能力事实源；能力状态仍以 `docs/STATUS.md` 为准。
> 数据来源：本会话只读探针 `.scratch/audit2.mjs`～`audit5.mjs`、`acp_cache`、`acp_status`、
> 在线 daemon 的 `xy_ping`/`xy_status`/`xy_accounts_list`/`xy_tasks_list`，以及 forensics 队友对
> `bili.log` / `session_projcache` / `session.v4.jsonl.zstd` 的取证。
> 复现命令：`cd 'D:\Github\big fish'; node .scratch/audit2.mjs`（其余同理），`node scripts/build-client.mjs --check` 未跑（本次不改动代码）。

## 0. 先分层：哪些是「插件」的锅，哪些不是

| 层 | 涉及项 |
| --- | --- |
| **bigfish `xy_*` 插件本身** | 能力缺口、文案三段式、参数命名不一致且静默吞错、工具返回啰嗦、描述里互相指路、开场工具 schema 税 |
| **DSH / billion-context 宿主与代理** | 81 条 skill 目录全量下发、AGENTS.md 每轮注入、`ops_bash` 路径错配、provider 侧缓存 miss / abort 循环、压缩阈值、长会话事件循环饥饿 → **失败会话死因** |

用户问的「额外消耗 tok」和「另一个会话失败」，大头都在第二层，跟 bigfish 插件代码没有因果关系。下面分开说。

---

## 一、插件不顺手之处（DX 实测）

### 1.1 能力缺口：探针列出的 10 项，现有 16 个工具一个都没有

`.scratch/audit2.mjs` 对 `buildTools()` 的真实工具名做匹配（`packages/plugin-ops/src/tools.js`），结果：

| 想要的能力 | 现状 |
| --- | --- |
| 保存草稿（不落文件） | ❌ `xy_publish_draft` 只吃 `draftPath`，草稿必须先写磁盘 |
| 拉起 daemon | ❌ 无 |
| 列出熔断并一键复位 | ❌ 只有 `xy_circuit_reset`，没有 `circuit_list`（描述让用户「用 `xy_status` 看」，但 status 只给计数） |
| 批次进度查询 | ❌ 有 `batchId` 参数，`tools.js:201` 回执还写「用 `GET /batches/:id` 或面板看进度」，**却没有对应工具**，只能自己开 HTTP 或去面板 |
| 设置读写 / 扫码登录 / 下架商品 / 图片上传 | ❌ 全无（`xy_import_account` 只是从已登录 Chrome 读 cookie） |
| AI 文案一步到位出草稿 JSON | ❌ 见 1.2 |
| 事件流 / 步骤明细 | ❌ 无 |

真实工具数 **16**（`read=10 / confirm=6`）。注：仓库里遗留的 `m2/m4/m5/measure-*.mjs` 探针把 `buildTools`（已含 publish specs）和 `publishToolSpecs` 又拼了一次，会数成 18 并让 `xy_publish_draft`/`xy_publish_batch` 重复——**那是探针自身的 bug，不是产品 bug**。

### 1.2 文案链路是「三段式」，工具不出活

`xy_copy_plan`（`packages/plugin-ops/src/tools.js:372`、`packages/plugin-ops/src/copy.js:345` `renderCopyPrompt`）明确写了「只读、不调模型、不写文件」，只吐一份**提示词**。`.scratch/audit5.mjs` 实测：一份典型输入返回 **1085 chars / 44 行 / ≈434 tok**，末行写死：

```
【下一步】写出草稿 JSON → xy_publish_draft(mode="dry-run") → 人工确认价格/图/AI 图声明 → mode="enqueue"。
```

也就是要发一件东西，得：
1. 调 `xy_copy_plan` 拿提示词；
2. agent 自己去读 `.agents/skills/xianyu-listing-copy`、手写草稿 JSON、**落盘成文件**；
3. 再调 `xy_publish_draft` 校验。

中间最重的一段全靠模型手工，工具没有任何「一步出草稿」的收口。对「就想发一件」是最大的摩擦点。

### 1.3 参数命名三套，且写错了静默假装成功

同一类「任务 id」在三个工具里三个名字：`xy_task_retry` 用 `taskId`、`xy_task_action` 用 `id`、`xy_task_enqueue` 用 `dedupeKey`。

`.scratch/audit4.mjs` 实测：给 `xy_task_retry` 传 `{id:"aced28d9"}`（正确应是 `taskId`）——**不报错**，返回 42 字：

```
已重新排队： |  |  | attempt undefined/undefined
```

根因 `packages/plugin-ops/src/tools.js:287` 直接 `encodeURIComponent(args.taskId)`，`undefined` 被拼进 URL，daemon 回了个空对象，`formatTaskLine`（`packages/plugin-ops/src/tool-format.js:261`）把空对象拼成四个空字段。参数名写错既不校验、又伪装成成功——这种静默空结果最坑：模型会以为已经重排，实际什么都没发生。

### 1.4 `ops_bash` 全废：host 的 dsh-ops 版本/路径错配（本会话实测）

两次调用 `ops_bash`（含 `echo hello; pwd`）都返回：

```
Error: ENOENT: no such file or directory, open
'C:\Users\34239\.dsh\profiles\desktop\node_modules\dsh-ops\runtime\win32-x64\bash-ipc\provenance.json'
```

查证：`runtime/win32-x64/` 目录**根本不存在**；实际存在的是
`C:\Users\34239\.dsh\profiles\desktop\node_modules\dsh-ops\native\bash-ipc`（11/2 12:06）
和 3 个 `@dsh-ops\*-win32-x64\provenance.json`（10/15）。forensics 进一步定位到
`dsh-ops\lib\bash-ipc.js:22` 硬拼了 `runtime/win32-x64/bash-ipc` 这个旧路径，而新布局是 `native/` + scoped 包
——即 host 的 `dsh-ops` 版本/路径错配。desktop profile 的 `cordis.yml` 在 **15:47:26**（本会话开始前 16 秒）被重写。本会话只能全程用 `pwsh` 兜。这是宿主层问题，不是 bigfish 代码，但用起来就是「bash 通道是坏的」。

**与失败会话的关系（forensics 取证）**：同一个 `provenance.json` ENOENT 在失败会话 `746edd77` 里出现在
`seq 32 / 2026-11-03 晚`（开场第 2 步，`time=1793713366528`），紧接着 `seq 35` 的模型推理写明
`The ops_bash failed with ENOENT. Let's try pwsh instead.`，之后全程改用 `pwsh` 继续跑了几百步；
`bili.log` 全文件对该字符串 **0 命中**。即它在失败会话里是「开一次性、已被绕开的 nuisance」，
与 15:45 的 abort cascade 无时间关联，**不是 746edd77 的死因**（死因见三）。

### 1.5 状态工具有重叠

`xy_ping`（`tools.js:70`）除了 health 还顺手 `client.status()` 并播一遍 `capabilities`（`tools.js:81`），而 `xy_status`（`tools.js:108`）→ `formatStatus`（`tool-format.js:370,385`）又播一遍。`xy_ping`/`xy_status`/`xy_accounts_list`/`xy_tasks_list` 四个读工具职责交叉，问一句「现在啥状态」往往要连着调好几个。

---

## 二、额外消耗 token 之处

`acp_cache`（本会话 `session-30097ea0…`，billion-context 0.1.212，31 次请求）是权威账单：

```
total input  1.55M tok | cached 317.4K (hit 20.5%) | output 25.5K
miss = new 66.0K + compress re-pay 0 + upstream-ttl-or-client-rewrite 1.16M
identity check OK
```

**真正「新写的内容」只有 6.6 万 tok，其余 1.16M 是稳定前缀被重新计费。**

### A. 会话开场固定税 ≈33.5K，只命中 2.3%

首请求 15:48:30 即 `input=33.5K / cached=768`。构成：

- `AGENTS.md` 11323 chars（2772 CJK / 8551 非 CJK），每轮注入；
- 16 个 `xy_*` 工具 schema：描述 2320 chars + 参数 JSON 7400 chars（≈2960 tok，56 参数），完整 definitions ≈5188 tok；其中 `xy_copy_plan` 一个就 17 参数 / 1907 chars；
- **81 条 skill 目录 ≈2600–3800 tok**：bigquery-*、gcp-*、office-*、wechat-*、ml-* 等绝大多数与「闲鱼插件审计」毫无关系，却每轮开场全量下发；
- 系统提示 + 团队/运行时上下文。

这是「跟当前任务无关、且可裁剪」的最大一块固定开销。

### B. 工具返回啰嗦：一次「看状态」≈3K tok

`.scratch/audit3.mjs`（默认参数，20 tasks / 50 items fixtures）：

| 工具 | 返回 |
| --- | --- |
| `xy_tasks_list` | 2381 chars / 30 行 |
| `xy_items_list` | 3699 chars / 50 行 |
| `xy_status` | 176 chars / 5 行 |
| `xy_ping` | 163 chars / 5 行 |
| **合计** | **6419 chars ≈ 2918 tok** |

列表工具默认不分页 / 不截断 / 不折叠；`tasks_list` 每行还挂 `taskNextStep`（`tool-format.js:274`）再补一句「→ 重放：`xy_task_retry(taskId="…")`」。这些表格下一轮又作为历史被原样重发。

### C. 描述 / 错误回执里互相指路（跨工具提及 21 处 / 325 chars）

每条错误 **284 chars**：`❌ [VALIDATION] 消息` + 细节 JSON + 「→ 参数不对：按提示改参数再发；任务卡在 leased 用 `xy_task_action` release，failed/needs_review 用 `xy_task_retry`」。工具描述、`taskNextStep`、`copy.js:375` 的「下一步」全在教模型用别的工具。出发点是好意，但都是随每次结果常驻进上下文的导航文本。

### D. 最大的一笔：provider 侧缓存 Miss 1.14M tok（占 74%）

- `▲ PROVIDER-SIDE MISS 24 samples · 1.14M tok`：**上一条请求的消息列表字节级完整保留、10 分钟内到达，却是异常 miss**（provider eviction / relay 节点轮换 / stateful upstream 回显校验）。acp_cache 给的建议见 `#2483`：若上游是 stateful relay（claude-code/magpie 类），`bili` 在 assistant 文本上的 render tags 会触发回显校验 → 设 `diagnostics.renderNone=true`（中途切换会有且仅有一次 replay）。
- `BODY STABILITY`：30/30 请求全部 `diverged`，且 **30 次都是 `tail(params/notes)` 发散，0 byte-identical**，`mid-history 0 / head 0`。→ **不是压缩/折叠造成的**，是每次请求尾部顶层参数（如 reasoning effort）被重写，provider 因此对 prompt cache 重分区（`#3803`）。
- `⏻ ABORT-CORRELATED`：**30 个 miss 落在 `client mid-stream abort` 后 30s 内**。
- hit 率在 **0.8%–3.3%**（#15 0.0%、#29 0.8%）与 **87%–99%**（#20 99.3%、#31 89.8%）之间剧烈跳。

### E. 压缩没帮上忙

`acp_status`：nudge 一直 `idle`（`max compressible 23451 < 50000`、`growth 21266 < 22500`），**压缩从未触发，`compress re-pay = 0`**。即那些啰嗦表格 / 探针输出一直以原文留在上下文，既没被折叠，又因为 provider miss 被反复重发。阈值 50000 对「33.5K 起步、每轮涨一点」的会话偏高——等不到触发，会话往往已经先被别的问题拖垮（见三，失败会话的 nudge 也是 `idle`、reason 同为 `max compressible 23252 < threshold 50000`）。

---

## 三、刚刚失败的另一个会话

### 3.1 是哪一个

`session-746edd77-8111-47bb-9e8f-08752670e2e1`，标题「插件可用性评估与改进TODO」，workspace 同为 `D:\Github\big fish`，`deepseek-v4.1-flash` / workbuddy / high reasoning / `danger-full-access`。创建 2026-10-23 19:57:13，最后写入 **2026-11-05 15:45:36**。

它其实正在做**和本次完全一样的审计**：`.scratch` 里 15:38–15:45 的 `measure-*.mjs` / `probe-*.mjs` / `m2`–`m9.mjs` / `mflow/draft.json` 都是它留下的探针（测 schema 体积、默认返回体积、错误路径、缺失能力），最后一个 `m9.mjs` 15:45:27，然后死掉，**报告从未交付**。

（其他近期会话已排除：`7df15901…` 是本次 forensics 排查会话；`session-89353bdc…` 属于 AI-tutor，真实活动停在 11-04 22:27。）

### 3.2 死亡状态

`5 turns / 705 steps / 29 answers`。第 5 轮就是用户那句「先进行一个报告给我…」，**回答是空 `""`**。

- projcache 冻结在 `seq 4332`（`{"type":"step/start","data":{"turn":5,"step":53}}`）；
- `session.v4.jsonl.zstd` 尾部：`seq 4333`（assistant reasoning + 一个创建 `.scratch/m10.mjs` 的 `ops_bash` 调用）、`seq 4334`（`tool/call`），之后**无 `tool/result`、无 `step/end`、无 final answer**；
- `.scratch/m10.mjs` 磁盘上**不存在** → 最后一次工具调用根本没执行。

### 3.3 没有异常栈

`CODE_RUN_FAILED` / `readonly database` / `FATAL` / `Uncaught` / `stack trace` / `EPERM` / `[error]` 全库 grep **零命中**。失败模式是 `C:\Users\34239\.local\state\billion-context\bili.log`（billion-context 0.1.212）里的**客户端流中止循环**。原文（15:44:41→15:45:36）：

```
[warn] slow-session: 1543 msgs / inbound=4.8MiB took local=298ms — per-turn O(messages)
       synchronous scans are starving the event loop (#4528); consider closing/restarting
       the session or enabling compression
[info] request: 1543 msgs, inbound=4.8MiB, outbound=498.4KiB, local=298ms
[info] client disconnected mid-stream after 5349ms (250556 bytes written to client)
[info] client aborted mid-stream
[info] output budget restored 128000 -> 384000 (#3438: dsh-lane mid-band collapse
       above the <=200 starve gate ...)
[info] nudge idle: ... reason="max compressible 23252 < threshold 50000"
[info] client disconnected mid-stream after 7606ms (328584 bytes written to client)  ← 终局
[info] [plugin] [acp-usage] input=135424 cached=134528 (cache hit 99%)
[info] client aborted mid-stream
```

11/5 该会话共 **51 × `client aborted mid-stream`、53 × slow-session warn**；仅两条更早的 `[debug] tcp closed reason=error(ECONNRESET)`（15:39:44 conn#76、15:42:23 conn#165），终局窗口是 `reason=peer-fin`（客户端主动关），**不是网络重置**；15:45:36 后无任何活动。

### 3.4 根因链条

会话膨胀到 **1543 消息 / 4.8 MiB / 705 steps** → proxy 每轮 `O(messages)` 同步扫描饿死事件循环（`#4528`）→ 约 15:44:41 起 host 把每条转发的 LLM 流都在中途丢弃 → 用 ~135K tok 上下文（99% cache hit）重新 `processTurn` → 再被 abort → 死循环。第 5 轮卡在 `step 53`，消息数 `95→98→101→104→107→110→113`、`input 130011→135424` 一路涨（每次 abort 重试都在尾部追加内容）。压缩没触发（nudge idle，同本会话）。

**局限**：所有产物里没有 host 侧异常/栈，无法证明 host 为何 abort 流的单一触发点；证据是 proxy 的 abort 循环 + 自身 `#4528` 饥饿警告。（失败会话自己的推理承认曾误用 `xy_task_retry` 重排过一条 failed publish，但 publish 通道未开只会 `UNSUPPORTED`，无害、非诱因。）

### 3.5 分类

**HARNESS / ACP-PROXY 基础设施**（billion-context 0.1.212 流路径 + 长会话事件循环饥饿），**不是 bigfish 插件代码 bug**，也不是沙箱 / 网络 / Hindsight 离线 / Chrome 渲染 / SQLite readonly。依据：最后执行的探针（`m9.mjs` 等）都成功；卡住的是例行 `xy_tasks_list` 测量；无插件异常；无 `AGENTS.md §7.8/§7.11` 那些经典标记。

### 3.6 和本会话的关系

两个会话踩的是**同一套机制的两个面**：

- 失败会话：长会话把 proxy 事件循环饿死 → 流被 abort → 每次重试重发全量 135K 上下文；
- 本会话：provider 侧缓存反复 miss → 1.16M 前缀重算 → 30 次 abort-correlated。

共同点都是「**稳定前缀被反复重发 / 重算**」，而压缩阈值 50000 **两边都没触发**。

---

## 四、建议（按性价比排序）

### 你马上能做的（不改代码）

1. **长会话及时开新会话 / 手动 `compress`**：别让单会话涨到几百 step、上千 msg（`#4528`）。这次两个会话的 nudge 都是 idle，等自动压缩等于等不到。
2. **上游若是 stateful relay**：按 `#2483` 设 `diagnostics.renderNone=true`，减少 render tags 触发的回显校验 miss；注意中途切换恰有一次 replay。
3. **压缩阈值 50000 偏高**：对 33.5K 起步的会话建议调低，或会话中途主动压缩一次。
4. **修 `ops_bash`**：host 的 bash-ipc 启动器路径 `dsh-ops/runtime/win32-x64/` 要对齐新布局 `native/` + `@dsh-ops/*`，否则 bash 通道只能一直用 `pwsh` 兜。

### 插件侧值得改的（改 `packages/plugin-ops`）

1. **统一参数名 + 边界校验**：`taskId`/`id` 归一；`xy_task_retry` 对 `taskId` 缺失/非字符串直接 `VALIDATION`，别再吐「已重新排队： | | | attempt undefined/undefined」。这是最容易改成、收益最高的一条。
2. **列表工具给 `limit` 默认值 + 可折叠**：`xy_tasks_list` / `xy_items_list` 默认别一次铺 20/50 行全字段；把 `taskNextStep` 的导航话术收敛成一行或按需。
3. **补一个「出草稿」收口工具**：`xy_copy_plan` 之后能直接落草稿 JSON（或至少允许 `xy_publish_draft` 吃内联对象，不强制 `draftPath`），把三段式压成两段。
4. **补 `batches/:id` 查询工具**（回执已经承诺了这个入口却没有工具），以及 `circuit_list`。
5. **收敛常驻导航文本**：错误回执里的「下一步用 xx」、描述里的互相指路，能放进 docs 就别每条结果都带。
6. **开场 schema 瘦身**：81 条无关 skill 目录、`xy_copy_plan` 的 17 参数，是每轮固定税的大头；能裁剪/按需加载就裁。

### 顺带发现

- `AGENTS.md §0` 写「插件 `xy_*` 工具（当时 14 个，现 15 个）」，与实测 **16** 不符；而同一句又自称「不要在这里或别处重复测试数字/能力状态（历史上同一个数字出现过 6 个版本）」——它自己还在写数字。
- `AGENTS.md` 有 `§7.11`、`§7.12`，但「见 7.10」的 `§7.10` 正文不存在（旧号残留）。
