# 交接快照（2026-10-21 凌晨，P1.2 填表链路校准完成后）

> 给"新开一个会话"用的最短上下文。读完这页 + `AGENTS.md` + `docs/architecture.md` 就能接着干。
> 本文件由当前会话在上下文被压到约 100K 时写下；之后每个大阶段结束时更新。

## 1. 现在是什么状态

- **P1.1 已完成并提交**：core 契约 / SQLite 队列与商品仓储 / mtop 读通道 / CDP cookie / daemon HTTP + worker + 执行器 / 运行时装配。
- **P1.2 代码 + 真机校准都过了（填表链路），真提交还没跑**：
  1. 登录态导入入口：`npm run daemon:import-account [--account-id X] [--chrome-port 9222]`、`POST /accounts/import`、插件工具 `xy_import_account` 三个入口，从带 `--remote-debugging-port` 的浏览器读 goofish cookie → 加密落盘；accountId 默认取 `unb`。本次实测导入测试小号「同州禹斋」（`2206569289277`，21 个字段）。手机扫码还没做。
  2. CDP 发布通道：步骤机 `packages/channel-cdp/src/publish.ts`，daemon 装配 `packages/daemon/src/cdp-publish.ts`（先比对浏览器 `unb` 防发错号）。**默认 dry-run 只填表不提交**；`npm run daemon:publish -- --draft <草稿.json> [--submit] [--screenshots dir]`；队列发布需 `BF_PUBLISH_SUBMIT=1`。
  3. 插件侧（P1.2-B）：`xy_publish_draft`（默认 dry-run 只给命令，enqueue 才入队）、`xy_import_account`、侧边栏面板刷新；共 9 个 `xy_*` 工具。
  4. 真机校准（2026-10-21，Edge 155 + CDP 9222）：dry-run 全绿，含图片/富文本/价格/地址，`durationMs≈5.1s`；选择器表、填写原理、**地址搜索在 CDP 下不回显**的限制见 `docs/architecture.md` §13。
- **测试**：`npm test` = 477 tests / 477 pass（core 131 / daemon 106 / mtop 53 / cdp 75 / guanjia 62 / plugin-ops 48 / integration 2）。5 个 TS 包 tsc --noEmit 全 0 错误（命令见 §4，`scripts/typecheck.mjs` 在本机 spawn EPERM 用不了）。
- **界面插件已可热调试**：侧边栏「BigFish 闲鱼运营」面板在隔离 dev 实例里已验证（栏位渲染 + 改 `client.js` 不刷新即换文案）。
- **插件已装进用户自己的 desktop profile**，等用户重启一次 DSH 桌面应用生效；之后改 client.js 同样热替换。
- **daemon 未常驻**：面板现在是「静态快照 + 手动刷新」，实时推送仍要 daemon 常驻方案；面板按钮 disabled 是刻意的——DSH 宿主没有「面板按钮调 host 工具」的公开 API（见 `docs/client-plugin-sidebar.md`）。
- **技术路线已定稿**：[ADR 0003](adr/0003-publish-automation-path.md)——发布走确定性 CDP 步骤机，LLM 只做校准、异常归因、人工兜底，不直接点页面；mtop 发布接口保留为将来加速通道；DSH 内置浏览器（bsk）只作兜底演示。

## 2. 仓库地图

```
packages/core            契约：types/errors/risk/policy/items/data(store,queue)/runtime(redact,logger,limiter,circuit,credentials,config)
packages/channel-mtop    只读 mtop：sign、callMtop、detail/polish 的 data 构造与解析
packages/channel-cdp     真 Chrome cookie 读取 + 登录态校验 + 发布步骤机（publish.ts）
packages/daemon/src/accounts.ts     登录态导入（CDP 读 cookie → CredentialStore），已挂 CLI 与 POST /accounts/import
packages/daemon/src/cdp-publish.ts  daemon 发布通道（草稿文件 → 步骤机，默认 dry-run），已挂 CLI publish 与 publishItem 执行器
packages/channel-guanjia 闲管家开放平台客户端（MIT，附 LICENSE）
packages/daemon          HTTP + worker + executors + operations + runtime + cli
packages/plugin-ops      DSH 插件（纯 ESM JS）：9 个 xy_* 工具 + 写操作审批门禁 + client.js 面板
packages/ops-bundle      只负责把插件插进 profile 的 bundle
scripts/                 dsh-dev / dsh-shot / dsh-install / dsh-dump / test-all / typecheck
docs/                    ADR、架构、开发说明、IM 协议、发货规则、资产吸收、client 插件机制
```

