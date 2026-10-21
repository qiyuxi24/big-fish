# Client 插件与侧边栏栏位（P0.5）

本文件记录「在 DSH Web GUI 侧边栏注册 big fish 栏位」的完整机制、调试方法与实测坑。
代码只有一处：`packages/plugin-ops/client.js`（手写、4KB、零依赖、无构建）。

## 1. 机制（源码核实，DSH 0.1.5-rc.2）

宿主 `packages/client/modules/src/index.ts` 扫描**已激活的 loader entry**：entry 的包名必须等于
loader 登记的 `options.name`、fiber 存在且未 disabled；然后读该包 `package.json` 的
`dsh.client` 与 `exports["./client"]`，把 bundle 文件按包名的单资源 / combo 路由下发。
缺 bundle 会抛 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。

所以一个包要"有前端"，需要三件事：

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js", "./cordis.patch.yml": "./cordis.patch.yml" },
  "dsh": { "client": { "platform": "web", "inject": [] } }
}
```

### bundle 格式（唯一被执行的形态）

```js
window.__ModuleLoader__.load({
  id: '@bigfish/plugin-ops',          // 必须等于 loader entry 的包名
  factory: (require) => {             // materialization 时执行一次
    const react = require('react')
    // ...
    return { apply, inject: ['slots'] }
  },
})
```

- **id 不匹配**会报 `bundle <url> loaded without registering "<id>"`。
- 可 `require` 的平台静态模块**只有 9 个**（`packages/client/web/src/seed.ts` 的 `getStaticModules()`）：
  `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
  其它一律 require 不到——想用 UI 组件库就得落进这 9 个模块。

### 注册侧边栏栏位 + 主区域

两个插槽必须成对注册，否则点栏位会抛 `layout.selectPanel: main panel "<id>" is not registered`：

| 插槽 | 声明位置 | 注册 metadata |
| --- | --- | --- |
| `sidebar.panellist` | `packages/client/ui-sidebar/src/client/contract/slots.ts:32` | `{ name, id, order, label }`，label 同时是可见文本 / 无障碍名 / 折叠 tooltip |
| `main` | `packages/client/ui-layout/src/client/index.ts:66`（keyed） | `{ name: 'main', key: <id> }` |

用 `ctx.slots.inject(name, () => ctx.slots.register(...))` 包住注册：等插槽声明就绪再注册，
直接 register 早于声明会在加载期抛错。插槽由 ui-sidebar / ui-layout 声明，所以插件
`inject` 要包含 `'slots'`。

## 2. 调试（一条命令）

```sh
node scripts/dsh-dev.mjs --fresh   # 造隔离 DSH_HOME(.scratch/.dshdev)，起 web 到 127.0.0.1:47080
node scripts/dsh-shot.mjs          # headless Chrome 通过 CDP 打开、点栏位、断言面板、截图
node scripts/dsh-shot.mjs --hmr    # 改 client.js → 断言不刷新页面就换文案 → 自动还原
node scripts/dsh-dev.mjs --stop    # 停实例
```

- `dsh-dev.mjs`：写 profile（bundles = base + `@bigfish/ops-bundle` + web-app）、junction 借本机
  `~/.dsh/profiles/node_modules`（dsh-base 装在那里）、detached spawn `dsh --profile bigfish-dev --no-open`、
  从日志取 `dsh web: <url>` → token 换 `dsh-auth-*` cookie（要求 303）→ 抓 `globalThis["__DSH_BOOT__"]`
  断言 `@bigfish/plugin-ops` 在 entries 里。
- `dsh-shot.mjs`：零依赖 CDP（`scripts/lib/cdp.mjs`）。先关掉首跑弹窗（「继续」= 内测声明，
  「稍后配置」= 隔离 home 缺 API Key），再点栏位、断言副标题与卡片文案、`Page.captureScreenshot`。
- 截图落 `.scratch/shots/bigfish-sidebar.png`（`--hmr` 另存 `-hmr.png`）。

## 3. 实测坑（都踩过，别再踩）

1. **点栏位必须精确匹配 `button[aria-label="BigFish 闲鱼运营"]`。** 外层 `<nav aria-label="全局面板">`
   的 `textContent` 也含这段文字，按文本匹配会先命中 NAV，`click()` 毫无反应——表现为"点了没换面板"。
   命中后还要派发 `pointerdown/mousedown/click`（React 合成事件）。
2. **单资源 bundle 路由是 404，正常。** `GET /plugins/@bigfish/plugin-ops/client.js` 与带 rev 的
   单资源路径都 404；只有 combo `GET /plugins/??@bigfish/plugin-ops/client.js&rev=<rev>` 返回 200。
   验证热更新要取 combo 路径。
3. **`chrome --headless=new --virtual-time-budget=... --screenshot` 会挂死。** 页面常驻 WebSocket/SSE，
   虚拟时间永不收敛。用常驻 headless + CDP 截屏。
4. **热更新后主区域会回落到会话欢迎页。** HMR 拆掉 fiber 重挂，侧边栏行还在，但 ui-layout 的
   activePanelId 被重置；此时再点一次栏位即显示新文案。`ctx.layout` 只有写接口
   （`selectPanel/toggleSidebar/openRightbar/closeRightbar`），**没有读 activePanelId 的 API**，
   所以插件无法在 apply 里自动恢复选择——这是已知代价，不是 bug。
