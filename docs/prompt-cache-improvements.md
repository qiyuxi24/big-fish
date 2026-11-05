# 缓存命中率：能落地的范围与做法（阶段三，2026-11-05）

> 状态：**分析 + 已落地项记录**。数据来源 `docs/plugin-ux-token-audit-2026-11-05.md` §二 与
> `acp_cache`（billion-context 0.1.212，本会话 31 次请求）。本文不代表「缓存命中率已经修好」——
> 大头在宿主 / provider 层，bigfish 插件能做的只是把自己这一份前缀缩小，并把可配置项写清楚。

## 0. 先把账算清楚：哪些 miss 我们能管，哪些不能

`acp_cache` 终值（31 次请求）：

| 项 | 值 |
| --- | --- |
| 总 input | 1.55M tok |
| cached | 317.4K（**整体 hit 20.5%**） |
| output | 25.5K |
| miss 拆分 | new 66.0K / compress re-pay 0 / **upstream-ttl-or-client-rewrite 1.16M** |
| 异常 provider-side miss | 24 samples / **1.14M tok（占 74%）** |
| abort-correlated | 30 个 miss 落在 client mid-stream abort 后 30s 内 |
| BODY STABILITY | 30/30 `diverged`，**全是 `tail(params/notes)` 发散，0 byte-identical**，mid-history 0 / head 0 |

结论先说在前面：**1.16M 未归因 miss 工具自己标注为 expected provider-side behavior（TTL / eviction / relay / stateful upstream 校验），不是 billion-context 的 bug，也不是 bigfish 插件代码能改的**。插件能影响的只有「开场固定税」和「每轮重发的常驻文本」两块。

## 1. 插件侧已落地的（阶段一 + 阶段二，实测口径）

### 1.1 运行时开关：关掉就真的摘掉整份工具 schema（最大一笔）

- `ADR 0007` 的 `enabled=false`（设置页 / `config.enabled`）会**反注册 16 个 `xy_*` 工具 + 门禁**，
  `tool-middleware.js` 收集 `ctx.tools.register` 的 disposer 一并撤销。
- 开场完整 definitions JSON ≈ **5188 tok**（阶段二后复测 13056 chars ≈ **5222 tok**）。停用态这笔固定税归零。
- 证据：`test/apply.test.mjs` 的「设置卡片运行时关掉会真撤销 16 个工具，再打开会重注册」、
  「settings.yaml 存过 false 时首帧零工具」。

### 1.2 工具返回收敛：一次「看状态」从 ≈2918 tok 降到 ≈1315 tok

| 工具 | 改前 | 改后 |
| --- | --- | --- |
| `xy_tasks_list` 默认 limit | 20 | 10 |
| 逐行 `taskNextStep` 导航 | 每行一条 | 末尾按需一行（`formatTaskListNextSteps`） |
| 4 个读工具默认合计 | **6387 chars ≈2903 tok** | **2892 chars ≈1315 tok（−55%）** |

这些表格下一轮会作为历史被原样重发；少一半字符 = 每轮少一半重发量。证据：
`test/tool-phase2.test.mjs`、`packages/plugin-ops/src/tool-format.js`。

### 1.3 描述文本收敛（含跨工具指路）

- 描述总长 2320 → **2080 chars**（−240）。
- 错误回执的 `VALIDATION` 提示压短；`formatTaskLine({})` 不再吐「` | | | `」四个空字段（改「(未返回任务详情)」）。
- 门禁 reason 6 条**一条没删**（那是安全边界，不是为了省 token 能砍的）。

**诚实口径**：阶段二给 `xy_publish_draft` 加了内联 `draft` 参数、`xy_task_retry` 加了 `id` 别名，
参数 JSON 反而从 7400 → **7729 chars**、属性 56 → 58；完整 definitions 从 5188 → 5222 tok。
即「描述省了，参数涨了，净额基本持平」。**工具 schema 瘦身不是靠阶段二完成的，靠的是 1.1 的实时开关**。

