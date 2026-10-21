# 交接快照（2026-10-21 晚，P1.2 真发布跑通 + P1.3 方案落盘后）

> 给"新开一个会话"用的最短上下文。读完这页 + `AGENTS.md` + `docs/architecture.md` 就能接着干。
> 本文件由当前会话在上下文被压到约 100K 时写下；之后每个大阶段结束时更新。

## 1. 现在是什么状态

- **P1.1、P1.2 全部完成并提交**：core 契约 / 队列 / mtop 读通道 / CDP cookie / daemon HTTP + worker + 执行器 / 运行时装配 / 登录态（导入 + 扫码）/ CDP 发布步骤机 / 插件 9 个工具。
- **真发布已跑通一次（2026-10-21，测试小号）**：流程 = 传图 → 富文本文案 → 等 AI 识别分类 → 点选「电子资料」→ 价格 ¥1 → 包邮 → 点常用地址 → 提交；成功页 `https://www.goofish.com/item?id=1093817229436`，测试商品**已下架留档**。
- **类目受网页端支持矩阵限制**（关键）：电子资料 / 学习笔记 / 课业本 ✅；教材教辅 / 语言与兴趣培训 / 学习资料定制 / 文学 / 考研咨询 ❌（选中即刻提示「网页版暂不支持发布此分类，请使用闲鱼APP扫码继续发布」）。所以草稿现在支持 `category` 字段（`packages/channel-cdp/src/category.ts`，antd Select + 可信鼠标事件），发布前用 `assertCategoryPublishable` fail-closed。
- **登录态**：`npm run daemon:import-account`（从带 `--remote-debugging-port` 的浏览器读 cookie）/ `POST /accounts/import` / 插件 `xy_import_account`；**扫码登录** `npm run daemon:login` / `POST /accounts/login`（轮询 cookie，`unb`+`_m_h5_tk` 齐备才算成功，默认超时 180s）。`_m_h5_tk` 约 2h 过期，channel-mtop 过期时用 Set-Cookie 合并新 token、重签重试一次并回写 `CredentialStore`。
- **取商家 + 全量商品**：`packages/channel-mtop/src/user.ts`（`user.page.head` → encryptedUserId/昵称/在售数；`xyh.item.list` 分页 ≤20 → 商品条目，soldPrice 元转分）；`detail` 取 `sellerDO.sellerId`。
- **文案与合规**：`skills/xianyu-listing-copy`、`skills/xianyu-listing-audit`（38 违禁词 / 20 禁售类目 / 17 审核码）；生图选型与管线见 `docs/copywriting-and-imagegen-plan.md`。
- **IM 半成品**：`packages/channel-im`（帧解析 / 消息归一化 / 会话状态机，32 tests）**尚未接 daemon**。
- **测试**：`npm test` = **592 tests / 592 pass**（21 suites）；6 个 TS 包 tsc 全 0 错误（core / daemon / channel-mtop / channel-cdp / channel-guanjia / channel-im）；`node scripts/dsh-dump.mjs` 在 danger-full-access 下可跑。
- **daemon 未常驻**：面板是「静态快照 + 手动刷新」，按钮 disabled 是刻意的（DSH 宿主没有「面板按钮调 host 工具」的公开 API）。
- **技术路线**：[ADR 0003](adr/0003-publish-automation-path.md)——发布走确定性 CDP 步骤机，LLM 只做校准/归因/兜底，不进热路径。
- **方案文档**：`docs/p1.3-plan.md`（四项需求技术方案：登录态 / 取品 / 文案 skill + 生图 / 发布与发货）、`docs/end-to-end-chain-and-borrowing.md`（整条链路 + 对参考仓库的借鉴）。

## 2. 仓库地图