5. **Windows 上脚本结束不要 `process.exit()`。** fetch 连接关闭时会崩
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c, line 76`；
   设 `process.exitCode` 让它自然退出。
6. **vm 单测里跨沙箱对象原型不同。** 用 `node:vm` 执行 bundle 后，注册进去的对象不是宿主 realm 的对象，
   `assert.deepStrictEqual` 整对象比较会失败；逐字段 `assert.equal`。函数组件要手动渲染
   （`if (typeof node.type === 'function') return toText(node.type(node.props))`）才能取文本。

## 4. 测试

`packages/plugin-ops/test/client-bundle.test.mjs`（11 条）：用 `vm.runInNewContext` 跑 client.js，
stub `window.__ModuleLoader__.load` 捕获注册、假 `react`（含按调用顺序分配槽位的 `useState`）、假 `ctx.slots`，断言：

- 只注册一个 id，且 id 与 loader entry 包名一致；
- factory 懒执行：加载 bundle 时**不**调 `require`，apply 时才 require `react`；
- `apply` 通过 `inject` 注册 `sidebar.panellist`（id/order/label）与 `main`（key）；
- 图标 `🐟`、active=true 时 opacity 1、否则 0.72、size 下限 12；
- 顶部 4 个 tab（文案生成/概览/发布/诊断），默认选中第一个，点击后内容与 `aria-selected` 同步切换；
- 标题副标题在任意 tab 都在；
- 入口按钮 disabled，并用 title 指向对应工具；
- 文案风格区 5 个 chip、默认选中 `plain`、点击后 `aria-pressed` 转移；
- 填完商品名 + 价格后「生成文案请求」可用，产出的是 `xy_copy_plan` 参数 JSON（面板不调模型）；
- 面板内嵌风格表与 `src/copy.js` 的 `COPY_STYLES` 不漂移（id/label/summary 逐项比对）；
- bundle 里没有 `localStorage`、`document.`、`fetch(`（client 只能通过 ctx 拿能力，不直接摸 DOM/网络）。

## 5. 未做（P1 再评估）

- 面板还没接真实数据：现在只是占位 UI，实时状态让模型调 `xy_status` / `xy_tasks_list`。
- 文案风格区只到「可交互组请求」：选风格 → 填商品名/价格/成色 → 产出 `xy_copy_plan` 参数 JSON；**真正的文案生成在 agent 侧**（面板不联网、不调模型），谁执行与面板解耦。
- 没有服务端推送（SSE/WebSocket）到 client：P1 要展示队列进度时需要一条 daemon → 插件 → client 的通道。
- 没有 `settings` 卡片（daemonUrl / tokenPath 现在只能写 `cordis.patch.yml`）。
## 6. 热调试：在真实 DSH 里看到自己改的效果

两条路，按需选。

### A. 隔离 dev 实例（推荐日常改 UI 用，不碰你正在用的 DSH）

```bash
npm run dsh:dev -- --fresh          # 造 .scratch/.dshdev 隔离 DSH_HOME 并启动，默认 47080
npm run dsh:shot -- --hmr           # 可选：headless 自检 + 热更新断言 + 截图
npm run dsh:dev -- --stop           # 停
```

启动会打印带 token 的 URL（`http://127.0.0.1:47080/?token=…`），用浏览器打开即可。这个实例
只装 `dsh-base + @bigfish/ops-bundle + dsh-web-app`，与你的日常 profile 完全隔离，改坏了不影响你。
改 `packages/plugin-ops/client.js` 保存 → 页面**不刷新**即换新版（`dsh-client-hmr` stat-poll）。

### B. 装进你自己的 DSH profile（日常使用，重启一次）

```bash
npm run dsh:install                      # 默认 profile: desktop（~/.dsh/profiles/desktop）
npm run dsh:install -- --dry-run         # 只看改动
npm run dsh:install -- --uninstall       # 撤销
```

脚本做的事（`scripts/dsh-install.mjs`，幂等）：

1. profile `package.json` 的 `dependencies` 加 `"@bigfish/ops-bundle": "link:<repo>/packages/ops-bundle"`；
2. 把 `@bigfish/ops-bundle` 插进 `dsh.profile.bundles`（`dsh-base` 之后、`dsh-web-app` 之前）；
3. 在 profile 的 `node_modules/@bigfish/` 下建两个 junction 指向本仓 `packages/{ops-bundle,plugin-ops}`；
4. 改动前备份成 `package.json.bak-bigfish-<ts>`。

**装完必须完全退出并重开 DSH 桌面应用一次**（bundle 列表只在启动时读取）。之后侧边栏出现
「BigFish 闲鱼运营」（🐟），并且**继续改 `client.js` 同样热替换、不用再重启**。

为什么不用 `dsh plugin --profile desktop add`：它转发 pnpm，而 `ops-bundle` 依赖
`@bigfish/plugin-ops: workspace:*`，profile 侧解析不了 workspace 协议（离线也无 registry）。
junction + 手写 bundle 行是等价结果，且可控可回滚。

注意：`desktop` profile 由 Electron 独占管理，`dsh --profile desktop --dump-config` 会直接拒绝
（`profile "desktop" is managed exclusively by the Electron application`），所以装完无法用 CLI 预检，
只能靠重启后的界面确认；dev 实例（A）承担 CI 式验证。

