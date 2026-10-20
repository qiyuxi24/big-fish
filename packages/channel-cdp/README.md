# @bigfish/channel-cdp

CDP 会话：连 Chrome、页面操作、响应拦截、发布步骤状态机。

契约：\`docs/component-decomposition.md\` §4.2。零第三方依赖，Node 24 直接跑 TS（无构建）。

## 职责

- 连本机 Chrome 的 DevTools 协议（Node 24 全局 WebSocket），不引入 playwright/puppeteer。
- 页面操作：导航、求值、轮询等待、截图。
- **captureJson**：拦 \`Network.responseReceived\` + \`Network.getResponseBody\`，免签名读 mtop JSON（真正发请求的是页面自己）。
- 发布步骤状态机：顺序执行，失败立即停（写操作不自动重试，交给人工确认）。

## 导出

- \`resolveChromePath(env?)\` → 浏览器可执行文件路径（\`BF_CHROME\` 优先）。
- \`launchChrome(opts?)\` → \`{ target, port, close }\`，spawn headless Chrome 并等 DevTools 就绪。
- \`attachChrome(port?)\` → 附加到已开的 Chrome（用户自己的登录态）。
- \`CdpConnection\`：\`connect(wsUrl, opts?)\` / \`send\` / \`on\` / \`close\`，id 匹配、错误与超时统一 \`XianyuError('NETWORK')\`。
- \`CdpPage\`：\`open(conn, url, opts?)\` / \`navigate\` / \`evaluate\` / \`waitFor\` / \`captureJson\` / \`screenshot\` / \`close\`。
- \`runPublishSteps(page, steps, ctx)\` → \`{ok:true}\` 或 \`{ok:false, step, error}\`。
- 测试替身类型：\`WebSocketLike\` / \`WebSocketFactory\` / \`CdpConnectionLike\` / \`FetchLike\` / \`SpawnLike\`。

## 与 \`scripts/lib/cdp.mjs\` 的关系

本包是 \`scripts/lib/cdp.mjs\` 的 TS 提升版，脚本保持可独立运行（不反向依赖本包，避免
\`scripts/\` 被包名解析耦合）。两者 semantic 一致：候选路径顺序、headless 参数、\`/json/version\`
探测、\`Page.loadEventFired\` 等待、截图 base64 解码。后续改动优先落在本包，再决定脚本是否改为
import 包（需要 Node 类型擦除下解析 workspace 包名，暂不做）。

## 依赖注入点（为测试而加，契约签名之外的附加能力）

契约里 \`connect\` / \`launchChrome\` / \`attachChrome\` 没有注入参数，但测试要求「不真起 Chrome、
不发网络」，因此增加了**可选**字段/参数（不传时行为与契约完全一致）：

- \`CdpConnectionOptions.webSocketFactory\`、\`requestTimeoutMs\`
- \`LaunchChromeOptions.fetchImpl / spawnImpl / env / pollMs\`
- \`AttachChromeOptions.fetchImpl\`

\`CdpPage.open\` 的参数类型是 \`CdpConnectionLike\`（结构接口）而不是 \`CdpConnection\` 类，
方便注入脚本化假连接；\`CdpConnection\` 天然满足该接口。

## 测试范围

\`test/*.test.ts\`（\`node scripts/test-all.mjs packages/channel-cdp\`）：

1. \`launch.test.ts\`：\`resolveChromePath\` 的 BF_CHROME 优先、launch 的 URL/端口/参数拼装、close 杀进程、
   DevTools 不就绪 → NETWORK、attach 的 \`/json/version\` URL 与错误映射（全部假 fetch + 假 spawn，不真起 Chrome）。
2. \`connection.test.ts\`：假 WebSocket 下 id 匹配、错误响应 → \`XianyuError\`、请求超时 → NETWORK、
   事件分发与退订、close 拒绝在途请求。
3. \`page.test.ts\`：enable/导航顺序、evaluate、waitFor 轮询与超时、captureJson 的
   responseReceived/getResponseBody 流程与 URL 不匹配超时、截图落盘、close 幂等。
4. \`steps.test.ts\`：成功顺序、第 2 步失败后第 3 步不执行、ctx.log 调用、AbortSignal 取消。
5. \`package.test.ts\`：包内无 playwright/puppeteer、\`child_process\` 只在 \`launch.ts\`、barrel 导出契约。

测试不连真实 Chrome、不发任何网络请求，临时文件写 \`.scratch/channel-cdp/\`。