```
packages/core            契约：types/errors/risk/policy/items/data(store,queue)/runtime(redact,logger,limiter,circuit,credentials,config)/delivery
packages/channel-mtop    mtop：sign、callMtop（令牌过期自动刷新重试一次）、detail/polish/user（商家+全量商品）
packages/channel-cdp     真 Chrome cookie 读取 + 登录态校验 + 发布步骤机（publish.ts / category.ts / dom.ts / address.ts / form.ts / steps.ts）
packages/channel-im      IM 帧解析 + 消息归一化 + 会话状态机（未接 daemon）
packages/daemon/src/accounts.ts     登录态导入（CDP 读 cookie → CredentialStore）
packages/daemon/src/login.ts        扫码登录等待（轮询 unb + _m_h5_tk）
packages/daemon/src/cdp-publish.ts  daemon 发布通道（草稿文件 → 步骤机，默认 dry-run）
packages/channel-guanjia 闲管家开放平台客户端（MIT，附 LICENSE）
packages/daemon          HTTP + worker + executors + operations + runtime + cli
packages/plugin-ops      DSH 插件（纯 ESM JS）：9 个 xy_* 工具 + 写操作审批门禁 + client.js 面板
packages/ops-bundle      只负责把插件插进 profile 的 bundle
skills/                  xianyu-listing-copy（文案改写）与 xianyu-listing-audit（合规审核）
scripts/                 dsh-dev / dsh-shot / dsh-install / dsh-dump / test-all / typecheck
docs/                    ADR、架构、P1.3 方案、IM 协议、发货规则、资产吸收、client 插件机制
```

## 3. 待办（按优先级）

1. **自动发货（P2，用户明确要的下一块）**：`core/src/delivery.ts` 规则引擎已就绪（21 tests），`docs/im-protocol.md` 与 `channel-im` 已能解析消息；缺「订单监听 → 匹配规则 → 发卡/发文本 → 状态回写」的接线与 daemon 执行器（当前 `deliver` 仍 `UNSUPPORTED`）。
2. **批量上架调度**：单件发布已验证；批量要 deal 的是「草稿批次 → 队列 → 串行（QPS≤1）→ 失败隔离 + 幂等键」，以及类目支持性预判（先在草稿层挡掉不支持类目）。
3. **文案 skill 接进 agent 流程**：`skills/` 不会被 DSH 自动发现，需要 `customSkillDirs` 或复制到 `.dsh/skills`；接上后 agent 出文案 → `xy_publish_draft` dry-run → 人审 → enqueue。生图按 `docs/copywriting-and-imagegen-plan.md`（首选豆包 Seedream，key 走 env/settings + 脱敏）。
4. **类目支持矩阵补测**：期刊/杂志、生活百科两次点击未生效（结果不可信）；另需确认发布页是否给出「可发布类目白名单」接口，避免逐项试点。
5. **channel-im 接 daemon**：会话状态机 → IM 连接 → 消息落库，配合发货与客服。
6. **用户三问还差两个**：首发主打（自动发货 vs 批量上架）、目标商家（纯个人 vs 含鱼小铺/闲管家）。第三问"运行形态"已定 DSH 插件 + daemon 自启。
7. **雾里 3.20 安装包未找回**（87,770,486 B）：需用户重新提供或给原链接。A（v4.8.2 自动发货助手）与 B（C 搬运助手 v2.1.9）已恢复在 `research/repos/`（不入 git）。
8. **尚未逆向完成**（用户很在意，别再删）：A 的发货调用链、B 的发布/铺货调用链、C 的发布端点。见 `docs/asset-extraction.md` 与 `AGENTS.md` §6。

## 4. 常用命令

```bash
npm test                                   # 592 tests（单进程顺序跑，不能 spawn）
node 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/typescript/bin/tsc' \
  --noEmit --pretty false -p packages/<pkg>/tsconfig.json \
  --typeRoots 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/@types'

npm run daemon                             # 起 daemon（默认 127.0.0.1:47001）
npm run daemon:login -- --chrome-port 9222 # 扫码登录等待（打开 Edge 登录后自动收尾）
npm run daemon:import-account -- --chrome-port 9222   # 从本机 Chrome 导入登录态
npm run daemon:publish -- --draft .scratch/draft.json --screenshots .scratch/shots  # dry-run（加 --submit 才真提交）
npm run dsh:dev -- --fresh                 # 隔离 dev DSH 实例（127.0.0.1:47080，打印带 token URL）
npm run dsh:shot                           # headless 截图 + 断言面板
npm run dsh:shot -- --hmr                  # 断言热更新生效
npm run dsh:install                        # 装进真实 profile（--dry-run / --uninstall）
```

真机发布前先起 Edge（专用 profile，已登录测试小号）：

```powershell
Start-Process msedge.exe -ArgumentList '--remote-debugging-port=9222','--user-data-dir="D:\Github\big fish\.scratch\edge-cal\profile"','--no-first-run','about:blank'
```

