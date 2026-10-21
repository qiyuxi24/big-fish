# 本机开工手册（真机操作 + 环境状态）

> **现状与下一步不在这里**——看 [STATUS.md](STATUS.md)。本文件只放「新开会话要接着干时，机器和环境长什么样、命令怎么敲」。
> 规则看 [AGENTS.md](../AGENTS.md)，实现形态看 [architecture.md](architecture.md)。

## 1. 环境快照（2026-10-21 收尾时）

- Edge 专用 profile 在 `.scratch/edge-cal/profile`（已登录账号「同州禹斋」，accountId `2206569289277`；这是用户大号、**不是测试小号**，见 AGENTS §5 账号纪律）。
- 登录态已加密落库：`%LOCALAPPDATA%/bigfish/credentials`（21 字段）。
- daemon **未常驻**；插件已装进 desktop profile。
- 真机测试商品全部已下架：`1093817229436`、`1091938715735`、`1091940243200`（本项目名下无在售测试商品）。
- 本会话 `danger-full-access`（approval 关闭），所以 `dsh:dump` 能跑、junction 正常。

## 2. 常用命令

```bash
npm test                                   # 709 tests（单进程顺序跑，不能 spawn）
node 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/typescript/bin/tsc' \
  --noEmit --pretty false -p packages/<pkg>/tsconfig.json \
  --typeRoots 'C:/Users/34239/Documents/GitHub/deepseek-harness/node_modules/@types'

node packages/daemon/src/cli.ts            # 起 daemon（默认子命令就是 serve，别显式传；127.0.0.1:47001）
npm run daemon:login -- --chrome-port 9222 # 扫码登录等待（打开 Edge 登录后自动收尾）
npm run daemon:import-account -- --chrome-port 9222   # 从本机 Chrome 导入登录态
npm run daemon:publish -- --draft .scratch/draft.json --screenshots .scratch/shots  # dry-run（加 --submit 才真提交）
npm run dsh:dev -- --fresh                 # 隔离 dev DSH 实例（127.0.0.1:47080，打印带 token URL）
npm run dsh:shot                           # headless 截图 + 断言面板
npm run dsh:shot -- --hmr                  # 断言热更新生效
npm run dsh:install                        # 装进真实 profile（--dry-run / --uninstall）
```

单包测试：`node scripts/test-all.mjs packages/core`（前缀过滤；ops-bundle 没有测试）。

真机发布前先起 Edge（专用 profile，已登录用户大号 `2206569289277`——不是测试小号，真发须用户点头；路径带空格整体加引号）：

```powershell
Start-Process msedge.exe -ArgumentList '--remote-debugging-port=9222','--user-data-dir="D:\Github\big fish\.scratch\edge-cal\profile"','--no-first-run','about:blank'
```

## 3. 本机铁律（会咬人）

- 外网只有 `run_code` 里的 Node `fetch` 能出；bash/curl/python 无出口。
- 取 GitHub 文件：`api.github.com/repos/{o}/{r}/contents/...`（`Accept: application/vnd.github.raw`）或 `ghfast.top` tarball；`raw.githubusercontent` 不可用、jsdelivr 对 `.py` 返回 octet-stream。
- 临时文件放 `.scratch/`（已 gitignore）；`write` 工具写 `/tmp` 会被沙箱拒。
- `desktop` profile 被 Electron 独占，`dsh --profile desktop --dump-config` 直接报错；验证走隔离 dev 实例。
- Hindsight 在本机不可用（daemon 起不来、Python 无网），别调用 `hindsight_*`。
- compress 参数是 `{content:[{startId,endId,summary}]}`，不是对象映射。
- **DSH 沙箱创建的 workspace junction 是坏的**：reparse target 变成 `\??\Global\D:\...`，Node `realpathSync` 返回链接自身 → `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING ... node_modules/@bigfish/*/src/index.ts`。若出现，用 `fs.rmdirSync(link)` + `fs.symlinkSync(target, link, 'junction')` 重建。**删 node_modules 下的链接只能用 `rmdir`/`fs.rmdirSync`，`rm -rf` 会跟随 junction 删掉真源码**（2026-10-20 曾因此删掉整个 `packages/channel-cdp`，用 `git checkout -- packages/channel-cdp` 恢复）。
- Edge 启动参数里带空格的路径必须整体加引号，否则截断出 `D:/Github/big` 垃圾目录。
- 闲鱼发布页：描述是 `div[contenteditable=true]`、图片走 `DOM.setFileInputFiles`、价格是 3 个 `input[placeholder="0.00"]`、分类是 antd Select（**必须用 `Input.dispatchMouseEvent` 可信点击，`el.click()` 打不开**）、地址候选按坐标取（`poi.get`），文本搜索在 CDP 下不回显。

更多环境坑见 [AGENTS.md](../AGENTS.md) §7。

## 4. 下次开工从哪继续

1. 先读 [STATUS.md](STATUS.md) §4（主线是 P2 自动发货，P2.0 → P2.1 → P2.2 三步）。
2. 发货动手前读：[delivery-rules.md](delivery-rules.md)（规则引擎已实现）+ [im-protocol.md](im-protocol.md)（发消息帧、心跳、ACK、解密顺序都是现成的施工规格）。
3. 写操作（`deliver`）记得：幂等 `uniqueCode`、单账号写串行、失败进 `needs_review` 人工队列、审批门禁。
4. 真机验证只用已导入的账号且默认 dry-run（`2206569289277` 是用户大号，不是测试小号）；发布前确认 `BF_PUBLISH_SUBMIT` 不是误开。
