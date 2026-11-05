# ADR 0007：宿主设置页「是否启用」开关 + 零依赖 settings schema

- 状态：已采纳（2026-11-05，三阶段改造阶段一）
- 关联：[审计报告](../plugin-ux-token-audit-2026-11-05.md)、[ADR 0002 运行时契约](0002-p0-runtime-contract.md)、[ADR 0004 面板 rpc](0004-client-host-rpc.md)、[ADR 0006 client bundle 拆分](0006-client-bundle-split.md)
- 实现：`packages/plugin-ops/src/settings-schema.js`、`settings-host.js`、`client-bundle/11b-settings.part.js`、`client-bundle/12-tail.part.js`、`index.js`、`tool-middleware.js`、`packages/ops-bundle/cordis.patch.yml`
- 测试：`test/settings.test.mjs`、`test/settings-card.test.mjs`、`test/apply.test.mjs`、`test/config.test.mjs`

## 背景

[审计报告](../plugin-ux-token-audit-2026-11-05.md) §二量出：会话开场固定税里，16 个 `xy_*` 工具定义约 **5.2K tok**（参数 JSON 7400 chars / 描述 2320 chars），且每个请求都要带；用户需要一个「不用 BigFish 时把这 5.2K 彻底摘掉」的开关。用户 2026-11-05 拍板「宿主设置页插件卡片」，明确接受「GUI 需重建/重启才能看到，沙箱内无法验收」。

## 三层开关不要混

| 层 | 入口 | 谁提供 UI | 作用 |
| --- | --- | --- | --- |
| ① 宿主插件列表 `disabled:` | `cordis.yml` / `cordis.patch.yml` 条目 | dshmarket（已存在，非本插件） | 整包不装配，最彻底 |
| ② 装配层 `config.enabled` | `ops-bundle/cordis.patch.yml` 的 `config:` | 无（默认值） | `apply(ctx, config)` 第二参，启动时硬开关，默认 `true` |
| ③ 运行时软开关 | 宿主设置页 `bigfish-ops` 命名空间 `{enabled}` | 本 ADR 新增的 settings 卡片 | 落 `~/.dsh/settings.yaml`，运行时实时生效，可反复切 |

三层独立：② 决定「默认」，③ 覆盖「当前」。`config.enabled` 走 `normalizeConfig`（默认开、非布尔 fail loud）；`enabled===false` 时 `apply` 在注册任何东西之前 early-return，只留一条禁用日志。

### 为什么必须是「真反注册」而不是「注册了但空转」

`core/tools/src/index.ts:1027` 的 `ctx.tools.register(definition): () => void` 返回精确反注册器（`:1047` 用 `layers.effect` 登记）。工具定义是模型每轮可见的前缀，只有把它从宿主撤下来，`enabled=false` 才真的省掉那 5.2K tok；「注册 16 个空壳、execute 里 return」等于没省。因此：

- `tool-middleware.js::register()` 收集每个 `ctx.tools.register` 的 disposer，`dispose()` 时先解绑门禁再逐个反注册（此前 disposer 被丢弃，dispose 只解绑门禁）。
- `index.js::apply()` 把注册抽成 `setEnabled(bool)` 控制器：`true` 时 `middleware.register(ctx, specs)`，`false` 时 `registry.dispose()`；`settings-host` 的 `scope.watch` 调它。
- **后台桥接（supervisor / rpc / alerts）保持常驻不随开关拆**：它们不进模型上下文、不占 token，拆了反而要处理「重开时重建连接」的复杂度。

## 决策 1：settings 命名空间用守卫式注册，兼容宿主版本分裂

DSH 0.1.5-rc.2 的 `ctx.settings.register(namespace, schema, opts)` 存在；0.1.7（#677）删掉 `register`，改由插件 Config schema 推导。本机 desktop profile 正是「0.1.5 线 + 部分插件已切 0.1.7」的混合态。所以 `settings-host.js`：

- `ctx.inject` 不存在（CLI / 测试替身）→ 直接 `skipped`，零副作用；这条同时保住 `apply.test.mjs` 的 `inject === ['tools']` 与「单条加载日志」断言。
- `ctx.inject(['settings'], ...)` 动态注入，**不改静态 `inject` 导出**。
- 服务存在但没有 `register`（0.1.7）→ 静默跳过，插件按 `config.enabled` 正常工作。
- 注册/投影任何异常只 `console.log` 一条 warn，绝不拖垮插件加载。
- 首次立即投影 + `scope.watch`：用户上次存过 `false` 时，本次加载首帧就是停用态。

客户端 `11b-settings.part.js` 用 `ctx.inject(['settingsScope'], ...)` 守卫注册 `settings.plugin.item` 卡片，**key 必须与 host 的 namespace 逐字一致**（`bigfish-ops`）——ui-settings-plugins 的硬约束是「宿主 describe() 报告该 ns」∩「client 注册了同 key 卡片」才显示。client 与 host 物理隔离，常量只能各复制一份。