## 5. 本机环境铁律（会咬人）

- 外网只有 `run_code` 里的 Node `fetch` 能出；bash/curl/python 无出口。
- 取 GitHub 文件：`api.github.com/repos/{o}/{r}/contents/...`（`Accept: application/vnd.github.raw`）或 `ghfast.top` tarball；`raw.githubusercontent` 不可用、jsdelivr 对 .py 返回 octet-stream。
- 临时文件放 `.scratch/`（已 gitignore）；`write` 工具写 `/tmp` 会被沙箱拒。
- `desktop` profile 被 Electron 独占，`dsh --profile desktop --dump-config` 直接报错；验证走隔离 dev 实例。
- Hindsight 在本机不可用（daemon 起不来、Python 无网），别调用 `hindsight_*`。
- compress 参数是 `{content:[{startId,endId,summary}]}`，不是对象映射。
- **DSH 沙箱创建的 workspace junction 是坏的**：reparse target 变成 `\??\Global\D:\...`，Node `realpathSync` 返回链接自身 → 报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING ... node_modules/@bigfish/*/src/index.ts`。若出现，用 `fs.rmdirSync(link)` + `fs.symlinkSync(target, link, 'junction')` 重建。**删 node_modules 下的链接只能用 `rmdir`/`fs.rmdirSync`，`rm -rf` 会跟随 junction 删掉真源码**（2026-10-20 曾因此删掉整个 `packages/channel-cdp`，用 `git checkout -- packages/channel-cdp` 恢复）。
- Edge 启动参数里带空格的路径必须整体加引号，否则截断出 `D:/Github/big` 垃圾目录。
- 闲鱼发布页：描述是 `div[contenteditable=true]`、图片走 `DOM.setFileInputFiles`、价格是 3 个 `input[placeholder="0.00"]`、分类是 antd Select（**必须用 `Input.dispatchMouseEvent` 可信点击，`el.click()` 打不开**）、地址候选按坐标取（`poi.get`），文本搜索在 CDP 下不回显。

## 6. 收尾清单（2026-10-21 会话，本轮 6 个 commit）

- `6efe3ea` feat(channel-cdp,daemon,plugin-ops): 发布草稿支持指定分类并接入步骤机。
- `1142975` feat(channel-mtop): 商家主页与全量商品读接口解析。
- `77e9c9f` feat(daemon): 扫码登录等待与 `POST /accounts/login`。
- `6b82dfd` docs: P1.3 技术方案、文案生图方案与发布能力更新。
- `7a01bbf` feat(channel-im): IM 帧解析、消息归一化与会话状态机（含 README，未接 daemon）。
- `10edf02` feat(skills): 闲鱼文案改写与上架合规审核 skill 集。
- 之前：`aa5aec1`（令牌刷新）、`d21c60b`/`0436729`（链路分析文档）、`21968d7`（登录态导入）。
- 全仓 592 tests / 592 pass；6 包 tsc 0 错误；工作区干净；测试商品 1093817229436 已下架。

**刻意没做**

- 没把「发布」吹成稳定能力：只成功跑通过一次，类目还受支持矩阵限制。
- 没做批量上架调度、没接 IM 到 daemon、没做生图实际调用（只出方案与选型）。
- 没动 `research/repos/`（删除前必须走 `AGENTS.md` §6 的清单 + 用户确认流程）。

**进程与环境状态**

- Edge（专用 profile `.scratch/edge-cal/profile`，已登录测试小号）在收尾时仍开在 9222；登录态在 profile 里，另已加密落库（accountId `2206569289277`，`%LOCALAPPDATA%/bigfish/credentials`，21 字段）。
- daemon 未常驻；插件已装进 desktop profile。
- 本会话 `danger-full-access`（approval 关闭），所以 `dsh:dump` 能跑、junction 正常。

**下次从哪继续**

1. P2 自动发货：先读 `docs/delivery-rules.md` + `docs/im-protocol.md` + `packages/core/src/delivery.ts`，再定 daemon 侧 `deliver` 执行器契约（写操作需幂等 + 审批门禁）。
2. 批量上架：草稿批次 → 队列 → 串行执行 → 类目预判挡单。
3. 把 `skills/` 接进 agent 流程（`customSkillDirs`），跑一遍「文案 → dry-run → 人审 → enqueue」。
