# big fish — 闲鱼商家运营工具

面向个人/小商家闲鱼店铺的自动化运营工具：商品详情抓取、批量发布、自动发货、AI 客服。

**当前状态：调研与选型完成，进入 P0 骨架。** 还没有业务代码。

## 技术路线

以开源 **DSH（DeepSeek Harness，MIT）** 为 agent 底座做二次开发，**不 fork 上游**，全部能力以外部包形式提供：

| 包 | 形态 | 职责 |
| --- | --- | --- |
| `packages/ops-bundle` | 声明 `dsh.bundle.patch` 的 npm 包 | 产品组合（profile）：base + web/headless + 本仓插件 |
| `packages/plugin-ops` | Cordis 插件 | `xy_*` 工具、settings 卡片、client UI、cron 唤醒、写操作审批门禁 |
| `packages/daemon` | 独立 Node 进程（无 LLM） | 24/7 确定性动作：登录态保活、发布队列、订单监听、自动发货、限流熔断 |
| `packages/core` | 纯库 | 通道实现（mtop / CDP）、签名、SQLite 队列、凭据加密 |

关键不变量：**日常动作不经过模型**。LLM 只处理需要判断的部分，daemon 负责确定性执行——这是性能与成本的基础。

## 目录

```
docs/          设计、调研、决策记录
  adr/         架构决策记录（ARCHITECTURE DECISION RECORDS）
  *.md         调研与设计文档
research/      第三方资料
  notes/       仓库技术分析笔记（带 file:line 证据）
  repos/       第三方仓库与样本（被 .gitignore 排除，可重新下载）
scripts/       本地开发脚本
packages/      产品代码（P0 待建）
```

文档索引：
- [ADR 0001：基于 DSH 二次开发](docs/adr/0001-base-on-dsh.md)
- [总体设计：三层架构与性能预算](docs/xianyu-ops-agent-design.md)
- [四问调研：仓库/风控/扩展/问题清单](docs/xianyu-4q-research.md)
- [商业工具逆向分析（三款）](docs/xianyu-commercial-tools-analysis.md)、[雾里 3.20 套件](docs/xianyu-wuli-kit-analysis.md)
- [工具调用失败复盘与仓库约定](docs/tool-failure-analysis.md)

## 开发

仓库约定见 [AGENTS.md](AGENTS.md)（DSH 会自动加载）。要点：`run_code` 内用 `Promise.allSettled` 兜异常；取 GitHub 文件走 `api.github.com` 而非 raw；联网只能靠 `run_code` 里的 Node `fetch`；临时文件放 `.scratch/`。

```sh
pnpm install          # P0 建立 workspace 后可用
```

## 合规提示

本工具通过自动化操作商家自己的闲鱼账号完成发布与发货，属于平台协议灰色地带，存在账号被限流或封禁的风险；不得用于搬运他人商品、倒卖数据。第三方参考仓库的 AGPL/GPL 代码只借鉴思路、不复制进本仓库。
