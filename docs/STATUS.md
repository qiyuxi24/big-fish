# 项目状态 — 单一事实源

> **最后更新 2026-10-21（P1.2 收尾）· 基线 `main @ 46823e5`。**
> 本文是仓库**唯一**的「现在到哪了 / 下一步做什么」入口。其他文档里的测试数字、工具数量、阶段状态一律以本文为准；
> 若发现别处与本文冲突，以本文为真、并把冲突处改成指向本文。规则看 [AGENTS.md](../AGENTS.md)，实现形态看 [architecture.md](architecture.md)。

---

## 1. 一句话

**能登录、能取品、能单件发布（真实跑通过一次，受类目限制）；不能自动发货、不能批量上架、IM 未接进 daemon。**
P0 → P1.2 全部完成并提交；当前站在 P2（自动发货）的门口。

## 2. 能做什么 / 不能做什么

验证等级：**真机** = 对真实闲鱼跑通过；**单测** = 只有测试覆盖、未对真实接口跑过；**方案** = 只有文档。

| 能力 | 状态 | 证据与限制 |
| --- | --- | --- |
| 登录态导入（CLI / `POST /accounts/import` / `xy_import_account`） | ✅ 真机 | 从带 `--remote-debugging-port` 的 Chrome 读 goofish cookie，AES-256-GCM 加密落盘；Cookie 读取按 `Storage.getCookies` → `Network.getAllCookies` 降级 |
| 扫码登录（`npm run daemon:login` / `POST /accounts/login`） | ✅ 已实现，单测通过 | 轮询 cookie，`unb` + `_m_h5_tk` 齐备才算成功（默认超时 180s）。**未见真机扫码成功留档** |
| 令牌自动刷新 | ✅ 真机 | `_m_h5_tk` 约 2h 过期；`FAIL_SYS_TOKEN_EXOIRED` 时合并响应 Set-Cookie、重签重试**一次**并回写凭据 |
| 取商家 ID + 全量商品 | ✅ 真机 | `user.page.head` + `xyh.item.list` 分页（每页 ≤20）；CDP 抓包与 mtop 直读双验证 |
| `probe` 商品详情落库 | ✅ 真机 | mtop 详情 → `items.upsert` |
| `polish` 擦亮 | ✅ 真机 | mtop 擦亮 2.0 |
| `publish` 单件发布（CDP 步骤机） | ⚠️ **成功过一次** | 2026-10-21 测试小号发成 itemId `1093817229436`（已下架留档）。**真提交需 `BF_PUBLISH_SUBMIT=1`；类目受网页端支持矩阵限制**（电子资料/学习笔记/课业本 ✅；教材教辅/语言培训/学习资料定制/文学/考研咨询 ❌）。这是人工操作留档，仓库代码里没有该 itemId 的痕迹 |
| 草稿指定类目 + 不支持即失败 | ✅ 真机 | `channel-cdp/src/category.ts`，antd Select 必须可信鼠标事件；命中「网页版暂不支持」立即 `VALIDATION` |
| 批量上架调度 | ❌ 未做 | 缺「草稿批次 → 队列 → 串行 QPS≤1 → 失败隔离」的批次层 |
| `deliver` 自动发货 | ❌ `UNSUPPORTED` | 规则引擎已就绪，缺订单/消息源与执行接线 |
| `reply` / IM 收发 | ❌ `UNSUPPORTED` | `channel-im` 已提交（帧解析/归一化/会话状态机，32 tests），**未接 daemon**；websocket 长连、发送、握手未实现 |
| 文案 skill（改写 + 合规审核） | ✅ 2 个 skill | `skills/xianyu-listing-copy`、`xianyu-listing-audit`；**未被 DSH 自动发现**（无 `customSkillDirs`），未接进 agent 流程 |
| AI 生图 | 📝 方案 | 选型与管线见 [copywriting-and-imagegen-plan.md](copywriting-and-imagegen-plan.md)，未实现调用 |
| 地址库 / 别名匹配 | ❌ 未做 | CDP 下地址搜索候选不回显，只能匹配「常用地址/附近地址」；匹配不到就失败回显候选 |
| 闲管家开放平台 | 📝 客户端在 | `channel-guanjia`（MIT 移植）无消费者、缺凭证 |
| Web GUI 侧边栏面板 | ✅ 只读 | 静态快照 + 手动刷新；按钮 disabled 是刻意的（DSH 无「面板按钮调 host 工具」公开 API） |

