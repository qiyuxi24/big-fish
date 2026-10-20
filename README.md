# big fish — 闲鱼商家运营工具

面向个人/小商家闲鱼店铺的自动化运营工具：商品详情抓取、批量发布、自动发货、AI 客服。

**当前状态：P0 骨架跑通**（122 条测试全绿、core/daemon 类型检查通过、插件在真 DSH loader 里装配成功并注册 7 个工具）。还没有接真实闲鱼通道与执行器。

## 技术路线

以开源 **DSH（DeepSeek Harness，MIT）** 为 agent 底座做二次开发，**不 fork 上游**，全部能力以外部包形式提供：

| 包 | 形态 | 职责 |
| --- | --- | --- |
| `packages/ops-bundle` | 声明 `dsh.bundle.patch` 的 npm 包 | 产品组合（profile）：base + web/headless + 本仓插件 |
| `packages/plugin-ops` | Cordis 插件（纯 ESM JS，零依赖） | `xy_*` 工具、写操作审批门禁；后续加 settings 卡片、client UI、cron 唤醒 |
| `packages/daemon` | 独立 Node 进程（无 LLM） | 24/7 确定性动作：登录态保活、发布队列、订单监听、自动发货、限流熔断 |
| `packages/core` | 纯 TS 库 | 契约与错误、SQLite 队列、限流熔断、凭据加密、脱敏日志、配置 |

关键不变量：**日常动作不经过模型**。LLM 只处理需要判断的部分，daemon 负责确定性执行——这是性能与成本的基础。

## 快速开始

```sh
pnpm install --offline --ignore-scripts   # 本机 registry 不可达，必须离装；运行时零第三方依赖
node scripts/test-all.mjs                 # 122 tests / 122 pass
node scripts/typecheck.mjs                # core + daemon
node scripts/dsh-dump.mjs --smoke         # 在隔离 DSH_HOME 里真装配插件
node packages/daemon/src/cli.ts --data-dir .scratch/daemon --port 47001
```

详见 [docs/dev-setup.md](docs/dev-setup.md)。

## 目录

```
packages/      产品代码（core / daemon / plugin-ops / ops-bundle）
integration/   跨层端到端测试（真实 daemon + 插件 client，不依赖 spawn）
scripts/       test-all / typecheck / dsh-dump 三个开发脚本
docs/          设计、调研、决策记录
  adr/         架构决策记录（0001 基于 DSH、0002 运行时契约）
research/      第三方资料（repos/ 被 gitignore，可重新下载）
.scratch/      临时产物（gitignore）
```

文档索引：
- [ADR 0001：基于 DSH 二次开发](docs/adr/0001-base-on-dsh.md)；[ADR 0002：零依赖/无构建/插件用 JS](docs/adr/0002-p0-runtime-contract.md)
- [架构（P0 已实现形态）](docs/architecture.md)；[开发环境与运行方式](docs/dev-setup.md)
- [总体设计：三层架构与性能预算](docs/xianyu-ops-agent-design.md)
- [四问调研：仓库/风控/扩展/问题清单](docs/xianyu-4q-research.md)
- [商业工具逆向分析（三款）](docs/xianyu-commercial-tools-analysis.md)、[雾里 3.20 套件](docs/xianyu-wuli-kit-analysis.md)
- [工具调用失败复盘与仓库约定](docs/tool-failure-analysis.md)

## 合规提示

本工具通过自动化操作商家自己的闲鱼账号完成发布与发货，属于平台协议灰色地带，存在账号被限流或封禁的风险；不得用于搬运他人商品、倒卖数据。第三方参考仓库的 AGPL/GPL 代码只借鉴思路、不复制进本仓库。