## 3. 待办（按优先级）

1. **P1.2 收尾：真发布一次（需用户点头）**。填表链路已真机 dry-run 校准（§1.4、architecture §13），剩下只有 `submit=true` 那条路：点提交 → 成功页 → 解析 item id。跑法：先用测试小号开专用 profile
   `Start-Process msedge.exe -ArgumentList '--remote-debugging-port=9222','--user-data-dir="D:\Github\big fish\.scratch\edge-cal\profile"','--no-first-run','about:blank'`，登录后
   `npm run daemon:publish -- --draft <草稿.json> --submit --screenshots .scratch/shots`。
   **没真发布成功前不得声称「发布成功」**；失败不要盲目重发（uniqueCode/itemId 幂等靠首次成功解析）。
3. **P2**：IM 协议（`docs/im-protocol.md`）+ 发货规则引擎（`docs/delivery-rules.md`）。
4. **用户三问还差两个**：首发主打（自动发货 vs 批量上架）、目标商家（纯个人 vs 含鱼小铺/闲管家）。第三问"运行形态"已定为 DSH 插件 + daemon 自启。
5. **雾里 3.20 安装包未找回**（87,770,486 B）：本地已查遍 Downloads/微信缓存/D 盘/回收站，需要用户重新提供或给原链接。A（v4.8.2 自动发货助手）与 B（C 搬运助手 v2.1.9）已恢复在 `research/repos/`（不入 git）。
6. **尚未逆向完成**（用户很在意，别再删）：A 的发货调用链、B 的发布/铺货调用链、C 的发布端点。
   见 `docs/asset-extraction.md` 与 `AGENTS.md` §6 的删除规则。
7. **用户重启 DSH 桌面应用** → 确认侧边栏出现 🐟 栏位（`npm run dsh:install -- --uninstall` 可回滚）；之后 client.js 改动能热替换。

## 4. 常用命令

```bash
npm test                                   # 477 tests（单进程顺序跑，不能 spawn）
node 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/typescript/bin/tsc' \
  --noEmit --pretty false -p packages/<pkg>/tsconfig.json \
  --typeRoots 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/@types'

npm run daemon                             # 起 daemon（默认 127.0.0.1:47001）
npm run daemon:import-account -- --chrome-port 9222   # 从本机 Chrome 导入登录态
npm run daemon:publish -- --draft .scratch/draft.json --screenshots .scratch/shots  # 发布 dry-run（加 --submit 才真提交）
npm run dsh:dev -- --fresh                 # 隔离 dev DSH 实例（127.0.0.1:47080，打印带 token URL）
npm run dsh:shot                           # headless 截图 + 断言面板
npm run dsh:shot -- --hmr                  # 断言热更新生效（改 client.js → 不刷新换文案）
npm run dsh:install                        # 装进真实 profile（--dry-run / --uninstall）
npm run dsh:dev -- --stop                  # 停 dev 实例
```

## 5. 本机环境铁律（会咬人）