## 3. 质量基线（可复现）

```
node scripts/test-all.mjs     # 592 tests / 592 pass / 21 suites / 61 个测试文件 / ~5s
```

| 范围 | 用例数 | 备注 |
| --- | --- | --- |
| core | 131 | 队列、仓储、策略、限流熔断、凭据、脱敏、配置、发货规则引擎 |
| daemon | 142 | HTTP、CLI、执行器、worker、路由、账号导入、CDP 发布 |
| channel-mtop | 88 | 纯函数 |
| channel-cdp | 86 | 假连接与假页面回放 |
| channel-guanjia | 62 | 纯函数 |
| channel-im | 32 | 帧解析 / 归一化 / 状态机 |
| plugin-ops | 49 | 插件契约、门禁、草稿校验、client bundle |
| integration | 2 | 插件 client ↔ 真 daemon 端到端 |
| **合计** | **592** | ops-bundle 无测试（只声明组合） |

- 类型检查：**6 个 TS 包** tsc 0 错误（core / daemon / channel-mtop / channel-cdp / channel-guanjia / channel-im）。
  **plugin-ops 与 ops-bundle 是纯 ESM JS，无 tsconfig，不在类型检查覆盖内**——改这两个包只能靠测试。
- 运行时零第三方依赖；全仓 `TODO/FIXME/HACK` 0 条。
- 仓库 8 个包、daemon 10 条 HTTP 路由、插件 9 个 `xy_*` 工具、5 个 TaskKind（probe/polish/publish/deliver/reply）。

## 4. 下一步

### 4.1 主线：P2 自动发货（建议先做，分三步不跨步）

**为什么是它**：用户明确要的下一块；三块地基已经就位——规则引擎（`core/src/delivery.ts`，21 tests，4 种动作 + 红线词拦截）、IM 协议事实（`docs/im-protocol.md` 已把注册/心跳/ACK/`/r/MessageSend/sendByReceiverScope` 发消息帧/解密顺序全部写成可施工规格）、消息解析（`channel-im` 32 tests）。

**卡点**：①订单源完全没有依据——`docs` 里「订单」0 命中，订单列表/确认发货接口未抓包；②IM websocket 客户端未写（协议有、实现无）。

| 步骤 | 做什么 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **P2.0 半自动**（先能用） | 规则命中 → 面板展示建议动作与文案 → **人工确认** → 入队 | 规则引擎（已有）+ 人工队列（`needs_review` 已有） | 手填一段买家消息，能出命中规则与建议文案；确认后队列有任务 |
| **P2.1 IM 接线** | websocket 长连（15s 心跳、逐帧 ACK、token 过期分流）+ 消息解密落库 + 发送帧 | `docs/im-protocol.md` §1–§3；`channel-im` | 真实小号能给买家发一条文本；消息表有唯一键去重 |
| **P2.2 自动发货** | 订单源（先 CDP 读「我卖出的」兜底，接口逆向成功再换直连）+ 发卡 + 状态回写 + 幂等 `uniqueCode` | P2.1 + 订单源 | 一个测试订单从付款到发货全自动，重复触发不双发 |

> 不建议跳过 P2.0 直接做全自动：**发货是写操作且直接触达买家**，先让人确认一轮，把文案与规则调对再放开。

### 4.2 并行项（按性价比排序）

| 事项 | 做什么 | 为什么现在做 | 卡点 |
| --- | --- | --- | --- |
| 类目矩阵 + APP 扫码兜底（A3） | 补测期刊/杂志、生活百科；检测到二维码提示就截图并存为待人工扫码 | 类目矩阵目前**卡死发布覆盖面**，这是唯一出路 | 需要真机点几次，且必须用测试小号 |
| 批量上架 | 草稿批次 → 队列 → 串行 → 失败隔离；先在草稿层挡掉「不支持类目」 | 单件已通，批量是量的来源 | 受上面类目矩阵限制；只成功过一次，先别宣称稳定 |
| 文案 skill 接 agent | 配 `customSkillDirs`，跑「文案 → `xy_publish_draft` dry-run → 人审 → enqueue」 | 已有 2 个 skill，接一下就有产出 | `customSkillDirs` 在 DSH 里的具体接法未验证 |
| 地址库 | 首次抓常用地址列表落库 + 别名表（家/公司） | 现在每个地址都可能失败 | 需要真机抓一次列表 |
| 修 `xy_task_action` 门禁口径 | 裁决：本地队列流转（ack/fail/release）不算写闲鱼，不挂审批门禁；把 AGENTS §4 措辞改成这个口径 | 代码与规则字面冲突，属文档债 | 无（已裁决，见 §6） |

