# 交接快照（2026-10-20 深夜）

> 给"新开一个会话"用的最短上下文。读完这页 + `AGENTS.md` + `docs/architecture.md` 就能接着干。
> 本文件由当前会话在上下文被压到约 100K 时写下；之后每个大阶段结束时更新。

## 1. 现在是什么状态

- **P1.1 已完成并提交**：core 契约 / SQLite 队列与商品仓储 / mtop 读通道 / CDP cookie / daemon HTTP + worker + 执行器 / 运行时装配。
- **P1.2 第一步已完成（登录态导入入口）**：`npm run daemon:import-account [--account-id X] [--chrome-port 9222]` 或 `POST /accounts/import` 从本机带 `--remote-debugging-port` 的 Chrome 读 goofish cookie → 加密落盘；accountId 默认取 `unb`。GUI 按钮/扫码还没做；CDP 发布步骤未开始。
- **测试**：`npm test` = 396 tests / 396 pass。5 个 TS 包 tsc --noEmit 全 0 错误（命令见 §4，`scripts/typecheck.mjs` 在本机 spawn EPERM 用不了）。
- **界面插件已可热调试**：侧边栏「BigFish 闲鱼运营」面板在隔离 dev 实例里已验证（栏位渲染 + 改 `client.js` 不刷新即换文案）。
- **插件已装进用户自己的 desktop profile**，等用户重启一次 DSH 桌面应用生效；之后改 client.js 同样热替换。
- **daemon 未常驻**：面板是静态占位，实时数据要 P1.2 做 daemon → 插件 → client 推送。

## 2. 仓库地图

```
packages/core            契约：types/errors/risk/policy/items/data(store,queue)/runtime(redact,logger,limiter,circuit,credentials,config)
packages/channel-mtop    只读 mtop：sign、callMtop、detail/polish 的 data 构造与解析
packages/channel-cdp     真 Chrome cookie 读取 + 登录态校验（发布步骤尚未实现）
packages/daemon/src/accounts.ts  登录态导入（CDP 读 cookie → CredentialStore），已挂 CLI 与 POST /accounts/import
packages/channel-guanjia 闲管家开放平台客户端（MIT，附 LICENSE）
packages/daemon          HTTP + worker + executors + operations + runtime + cli
packages/plugin-ops      DSH 插件（纯 ESM JS）：7 个 xy_* 工具 + 写操作审批门禁 + client.js 面板
packages/ops-bundle      只负责把插件插进 profile 的 bundle
scripts/                 dsh-dev / dsh-shot / dsh-install / dsh-dump / test-all / typecheck
docs/                    ADR、架构、开发说明、IM 协议、发货规则、资产吸收、client 插件机制
```

## 3. 待办（按优先级）

1. **用户重启 DSH 桌面应用** → 确认侧边栏出现 🐟 栏位（`npm run dsh:install -- --uninstall` 可回滚）。
2. **P1.2**：CDP 发布步骤（`channel-cdp` 的 `PublishStep`）+ 图片上传；登录态导入入口（cookie）已完成，二维码/GUI 按钮未做。
   完成后 `executors.publishItem` 才能从 `UNSUPPORTED` 变成真发布。真机验证需要用户：Chrome 带 `--remote-debugging-port=9222` 启动、登录测试小号。
3. **P2**：IM 协议（`docs/im-protocol.md`）+ 发货规则引擎（`docs/delivery-rules.md`）。
4. **用户三问还差两个**：首发主打（自动发货 vs 批量上架）、目标商家（纯个人 vs 含鱼小铺/闲管家）。第三问"运行形态"已定为 DSH 插件 + daemon 自启。
5. **雾里 3.20 安装包未找回**（87,770,486 B）：本地已查遍 Downloads/微信缓存/D 盘/回收站，需要用户重新提供或给原链接。A（v4.8.2 自动发货助手）与 B（C 搬运助手 v2.1.9）已恢复在 `research/repos/`（不入 git）。
6. **尚未逆向完成**（用户很在意，别再删）：A 的发货调用链、B 的发布/铺货调用链、C 的发布端点。
   见 `docs/asset-extraction.md` 与 `AGENTS.md` §6 的删除规则。

## 4. 常用命令

```bash
npm test                                   # 396 tests（单进程顺序跑，不能 spawn）
node 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/typescript/bin/tsc' \
  --noEmit --pretty false -p packages/<pkg>/tsconfig.json \
  --typeRoots 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/@types'

npm run daemon                             # 起 daemon（默认 127.0.0.1:47001）
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