- 外网只有 `run_code` 里的 Node `fetch` 能出；bash/curl/python 无出口。
- 取 GitHub 文件：`api.github.com/repos/{o}/{r}/contents/...`（`Accept: application/vnd.github.raw`）或 `ghfast.top` tarball；`raw.githubusercontent` 不可用、jsdelivr 对 .py 返回 octet-stream。
- 临时文件放 `.scratch/`（已 gitignore）；`write` 工具写 `/tmp` 会被沙箱拒。
- `desktop` profile 被 Electron 独占，`dsh --profile desktop --dump-config` 直接报错；验证走隔离 dev 实例。
- Hindsight 在本机不可用（daemon 起不来、Python 无网），别调用 `hindsight_*`。
- compress 参数是 `{content:[{startId,endId,summary}]}`，不是对象映射。
- **DSH 沙箱创建的 workspace junction 是坏的**：reparse target 变成 `\??\Global\D:\...`，Node `realpathSync` 返回链接自身 → 报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING ... node_modules/@bigfish/*/src/index.ts`（TS 不允许在 node_modules 下剥类型）。修法：`run_code` 传 `sandbox_permissions:'danger-full-access'`，无沙箱下 `fs.rmdirSync(link)` + `fs.symlinkSync(target, link, 'junction')`，target 恢复成 `\??\D:\...`。**删 node_modules 下的链接只能用 `rmdir`/`fs.rmdirSync`，`rm -rf` 会跟随 junction 删掉真源码**（2026-10-20 曾因此删掉整个 `packages/channel-cdp`，用 `git checkout -- packages/channel-cdp` 恢复）。

## 6. 收尾清单（2026-10-21 会话结束，用户已睡）

**本次提交（P1.2 校准收尾，main 上 3 个 commit）**

- `05edd61` fix(channel-cdp): cookie 读取按 `Storage.getCookies` 自动降级（Edge 155 移除了 `Network.getAllCookies`，报 `wasn't found`）。
- `7c76d70` feat(channel-cdp): 步骤机真机校准——富文本描述（`Input.insertText` + `Range` 全选 + 回读校验）、地址（真实键入 + 候选匹配 + 表单回读）、真发布必填预检、新文件 `address.ts`/`form.ts`，+13 个假页面测试。
- `63a0fa6` docs: architecture §13（选择器表 / 填写原理 / **地址搜索在 CDP 下不回显** / dry-run 记录）。
- 另：ADR 0003（发布自动化路径）与本页更新，见随后提交。
- 全仓 477 tests / 477 pass；channel-cdp 与 daemon tsc 0 错误；工作区干净。

**刻意没做（等用户决定）**

- 没跑真发布：`--submit` 会真的在测试小号上架一件 1 元商品；没用户点头不跑（ADR 0003 / AGENTS §5）。也没让任何路径声称「发布成功」。
- 没装 BrowserSkill 扩展：bsk CLI 装着但 `0 browsers connected`，扩展（Chrome 商店 `hhcmgoofomhgciiibhipgmgkgnoenaoi` / Edge 商店 `emacgiaaaiojkkpkddmmdfhmokgmnikg`）需用户自己点安装。
- 类目仍不自动选：页面 AI 识别（本次识别成「电子资料」），工具只在真发布前预检非空。

**进程与环境状态**

- 校准用的 Edge（专用 profile `.scratch/edge-cal/profile`，已登录测试小号）与 bsk daemon 已在收尾时关闭；登录态仍在 profile 目录里，下次直接复用，首次可能要重新扫码。
- 测试小号登录态已加密落库：accountId `2206569289277`，`%LOCALAPPDATA%/bigfish/credentials`（21 个字段）。
- daemon 未常驻；插件已装进 desktop profile（用户重启后生效）。

**下次从哪继续**

1. 用户同意后跑真发布：`npm run daemon:publish -- --draft .scratch/pubtest/draft-addr.json --submit --screenshots .scratch/pubtest/shots-submit --account-id 2206569289277`（先按 §3.1 起 Edge）。跑完记录 itemId、成功页 URL、商品是否出现在主页，然后马上在 App 里下架。
2. P2：IM 协议 + 发货规则（`docs/im-protocol.md`、`docs/delivery-rules.md`；core 的 `delivery.ts` 已是纯函数引擎，等通道接上）。
3. 用户三问里还差两个（首发主打、目标商家）；运行形态已定 DSH 插件 + daemon 自启。