## 决策 2：schema 零依赖手搓，不引入 schemastery

AGENTS.md §2：运行时零第三方依赖，新增依赖必须先写 ADR。但宿主 `settings.describe()`（`settings/settings/src/index.ts:520`）要求 `schema.toJSON()`，`redactSecrets`（`redact.ts:50-92`）按 `schema.type/dict/inner` 游走，`resolve()` 用 `schema(mergeLayers(...))` 做运行时校验——看着必须 import `@deepseek-ai/schemastery`。

**为什么 import 不到**：profile 把 `@bigfish/plugin-ops` 以 **junction** 装进 `node_modules`，Node 仍按真实路径 `D:\Github\big fish` 解析依赖，那里没有 schemastery。实测从插件真实路径与 junction 路径各跑一遍，dynamic import / createRequire × `@deepseek-ai/schemastery` / `schemastery` **四种全 MODULE_NOT_FOUND**。

**为什么手搓能成立**：

- 宿主 `describe()` 只需要 `schema.toJSON()` 的 **envelope**（纯数据 JSON），不需要可执行的 schema 类。
- 客户端 `ui-settings` 用**宿主自带**的 schemastery 把 envelope `rehydrate` 成 live schema（`settings-scope.ts:209`、`schema.ts:50-52`），不依赖插件提供的可执行代码。
- 插件侧 live schema 只需「可被调用做 resolve/校验」+「带 `toJSON()/type/dict/meta`」。

实测（`.scratch/schema-probe2.mjs`，借宿主 3.18.5 校验）：手搓 `makeEnabledSchema(true).toJSON()` 与真 `z.object({ enabled: z.boolean().default(true) }).toJSON()` **字节相等**：

```
{"uid":2,"refs":{"1":{"type":"boolean","meta":{"default":true}},"2":{"type":"object","meta":{"default":{}},"dict":{"enabled":1}}}}
```

`new Schema(envelope)` 可 rehydrate；`hand({})` → `{enabled:true}`、坏值抛 `TypeError`；`hand.type==='object' && hand.dict.enabled.type==='boolean'` 满足 redact walk。11 项兼容性探针全过。

结论：`settings-schema.js` 用纯 JS 造这个 envelope + 一个可调用校验函数，**不新增任何依赖、不改 `package.json`、不需要为依赖写 ADR**。代价是这个形状绑死 schemastery 3.18.x 的序列化格式；宿主升级若改 envelope，需要同步 `settings.test.mjs` 里的 `EXPECTED_ENVELOPE`——该测试会把漂移直接拦下来。

## 被否掉的方案

| 方案 | 为什么不做 |
| --- | --- |
| `peerDependencies` 声明 `@deepseek-ai/schemastery` | AGENTS.md §7.9：离线安装解析不了 `@deepseek-ai/*`，`ERR_PNPM_NO_OFFLINE_META`；且 junction 真实路径下运行时仍解析不到 |
| `createRequire` 锚到 profile 的 node_modules | 把「profile 的绝对布局」写死进插件；profile 一换/一升级就断，且仍然是把宿主内部结构当依赖 |
| 侧边栏里加第 7 个「设置」tab | 用户拍板走宿主设置页；且 `PANEL_TABS` 第 7 项会打破 `client-bundle.test.mjs:801` 的 6 个分区断言，六个 tab 是产品结构（AGENTS.md §0） |
| 纯函数 schema（不造 envelope） | `describe()` 先调 `toJSON()` 就炸；纯对象也过不了客户端 `rehydrate` |
| 改静态 `inject = ['tools','settings','settingsScope']` | 宿主若无该服务，`apply` 加载期直接抛 `cannot get property ... without inject`；且打破既有断言。守卫式动态注入才是兼容分裂版本的正解 |
| 只做装配层 `config.enabled`，不做设置页 | 用户要的是「给一个设置，包括是否启用」，且运行时软开关才能真正实时省 token（改 config 要重启） |

## 代价与验收边界

- client 与 host 的 `bigfish-ops` 常量各一份，改一处必须改另一处（`settings.test.mjs` 与 `settings-card.test.mjs` 分别钉住两端）。
- `settings-host` 的 `project()` 依赖 `scope.get()` 返回值形如 `{enabled}`；宿主若改 `SettingsScope.get()` 契约需同步。
- **GUI 需重建/重启 DSH 才能看到，沙箱内无法验收**：本 ADR 的证据是单元测试（host 注册/投影、client 卡片读写、apply 实时反注册）+ 宿主源码契约取证，不是真机截图。
- 工具定义前缀 ~5.2K tok 的节省只在 `enabled=false` 时成立；启用态下的缓存策略见 [prompt-cache-improvements.md](../prompt-cache-improvements.md)。
