# ADR 0001 — 基于 DSH 二次开发，以 Cordis bundle + 插件形态交付

- 状态：已决定（2026-10-20，用户 m00643）
- 决策者：用户 + Lead
- 关联：docs/xianyu-ops-agent-design.md（三层架构）、docs/xianyu-4q-research.md（通道与风控）

## 背景

要做一个「闲鱼商家运营工具」：抓商品详情、自动发布、自动发货、AI 客服。核心痛点是**不想自己写 agent loop**（会话、步骤、工具调度、审批、沙箱、上下文压缩、GUI、定时唤醒、打包分发）。

## 决策

**以开源 DSH（DeepSeek Harness，MIT，0.1.5-rc.2）为底座二次开发，但不对上游做 fork，全部能力以外部包形式提供。**

交付单位不是"一个插件"，而是**一个 bundle（profile）+ 若干 Cordis 插件 + 一个独立 daemon 进程**：

| 包 | 形态 | 职责 |
| --- | --- | --- |
| `@xianyu/ops-bundle` | 声明 `dsh.bundle.patch` 的 npm 包 | 产品组合：依赖 `dsh-base` + `dsh-web-app`（或 headless）+ 我们的插件，决定最终产品长什么样 |
| `@xianyu/plugin-ops` | Cordis 插件 | 注册 `xy_*` 工具、settings 卡片、client UI 行、cron 唤醒、写操作审批门禁 |
| `@xianyu/daemon` | 独立 Node 进程（无 LLM） | 24/7 确定性动作：登录态保活、发布队列、订单监听、自动发货、限流熔断 |
| `@xianyu/core` | 纯库 | mtop/CDP 通道、签名、SQLite 队列、凭据加密 |

## 依据（均已在本机源码核对）

1. DSH 的插件树就是 Cordis：`docs/cordis-primer.md`、`docs/cordis-api/{context,events,service,registry,fiber}.md`；扩展点参考 `docs/cookbook/extension-cookbook.zh.md`。
2. 「产品 = bundle」是官方形态：`packages/bundle/{base,headless,web-app,sdk-app,acp-app}`，每个都声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，通过 patch 层叠加装配（`apps/cli/src/profile-boot.ts` 注释：bundle layers in `dsh.profile.bundles` order → profile 自己的 cordis.patch.yml → `--patch` overlays）。
3. 插件安装机制现成：`dsh plugin --profile <name> pnpm add <pkg>`（`apps/cli/src/plugin.ts` 是 pnpm 转发器，并按"已安装状态"自动把声明了 `dsh.bundle` 的依赖并入 layer 栈）。
4. 打包成分发工具现成：`apps/desktop` 是 Electron + electron-builder，`pnpm package:desktop:win:x64` / `:unsigned` / `:dir`，并含 electron-updater 自动更新。
5. 许可：仓库根 `LICENSE` 为 MIT，可闭源商用。品牌限制见 `BRAND_GUIDELINES.md`：不得用 "DeepSeek Harness" 商标做产品名，可用 "built on DSH" 与 "DSH" 缩写。

## 为什么不 fork

- 上游仍是 `0.1.5-rc.2`，插件 API 会漂移；fork 后每次升级都要 rebase，长期成本高。
- 我们需要的定制（品牌、GUI 页面、会话行）都有扩展点：client-module / ConversationNodeDefinition / settings 卡片 / `tools/pre-execute`。
- 只有"深度改 loop 语义"或"彻底重做 UI 骨架"才值得 fork 局部文件；届时再议。

## 取舍与已知代价

- **体积**：Electron + 全家桶首包预计 150–250MB（待实测）。若不接受，备选 `headless` bundle + 本地 Web UI（体积小、启动快），产品形态待测后定。
- **API 漂移**：插件只依赖稳定扩展点，pin DSH 版本（peerDependency 精确到 patch）。
- **LLM 计费**：token 必须由用户自填 key 或走我们的中转，绝不把 key 打进安装包。
- **许可证传染**：AGPL/GPL 的三个参考仓库（XianyuAutoAgent / xianyu-auto-reply / xianyu-super-butler）只借鉴思路，不拷代码。
- **不变量**：daemon 仍然与 LLM 解耦——90% 的日常动作确定性执行，**不经过模型**，这是性能与成本的关键。

## 落地顺序（P0）

1. `D:\Github\big fish` 建 pnpm workspace：`packages/{core,daemon,plugin-ops,ops-bundle}`，`git init`。
2. 最小插件（一个 `xy_ping` 工具 + 一个 settings 键），用 checkout 里的 CLI 以本地 profile 加载跑通：`dsh --profile xianyu`。
3. 打一个空壳 desktop 包，实测体积与冷启动，据此定最终形态。
4. 跑通后再接 daemon 与第一条真实通道（详情抓取）。