## 2. 插件侧还能做、但本轮没做的（建议，非承诺）

1. **`xy_copy_plan` 的 17 参数**：单工具 schema 1907 chars，是 16 个里最大的一个。可把
   `specs`/`flaws`/`accessories`/`imagePaths` 等低频字段收进一个 `details` 对象，或按品类模板
   在运行时（面板 / skill）拼装，工具只留 6 个高频参数。收益估计 ~600–800 tok/轮，但会改
   `xy_copy_plan` 的调用契约，需单独拍板。
2. **补 `batches/:id` / `circuit_list` 工具**：回执里已经承诺了入口却没有工具，模型只能绕路多打几次
   `xy_tasks_list` / `xy_status`；补上能减少「为了确认状态而多发的轮次」，间接减少重发前缀。
   （审计报告 §四建议 4，阶段二白名单未含，未做。）
3. **状态类工具支持 `fields` 投影**：`xy_status` 现在每个状态工具都重复播报完整 capabilities 段
   （报告 §一实测）。让调用方只要计数时别带 capabilities，能再省一点常驻文本。

## 3. 宿主 / 配置侧（不是 bigfish 仓库能改，写清口径供用户操作）

1. **长会话及时开新会话 / 手动 `compress`**：失败会话 `session-746edd77` 死于
   `1543 msgs / 4.8MiB / 705 steps` → `#4528` per-turn O(messages) 同步扫描饿死事件循环 →
   51× `client aborted mid-stream` 死循环。两个会话的 nudge 都是 `idle`
   （`max compressible 23252 < threshold 50000`），**等自动压缩等于等不到**。这是 §三失败会话的根因，
   也是本会话 30 个 abort-correlated miss 的来源。
2. **压缩阈值 50000 偏高**：对「33.5K 起步、每轮涨一点」的会话，建议调低或会话中途主动压缩一次。
   （billion-context 侧配置，不在本仓。）
3. **stateful relay → `diagnostics.renderNone=true`**（`#2483`）：若上游是 claude-code / magpie 类
   stateful relay，assistant 文本上的 render tags 会触发回显校验 miss；注意中途切换有且仅有一次 replay。
4. **尾部顶层参数稳定**：BODY STABILITY 指出 30/30 请求都因 `tail(params/notes)` 发散而
   0 byte-identical，provider 因此对 prompt cache 重分区（`#3803`）。这属于请求装配层，插件管不到，
   但它是「明明前缀没变却反复 miss」的直接解释。
5. **修 `ops_bash` 的 provenance.json ENOENT**：`dsh-ops/lib/bash-ipc.js:22` 仍按旧路径
   `runtime/win32-x64/` 找，新布局是 `native/` + `@dsh-ops/*`。本会话两次 `ops_bash` 全失败，
   所有命令改用 `pwsh` 完成。这是宿主包版本/路径错配，非本仓代码。

## 4. 验收口径（别把「做了」说成「命中率提高了」）

- 本仓能验证的：`node scripts/test-all.mjs` 全绿 + `test/settings.test.mjs`、`settings-card.test.mjs`、
  `apply.test.mjs` 的开关/投影断言；以及 `.scratch/audit2.mjs` 的 schema 体积复测。
- **不能在本仓验证的**：provider 侧 TTL/eviction/relay 行为、abort cascade、`diagnostics.renderNone`、
  压缩阈值、GUI 设置卡片（需重建/重启 DSH，沙箱内无法验收）。
- 要证明命中率真的提升，需要用户在**普通终端 + 稳定上游**下另开一轮等长会话，对比 `acp_cache` 的
  hit rate / provider-side miss 与本报告基线（20.5% / 1.14M）。本轮不声称该数字已改善。

Open item: 上述 §2 三项若要做，需用户确认「改 `xy_copy_plan` 调用契约」与「新增 2 个工具」两个口径
（新增工具会改变 16 个工具的数量，涉及 `apply.test.mjs` / `tool-middleware.test.mjs` 的断言）。