### 4.3 需要你决定的三件事

1. **首发主打哪个**：自动发货 vs 批量上架？（决定 4.1 与 4.2 的投入顺序）
2. **目标商家形态**：纯个人号，还是要覆盖鱼小铺 / 闲管家（有企业资质）？后者才需要把 `channel-guanjia` 接上。
3. **发货接受「半自动」多久**：先人工确认跑一段时间，还是必须一步到全自动？（全自动需要先逆向订单接口）

## 5. 已知风险（别对外宣称）

- **发布只成功过一次**，且只覆盖网页端支持的类目。任何「已稳定支持批量发布」的说法都是假的。
- **地址搜索在 CDP 下不可用**（候选不回显），只能匹配常用/附近地址。
- **插件层没有类型门禁**：plugin-ops / ops-bundle 是纯 JS，改动只能靠 49 个测试兜。
- **账号风控**：遇到 `x5sec`/滑块不硬刚，停队列 + 截图 + 人工过；真人验证只用测试小号。
- **第三方材料删除流程**：`research/repos/` 仍在，删之前必须走 AGENTS §6（列清单 → 标靶点 → 等确认），不要「facts 已吸收」就删。

## 6. 这两周踩过的坑（读代码前先看）

- Edge 155 移除了 `Network.getAllCookies`，cookie 读取要按 `Storage.getCookies` 降级。
- 发布页描述是 `div[contenteditable=true]`；分类是 antd Select，**`el.click()` 打不开，必须 `Input.dispatchMouseEvent`**；价格是 3 个同 placeholder 输入框取第 1 个。
- DSH 沙箱造的 workspace junction 是坏的（`realpathSync` 返回链接自身）；重建用 `fs.rmdirSync` + `fs.symlinkSync(...,'junction')`，**删 node_modules 下链接绝不能用 `rm -rf`**（会跟随 junction 删真源码，已发生过一次）。
- `scripts/typecheck.mjs` 在本沙箱因 `spawnSync node.exe EPERM` 报错，用 DSH checkout 的 tsc 直接跑（命令见 [handoff.md](handoff.md) §4）。
- Hindsight 本机不可用（daemon 起不来、Python 无网），不要调 `hindsight_*`。

## 7. 文档怎么读

| 层 | 文档 | 什么时候读 |
| --- | --- | --- |
| **必读** | 本文（现状+下一步） · [AGENTS.md](../AGENTS.md)（硬规则） · [architecture.md](architecture.md)（已实现形态 + 发布页真机校准 §13） | 每次开工 |
| 参考 | [dev-setup.md](dev-setup.md)（怎么跑） · [component-decomposition.md](component-decomposition.md)（包边界） · [im-protocol.md](im-protocol.md) / [delivery-rules.md](delivery-rules.md)（P2 施工规格） · [client-plugin-sidebar.md](client-plugin-sidebar.md) · [p1.3-plan.md](p1.3-plan.md)（方案，执行状态看本文） · [adr/](adr/) · [end-to-end-chain-and-borrowing.md](end-to-end-chain-and-borrowing.md) | 做对应模块时 |
| 历史（只作证据，不必读） | [xianyu-ops-agent-design.md](xianyu-ops-agent-design.md) · [xianyu-4q-research.md](xianyu-4q-research.md) · [xianyu-commercial-tools-analysis.md](xianyu-commercial-tools-analysis.md) · [xianyu-wuli-kit-analysis.md](xianyu-wuli-kit-analysis.md) · [asset-extraction.md](asset-extraction.md) · [tool-failure-analysis.md](tool-failure-analysis.md) · [copywriting-and-imagegen-plan.md](copywriting-and-imagegen-plan.md)（选型） | 需要溯源时 |
