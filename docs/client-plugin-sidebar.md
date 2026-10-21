# Client 插件与侧边栏栏位（P0.5）

本文件记录「在 DSH Web GUI 侧边栏注册 big fish 栏位」的完整机制、调试方法与实测坑。
代码只有一处：`packages/plugin-ops/client.js`（手写 loader bundle、约 510 行、零依赖、无构建）。

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

### 在会话顶部 tab 栏注册视图（`conversation.view`）

第三个插槽是会话顶部那条 tab 栏（宿主自带的「对话」「轨迹」就在这）。源码核实（DSH 0.1.5-rc.2）：

| 事实 | 位置 / 取值 |
| --- | --- |
| 插槽声明 | `packages/client/ui-conversation/src/client/contract/slots.ts:156`，`kind: 'list'`、`scope: 'session'` |
| 注册 metadata | `{ name: 'conversation.view', id, order, label }`；`id` **必填**（list 项没有 id 会在注册时抛错），`order` 决定 tab 顺序（升序） |
| `label` | `SlotLabel = string | (() => string)`（`ui-slots/src/index.ts:513`）；传字符串即可，owner 用 `resolveSlotLabel` 解析 |
| 其它字段 | `locale` / `children` / `inject` 都可选：只做纯面板时不需要（不传 `locale` 就不能用 `t()`，所以 label 用纯字符串） |
| owner props | 由会话 owner 传入（`viewRequest / openView / completeViewRequest`），静态面板可以忽略 |
| 组件 | `(props) => ReactElement`，与 `main` 面板一样，`ctx.slots.register(options, Component)` |

**多模块写法（现在是两个 tab）**：一个模块 = 一个 tab + 一个面板组件。模块清单集中在 `client.js` 的
`VIEW_MODULES`，apply 时循环注册——加模块只改这一处，面板组件之间共享同一个 bundle、状态互不依赖：

```js
const VIEW_MODULES = [
  { id: 'bigfish-publish', order: 20, label: '🐟 自动发布', View: PublishBatchView },
  { id: 'bigfish-account', order: 30, label: '👤 账号', View: AccountView },
]

for (const module of VIEW_MODULES) {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: module.id,                // list 项必填，且全局唯一
    order: module.order,          // 升序排 tab
    label: module.label,
  }, module.View))
}
```

单个模块直接写 `ctx.slots.register({ name:'conversation.view', id, order, label }, View)` 也可以（等价）。注意
**插件入口仍只在侧边栏**（`sidebar.panellist` + `main`），顶部 tab 只承载模块工作台——这是 2026-10-21 的产品决定，
不要在顶部再加「插件入口」类 tab。

**可见条件（实测）**：tab 条只在会话区渲染（`ui-conversation/src/client/skeleton/ConversationSession.tsx:189-198`），并且

1. 当前会话不是 blank（`session.blank && conversationPhase === 'blank'` 时整个 header 隐藏），所以必须有一条真实会话；
2. `tabs.length > 1`（桌面端实测 header 是四条：对话 / 轨迹 / 上下文 / 🐟 自动发布，order 20 排最后）；
3. `main` 插槽当前选中的是默认 `conversation` 面板——点侧边栏 BigFish 栏位会把 `main` 换成 `bigfish`，会话连同 tab 条一起离开 DOM。
## 2. 调试（一条命令）

