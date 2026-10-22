# big fish — 闲鱼商家运营工具

面向个人/小商家闲鱼店铺的自动化运营工具：商品抓取、发布、自动发货、AI 客服。以开源 **DSH（DeepSeek Harness，MIT）** 为底座做二次开发，**不 fork 上游**，全部能力以 bundle + Cordis 插件 + 独立 daemon 交付。

## 现在到哪了

**P0 → P1.2 完成（代码基线 `main @ 5ffda24`），当前按「一个插件 + 四个模块」重构：发布 / 账号 / 发布前处理 / 采集参考，模块 tab 在侧边栏面板内部切换（共 6 个分区）。发布单件真机通、批量未真机；账号只读摘要；采集 R1 只读统计已真机跑通单件；P2 自动发货押后。**

- 已真机跑通：登录态导入 / 扫码登录 / 令牌自动刷新 / 取商家与全量商品 / 详情落库（`probe`）/ 擦亮（`polish`）/ **CDP 单件发布（两次，均已下架；受网页端类目限制）** / 分类选择（`category.ts`）/ 面板内模块 tab（桌面端 GUI 实拍）/ `GET /accounts` 账号只读摘要 / `POST /reference` 参考采集（单件只读统计）。
- 只有单测（没真机）：批量发布、失败任务重放（`xy_task_retry`）、发布侧风控识别、账号级 pacing（默认 180s）、面板内各工具按钮。
- 未做：账号面板内的导入/扫码（需 host rpc + ADR）、发布前处理（文案接 agent、生图、设置页）、采集 R2 自有商品搬家（待拍板）、自动发货（`deliver`）、IM 收发（`reply`）。
- 质量基线：`node scripts/test-all.mjs` = **709 tests / 709 pass**（27 suites / 73 files）；6 个 TS 包 tsc 0 错误。

👉 **现状、能力矩阵、下一步与待决策项全部在 [docs/STATUS.md](docs/STATUS.md)——读那一篇就够。**

## 技术路线

| 包 | 形态 | 职责 |
| --- | --- | --- |
| `packages/ops-bundle` | 声明 `dsh.bundle.patch` 的 npm 包 | 产品组合（profile）：base + web/headless + 本仓插件 |
| `packages/plugin-ops` | Cordis 插件（纯 ESM JS，零依赖） | 14 个 `xy_*` 工具、写操作审批门禁、侧边栏面板 + 面板内 6 个模块 tab（自动发布 / 账号 / 文案 / 采集 / 概览 / 诊断） |
| `packages/daemon` | 独立 Node 进程（无 LLM） | 队列 + worker + 执行器（限流/熔断/凭据）、登录态、发布、将来的发货 |
| `packages/core` | 纯 TS 库 | 契约与错误、SQLite 队列/商品仓储、策略校验、限流熔断、凭据加密、脱敏日志、发货规则引擎 |
| `packages/channel-mtop` | 纯 TS 库（零依赖） | mtop 签名/信封/cookie 归一/ret 分类，详情、擦亮、商家与商品列表 |
| `packages/channel-cdp` | 纯 TS 库（零依赖） | CDP 会话：接管真 Chrome、cookie 读取、发布步骤机 |
| `packages/channel-guanjia` | 纯 TS 库（零依赖） | 闲管家开放平台客户端（MIT 移植，无消费者） |
| `packages/channel-im` | 纯 TS 库（零依赖） | IM 帧解析/消息归一化/会话状态机（**未接 daemon**） |

关键不变量：**日常动作不经过模型**。LLM 只处理需要判断的部分，daemon 负责确定性执行——这是性能与成本的基础。

## 快速开始

