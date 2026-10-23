# ADR 0006：client bundle 拆成多片段 + 零依赖拼接器

- 状态：已采纳（2026-10-23，面板 1103 行时拆分）
- 关联：[ADR 0004 面板 rpc 通道](0004-client-host-rpc.md)、[ADR 0002 运行时契约](0002-p0-runtime-contract.md)
- 实现：`packages/plugin-ops/src/client-bundle/*.part.js`、`scripts/build-client.mjs`、`packages/plugin-ops/test/client-parts.test.mjs`

## 背景

`packages/plugin-ops/client.js` 涨到 **1103 行 / 86.3 KB**，AGENTS §3 给它开的例外上限是 1200（历史上从 400 → 700 → 900 → 1200 一路让位）。素材库 UI 预计再加 100–200 行，**必然击穿**；而继续上调上限等于把「这个文件已经没人能读懂」这件事合法化。

## 约束（核实过 DSH 源码，不是推测）

宿主（DSH checkout）侧的 client 入口解析：

- `packages/client/modules/src/index.ts` 的 `resolveMeta()` 按**包名**解析出**单个** `clientPath`；boot graph row 以包名为唯一键（重复即 `duplicate graph entry`）。
- `clientExportOf()` 只接受 `exports["./client"]` 是字符串或 `{ default: string }`——一个包只能有一个 client 入口。
- `dsh.client` 的字段只有 `platform` / `inject` / `immediately` / `external`，**没有多入口**。
- combo 资源是把**多个包**的 bundle 拼成一个脚本，不是一包多文件。
- 官方链路里每个 client 包都跑 `tsdown` 生成单个 `lib/client.js`（`packages/client/tsdown.client.ts`）——「无构建步骤」从来只是本仓库手写 wrapper 绕开了自己的构建脚本，宿主仍然只读那一个产物文件。

结论：**一包多入口不成立**；想多文件开发，就必须有一个「合成成单文件」的步骤。

## 决策

1. **源**：`packages/plugin-ops/src/client-bundle/*.part.js`——它们是 loader `factory` 函数体的**连续切片**，按文件名排序拼接（顺序即 bundle 内的声明顺序）。单个片段仍遵守 AGENTS §3 的 ≤ 400 行。
2. **拼接器**：`scripts/build-client.mjs`，只用 `node:fs`，**纯 concat、不改写任何一行**。`--check` 只校验「片段拼接 == 产物」，不同步退出码 1 并打印首个差异行。
3. **产物 `client.js` 提交进 git**：它是运行时交付物（宿主直接读），不是 CI 产物；首行有「生成物，不要直接编辑」标记。这与 AGENTS §6「不提交构建产物」的区别写在这里以免误解。
4. **守护单测**：`test/client-parts.test.mjs` 断言「拼接 == 产物」「每个片段 ≤ 400 行」「首末片段含 loader 头尾」；既有的 `test/client-bundle.test.mjs`（1550 行，vm 里跑产物做行为回归）**不改**，继续读产物——所以拆分对它是透明的。
5. **首次拆分是机械切片**：按行区间切 12 段、保持原行序，产物与拆分前**逐字节可比对**（唯一增量是每段顶部一句职责注释 + 首行生成物标记）。

## 被否掉的方案

| 方案 | 为什么不做 |
| --- | --- |
| tsdown / rollup 等 bundler | 第三方依赖，离线装不上（AGENTS §7.9）；还要给 client 侧加 tsconfig + bundler 配置，把「无构建、手写 loader」的交付形态彻底改掉 |
| 一个 bundle 里 `load()` 两次注册两个 id | `register()` 只拒重复 id，但第二个 id 在宿主侧没有 graph row：`prefetch()` 抛 `not a graph entry`，combo/HMR 按 entry id 索引也找不到它 |
| 把常量 / 纯逻辑挪到 host 侧经 rpc 下发 | 只省约 50 行，却把 UI 常量变成异步数据（首屏多一跳、离线降级要重写），收益不抵复杂度 |
| 继续上调上限 | 等于承认这个文件不可维护；每加一个 tab 都要再谈一次上限 |

## 代价

- 片段不是合法模块：单独打开 IDE 会报语法错误（缺 factory 外壳），**属预期**。
- 多一步「改片段后跑 `node scripts/build-client.mjs`」；忘记跑会被 `client-parts.test.mjs` 拦住，不会静默上线。
- 产物行数会继续增长（现在 1148 行），但它已不可直接编辑，行数不再是维护成本的信号；真正的信号是**单个片段的行数**。