```sh
node scripts/dsh-dev.mjs --fresh   # 造隔离 DSH_HOME(.scratch/.dshdev)，起 web 到 127.0.0.1:47080
                                  # 注意：本沙箱禁止 junction，隔离实例只能在沙箱外起（见 §3 坑 10）
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

7. **`conversation.view` 的 tab 属于会话 header，不属于 BigFish 主面板。** 点侧边栏栏位进的是 `main`
   插槽里的 BigFish 面板（那里没有顶部 tab 条）；要看「🐟 自动发布」必须先有一条非 blank 会话
   （新建会话 / 发一条消息）并让主区域回到会话视图。`dsh-dev --fresh` 的隔离 home 里没有会话，
   截图看不到 tab 不是注册失败。
8. **list 插槽注册项必须带 `id`。** 漏了会在 `register` 时直接抛错（宿主按 id 去重与选 tab）；
   `label` 缺了只是退化成用 `id` 当文案——两者都别省。
9. **本沙箱里点不到真实 GUI 的 tab（浏览器与输入注入全被拒）。** 为了给「🐟 自动发布」拍"点开后的面板"实测：
   - Chromium 系（Chrome/Edge/Electron 自起）起不来：`platform_channel.cc:112] Check failed ... 拒绝访问 (0x5)`
     （mojo 依赖命名管道，被沙箱拒），浏览器进程随即退出；
   - Firefox nightly（解压到无空格 `%TEMP%` 再跑）`-headless -screenshot` 退出码 1/255、不产 PNG，
     `-marionette` 留进程但端口不监听；
   - 给桌面端已有窗口注入输入也不行：`SetCursorPos` → Access denied；UIA/MSAA 跨进程取控件 →
     `Access is denied`；`PostMessage` 的 `WM_MOUSEMOVE/WM_LBUTTONDOWN` 被 Chromium 忽略；
   - 而切 tab 只能点按钮、或写 localStorage 的 `dsh.conversation.<sessionId>`（`view` 字段）后重载页面
     （`ui-conversation/src/client/stores.ts:41-52`），两条都需要上面被拒的能力。
   替代做法（2026-10-21 实测拍到了面板，见下）：
   - 把桌面端窗口置前台，用 DPI-aware 的 GDI 截图（`SetProcessDpiAwarenessContext(-4)` + `CopyFromScreen`），
     会话 header 的 tab 条里能看到「🐟 自动发布」（`.scratch/shots/tabbar-crop.png`）；
   - 想拍"点开后的面板"，借 client 热更新：往 `client.js` 的 `apply` 开头临时插一段
     `window.setTimeout(() => { const hit = [...window.document.querySelectorAll('[role="tab"]')]
     .find((n) => (n.textContent ?? '').trim() === '🐟 自动发布'); if (hit) hit.click() }, 400)`
     （宿主 stat-poll 500ms → `/plugins/events` 推 graph → 页面换 bundle：不需要浏览器、不需要输入注入），
     截完图立刻把 `client.js` 还原。这段临时代码**不能进提交**（单测断言 bundle 里没有 `document.`）。
   - 产物：`.scratch/shots/bigfish-publish-tab.png`（整屏）、`.scratch/shots/bigfish-publish-panel.png`（面板裁切，
     含标题/副标题/流水线四步/草稿集/发布前校验）。
10. **新的 DSH_HOME 在本沙箱起不来（boot 阶段要建 fallback junction）。**
   `node scripts/dsh-dev.mjs --fresh` 报 `建 junction 失败 … EPERM`；手工造好 profile 后前台跑
   `dsh --profile bigfish-dev` 报 `EPERM: symlink … @deepseek-ai/dsh`，栈是
   `packages/boot/app-boot/lib/index.js:426 ensureSymlink ← healProfilesModuleFallbackLocked`。
   本沙箱禁止一切 symlink/junction（连 `%TEMP%` 下都 Access is denied），所以隔离实例只能在沙箱外起；
   `--dump-config` 不触发 heal，仍可用来核对装配。
## 4. 测试

`packages/plugin-ops/test/client-bundle.test.mjs`（16 条）：用 `vm.runInNewContext` 跑 client.js，
stub `window.__ModuleLoader__.load` 捕获注册、假 `react`（含按调用顺序分配槽位的 `useState`）、假 `ctx.slots`，断言：

- loader id 与包名一致（`@bigfish/plugin-ops`）；
- factory 懒执行：加载 bundle 时**不**调 `require`，apply 时才 require `react`；
- `apply` 通过 `inject` 注册四个项：`sidebar.panellist`（id/order/label）、`main`（key）、两个
  `conversation.view`（`bigfish-publish` order 20 label `🐟 自动发布`；`bigfish-account` order 30 label `👤 账号`）；
- 账号 tab 面板只读：文案含登录态来源、`npm run daemon:login`、`xy_accounts_list` / `xy_import_account`，
  且不含任何 cookie 值（`cookie=` / `unb=\d` / `_m_h5_tk=`）；
- 图标 `🐟`、active=true 时 opacity 1、否则 0.72、size 下限 12；
- 顶部 4 个 tab（文案生成/概览/发布/诊断），默认选中第一个，点击后内容与 `aria-selected` 同步切换；
- 标题副标题在任意 tab 都在；
- 入口按钮 disabled，并用 title 指向对应工具；
- 文案风格区 5 个 chip、默认选中 `plain`、点击后 `aria-pressed` 转移；
- 填完商品名 + 价格后「生成文案请求」可用，产出的是 `xy_copy_plan` 参数 JSON（面板不调模型）；
- 面板内嵌风格表与 `src/copy.js` 的 `COPY_STYLES` 不漂移（id/label/summary 逐项比对）；
- 「自动发布」视图：标题/副标题、流水线四步、草稿集输入框、类目矩阵、页脚「面板不执行发布」都在；
- 草稿集逐行解析：内联 JSON 合法 / JSON 坏 / 缺 `images` / `.json` 路径 / 非法行，逐行给 `data-ok` 与提示；
- 至少 2 条合法草稿才启用「生成批量发布请求」：禁用时用 title 说明原因；产出 `xy_publish_batch` 参数
  JSON（`mode` dry-run/enqueue、`draftPaths`/`drafts`、可选 `accountId`），任何输入变化都会撤销旧 JSON；
- bundle 里没有 `localStorage`、`document.`、`fetch(`（client 只能通过 ctx 拿能力，不直接摸 DOM/网络）。

## 5. 未做（P1 再评估）

- 面板还没接真实数据：现在只是占位 UI，实时状态让模型调 `xy_status` / `xy_tasks_list`。
- 文案风格区只到「可交互组请求」：选风格 → 填商品名/价格/成色 → 产出 `xy_copy_plan` 参数 JSON；**真正的文案生成在 agent 侧**（面板不联网、不调模型），谁执行与面板解耦。
- 没有服务端推送（SSE/WebSocket）到 client：P1 要展示队列进度时需要一条 daemon → 插件 → client 的通道。
- 没有 `settings` 卡片（daemonUrl / tokenPath 现在只能写 `cordis.patch.yml`）。
- 「👤 账号」tab 是只读面板：讲清登录态来源（导入 / 扫码 / 加密落盘）与两个工具入口，不读凭据、不联网；
  面板内直接点「导入 / 扫码」需要 client→host 的 rpc 通道（灰区，采用前写 ADR）。
- 「🐟 自动发布」tab 只到「生成 `xy_publish_batch` 参数 JSON」：批量入队/发布由 agent 调工具或 CLI 执行，
  面板不联网、不调 daemon（执行与 UI 解耦）。
- `scripts/dsh-shot.mjs` 还没有「点开自动发布 tab → 断言面板文案」的用例：本沙箱起不了浏览器
  （§3 坑 9），写了也验不了；真实验收这次是借热更新自动点击 + GDI 截图做的（§3 坑 9 末段），
  正式用例留给有浏览器 / danger-full-access 的环境按同一套 `clickTab` 思路补。
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

