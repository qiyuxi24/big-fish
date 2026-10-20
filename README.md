# big fish — 闲鱼商家运营工具

面向个人/小商家闲鱼店铺的自动化运营工具：商品详情抓取、批量发布、自动发货、AI 客服。

**当前状态：P1.1 完成**——daemon 已经是一个能自己跑活的常驻进程（真 HTTP + SQLite 队列 + worker + 执行器 + 限流熔断 + 凭据），`probe`（读详情落库）与 `polish`（擦亮）两条链路已经接上真实 mtop 通道；`publish` / `deliver` / `reply` 仍是显式 `UNSUPPORTED`（宁可不做，也不给假成功）。379 tests 全绿、5 个 TS 包类型检查 0 错误、插件在真 DSH loader 里注册 7 个工具、Web GUI 侧边栏有「BigFish 闲鱼运营」入口。尚未与真实闲鱼联调（测试全部用假通道）。

## 技术路线

以开源 **DSH（DeepSeek Harness，MIT）** 为 agent 底座做二次开发，**不 fork 上游**，全部能力以外部包形式提供：

| 包 | 形态 | 职责 |
| --- | --- | --- |
| `packages/ops-bundle` | 声明 `dsh.bundle.patch` 的 npm 包 | 产品组合（profile）：base + web/headless + 本仓插件 |
| `packages/plugin-ops` | Cordis 插件（纯 ESM JS，零依赖） | `xy_*` 工具、写操作审批门禁、侧边栏面板；后续加 settings 卡片、cron 唤醒 |
| `packages/daemon` | 独立 Node 进程（无 LLM） | 24/7 确定性动作：队列 + worker + 执行器（限流/熔断/凭据）、登录态保活、发布、发货 |
| `packages/core` | 纯 TS 库 | 契约与错误、ret 风控分类、SQLite 队列/商品仓储、策略校验、限流熔断、凭据加密、脱敏日志、配置 |
| `packages/channel-mtop` | 纯 TS 库（零依赖） | mtop 通道：签名、信封、cookie 归一、ret 分类、读写接口 data 构造 |
| `packages/channel-cdp` | 纯 TS 库（零依赖） | CDP 会话：接管真 Chrome、页面操作、拦截 XHR JSON、发布步骤机、cookie/登录态读取 |
| `packages/channel-guanjia` | 纯 TS 库（零依赖） | 闲管家开放平台客户端（MIT 移植） |

关键不变量：**日常动作不经过模型**。LLM 只处理需要判断的部分，daemon 负责确定性执行——这是性能与成本的基础。

## 快速开始

```sh
pnpm install --offline --ignore-scripts   # 本机 registry 不可达，必须离线装；运行时零第三方依赖
node scripts/test-all.mjs                 # 379 tests / 379 pass
node packages/daemon/src/cli.ts --data-dir .scratch/daemon --port 47001   # 启动 daemon（含 worker）
node scripts/dsh-dev.mjs --fresh          # 起隔离 DSH Web（含侧边栏栏位）到 127.0.0.1:47080
node scripts/dsh-dump.mjs --smoke         # 在隔离 DSH_HOME 里真装配插件
node scripts/dsh-shot.mjs                 # headless Chrome 截图验证栏位与面板（--hmr 验证热更新）
```

详见 [docs/dev-setup.md](docs/dev-setup.md)。

## 目录

```
packages/      产品代码（core / daemon / plugin-ops / ops-bundle / channel-mtop / channel-cdp / channel-guanjia）
integration/   跨层端到端测试（真实 daemon + 插件 client，不依赖 spawn）
scripts/       test-all / typecheck / dsh-dump / dsh-dev / dsh-shot 开发脚本（lib/ 放零依赖 CDP 与 profile 工具）
docs/          设计、调研、决策记录
  adr/         架构决策记录（0001 基于 DSH、0002 零依赖/无构建/插件用 JS）
research/      调研笔记（notes/ 证据层，保留；repos/ 为 886MB 第三方材料，已按 docs/asset-extraction.md 吸收后删除）
.scratch/      临时产物（gitignore）
```

文档索引：
- [ADR 0001：基于 DSH 二次开发](docs/adr/0001-base-on-dsh.md)；[ADR 0002：零依赖/无构建/插件用 JS](docs/adr/0002-p0-runtime-contract.md)
- [架构（P1.1 已实现形态：运行时/worker/执行器/路由）](docs/architecture.md)；[开发环境与运行方式](docs/dev-setup.md)
- [组件拆解与整合（三个 channel 包的契约）](docs/component-decomposition.md)
- [IM 协议（P2 契约）](docs/im-protocol.md)；[自动发货规则（P2 契约）](docs/delivery-rules.md)
- [资产吸收与删除清单（13 开源仓 + 3 商业包）](docs/asset-extraction.md)
- [Client 插件与侧边栏栏位（含 HMR 与调试坑）](docs/client-plugin-sidebar.md)
- [总体设计：三层架构与性能预算](docs/xianyu-ops-agent-design.md)
- [四问调研：仓库/风控/扩展/问题清单](docs/xianyu-4q-research.md)
- [商业工具逆向分析（三款）](docs/xianyu-commercial-tools-analysis.md)、[雾里 3.20 套件](docs/xianyu-wuli-kit-analysis.md)
- [工具调用失败复盘与仓库约定](docs/tool-failure-analysis.md)

## 合规提示

本工具通过自动化操作商家自己的闲鱼账号完成发布与发货，属于平台协议灰色地带，存在账号被限流或封禁的风险；不得用于搬运他人商品、倒卖数据。第三方参考仓库的 AGPL/GPL 代码只借鉴思路、不复制进本仓库。