```sh
pnpm install --offline --ignore-scripts   # 本机 registry 不可达，必须离线装；运行时零第三方依赖
node scripts/test-all.mjs                 # 709 tests / 709 pass（单进程顺序跑，沙箱禁止 spawn）
node packages/daemon/src/cli.ts --data-dir .scratch/daemon --port 47001   # 起 daemon（含 worker）
node scripts/dsh-dev.mjs --fresh          # 隔离 DSH Web（含侧边栏栏位）到 127.0.0.1:47080
node scripts/dsh-dump.mjs --smoke         # 在隔离 DSH_HOME 里真装配插件
node scripts/dsh-shot.mjs                 # headless Chrome 截图验证栏位与面板（--hmr 验证热更新）
```

真机发布 / 登录的命令与 Edge 启动参数见 [docs/handoff.md](docs/handoff.md)。开发环境细节见 [docs/dev-setup.md](docs/dev-setup.md)。

## 目录

```
packages/      产品代码（core / daemon / plugin-ops / ops-bundle / channel-mtop / channel-cdp / channel-guanjia / channel-im）
integration/   跨层端到端测试（真实 daemon + 插件 client，不依赖 spawn）
scripts/       test-all / typecheck / dsh-dump / dsh-dev / dsh-shot / dsh-install（lib/ 放零依赖 CDP 与 profile 工具）
docs/          设计、状态、决策记录（入口见下）
  adr/         架构决策记录（0001 基于 DSH、0002 零依赖/无构建/插件用 JS、0003 发布自动化路径）
.agents/skills/ 文案改写与上架合规审核（DSH 项目级 skill，自动发现）
research/      调研证据（repos/ 为第三方材料，不入 git；删除前必须走 AGENTS §6 流程）
.scratch/      临时产物（gitignore）
```

## 文档索引

**必读（3 篇）**
- [docs/STATUS.md](docs/STATUS.md) — 现状、能力矩阵、下一步、待决策项（唯一事实源）
- [AGENTS.md](AGENTS.md) — 硬规则与架构不变量（DSH 每轮自动注入）
- [docs/architecture.md](docs/architecture.md) — 已实现形态（运行时/worker/执行器/路由）+ 发布页真机校准 §13

**按需**
- [docs/dev-setup.md](docs/dev-setup.md) 开发环境 · [docs/handoff.md](docs/handoff.md) 真机操作与本机环境
- [docs/component-decomposition.md](docs/component-decomposition.md) 包边界 · [docs/client-plugin-sidebar.md](docs/client-plugin-sidebar.md) 侧边栏机制
- [docs/im-protocol.md](docs/im-protocol.md) · [docs/delivery-rules.md](docs/delivery-rules.md) — P2 自动发货施工规格
- [docs/p1.3-plan.md](docs/p1.3-plan.md) 方案（执行状态看 STATUS.md） · [docs/adr/](docs/adr/) 架构决策
- [docs/end-to-end-chain-and-borrowing.md](docs/end-to-end-chain-and-borrowing.md) 链路与借鉴关系 · [docs/repost-feature-parity.md](docs/repost-feature-parity.md) 搬运助手逆向与功能覆盖/红线

**历史调研（证据，不必读）**
- [xianyu-ops-agent-design](docs/xianyu-ops-agent-design.md) · [xianyu-4q-research](docs/xianyu-4q-research.md) · [xianyu-commercial-tools-analysis](docs/xianyu-commercial-tools-analysis.md) · [xianyu-wuli-kit-analysis](docs/xianyu-wuli-kit-analysis.md) · [asset-extraction](docs/asset-extraction.md) · [tool-failure-analysis](docs/tool-failure-analysis.md) · [copywriting-and-imagegen-plan](docs/copywriting-and-imagegen-plan.md)

## 合规提示

本工具通过自动化操作商家自己的闲鱼账号完成发布与发货，属于平台协议灰色地带，存在账号被限流或封禁的风险；不得用于搬运他人商品、倒卖数据。第三方参考仓库的 AGPL/GPL 代码只借鉴思路、不复制进本仓库。真人验证只用已导入的账号并默认 dry-run（本机账号是用户大号，真发须用户点头、发完立即下架）。
