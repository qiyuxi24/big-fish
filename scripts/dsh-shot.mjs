#!/usr/bin/env node
/**
 * 用 headless Chrome + CDP 验证 DSH Web 里的 BigFish 侧边栏栏位（截图 + 断言）。
 *
 * 为什么不用 `chrome --screenshot`：这个 SPA 常驻 WebSocket/SSE，headless 的
 * 虚拟时间永远不收敛，进程会挂死。这里改用常驻 CDP 会话：navigate → 轮询
 * Runtime.evaluate → Page.captureScreenshot → Browser.close。
 *
 * 用例：
 *   node scripts/dsh-shot.mjs                     # 截图侧边栏栏位 + 面板内容
 *   node scripts/dsh-shot.mjs --hmr               # 再验一次 client.js 热更新（不刷新页面）
 *   node scripts/dsh-shot.mjs --url <tokenUrl>    # 指定别的实例
 *   node scripts/dsh-shot.mjs --out .scratch/shots/x.png --port 9333
 *
 * 退出码：0 = 栏位/面板/热更新都符合预期；1 = 有断言失败（打印页面文本与 bundle 比对）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Cdp, launchChrome, openPage, screenshot, waitFor } from './lib/cdp.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const out = resolve(repoRoot, valueOf('--out', '.scratch/shots/bigfish-sidebar.png'))
const chromePort = Number(valueOf('--port', '9333'))
const PANEL_SUBTITLE = 'P1.3 · 文案生成 / 发布 dry-run / 登录态导入'
const PANEL_LABEL = 'BigFish 闲鱼运营'

/** 从 dev 实例日志里取最后一次 token URL。 */
function tokenUrlFromDevLog() {
  const log = join(repoRoot, '.scratch/.dshdev/run/server.log')
  const matches = [...readFileSync(log, 'utf8').matchAll(/dsh web: (http:\/\/\S+)/g)]
  if (matches.length === 0) throw new Error('日志里没有 dsh web 启动 URL；先跑 node scripts/dsh-dev.mjs')
  return matches[matches.length - 1][1]
}

/** 点掉首跑弹窗（内测声明）与缺 API Key 的提示，否则截图被遮罩。 */
async function dismissOverlays(cdp) {
  for (const label of ['继续', '稍后配置']) {
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => (node.textContent ?? '').trim() === '${label}')
      if (button) { button.click(); return true }
      return false
    })()`)
    await delay(600)
  }
}

/** 点侧边栏栏位（必须精确命中 BUTTON：外层 NAV 的 textContent 也含这个字符串，点它没有反应）。 */
async function selectPanel(cdp) {
  const clicked = await cdp.evaluate(`(() => {
    const hit = [...document.querySelectorAll('button')].find((node) => (node.getAttribute('aria-label') ?? '') === '${PANEL_LABEL}')
    if (!hit) return false
    hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    hit.click()
    return true
  })()`)
  if (clicked !== true) throw new Error('侧边栏里没有 aria-label 为「' + PANEL_LABEL + '」的按钮')
  await delay(800)
}

/** 面板正文是否已渲染（标题副标题都在说明 main 插槽挂上了）。 */
function panelRendered(cdp) {
  return cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(PANEL_SUBTITLE)})`)
}

/** 点击面板内 tab（按可见文字精确匹配）。 */
async function clickTab(cdp, label) {
  const clicked = await cdp.evaluate(`(() => {
    const hit = [...document.querySelectorAll('button[data-role="panel-tab"]')]
      .find((node) => (node.textContent ?? '').trim() === ${JSON.stringify(label)})
    if (!hit) return false
    hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    hit.click()
    return true
  })()`)
  if (clicked !== true) throw new Error('面板 tab 里找不到「' + label + '」')
  await delay(400)
}

/** 热更新用例：改 client.js → 不刷新页面 → 新文案应出现；再还原并等恢复。 */
async function checkHotUpdate(cdp, codeRef) {
  const clientPath = join(repoRoot, 'packages/plugin-ops/client.js')
  const original = readFileSync(clientPath, 'utf8')
  const marker = '热更新实测 ' + String(Date.now() % 100000)
  try {
    writeFileSync(clientPath, original.replace(PANEL_SUBTITLE, marker))
    // dsh-client-hmr：stat-poll 500ms → /plugins/events SSE → 浏览器换 fiber。
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(marker)}) ? true : null`, {
      label: 'client.js 热更新', timeoutMs: 20_000, intervalMs: 400,
    }).catch(() => null)
    if (!(await cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(marker)})`))) {
      // fiber 重挂会把主区域回落成会话页：栏位还在，点一下即恢复（见 docs/client-plugin-sidebar.md）。
      await selectPanel(cdp)
      await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(marker)}) ? true : null`, {
        label: '重新点开面板后的热更新文案', timeoutMs: 10_000, intervalMs: 300,
      })
    }
    await screenshot(cdp, out.replace(/\.png$/, '-hmr.png'))
    console.log('✔ 热更新：改 client.js 后未刷新页面，面板文案已变成「' + marker + '」')
  } finally {
    writeFileSync(clientPath, original)
  }
  // 还原也要热更新回去；还原后主区域同样会回落，重新点开确认原文案。
  await delay(2500)
  if (!(await panelRendered(cdp))) await selectPanel(cdp)
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(PANEL_SUBTITLE)}) ? true : null`, {
    label: '还原后的面板文案', timeoutMs: 15_000, intervalMs: 300,
  })
  console.log('✔ 已还原 client.js（面板文案回到「' + PANEL_SUBTITLE + '」）')
}

const url = valueOf('--url', undefined) ?? tokenUrlFromDevLog()
const browser = await launchChrome({ userDataDir: join(repoRoot, '.scratch/chrome-profile'), port: chromePort })
const browserCdp = await Cdp.connect(browser.browserWs)
let code = 0

try {
  const { cdp } = await openPage({ port: chromePort, url, settleMs: 2500 })
  await dismissOverlays(cdp)

  // 1) 侧边栏栏位（label 同时是 tooltip / 无障碍名）。
  const sidebar = await waitFor(cdp, `(() => {
    const hit = [...document.querySelectorAll('button')].find((node) => (node.getAttribute('aria-label') ?? '') === '${PANEL_LABEL}')
    return hit ? { label: hit.getAttribute('aria-label'), text: (hit.textContent ?? '').trim().slice(0, 40) } : null
  })()`, { label: '侧边栏 BigFish 栏位', timeoutMs: 40_000 })

  // 2) 点开栏位 → main 插槽换成我们的面板。
  await selectPanel(cdp)
  const panelText = await waitFor(cdp, `(() => {
    const text = document.body.innerText
    return text.includes(${JSON.stringify(PANEL_SUBTITLE)}) ? text : null
  })()`, { label: 'BigFish 面板内容', timeoutMs: 20_000 })
  // 默认 tab = 文案生成（skill 入口），先断言这一页的核心元素。
  const cards = ['文案风格（skill 注入）', '生成文案请求', '商品名', '价格（元）', '成色']
    .filter((needle) => panelText.includes(needle))

  // 3) 面板内 tab 切换：概览页出现状态卡与 daemon 地址，再切回文案页。
  const tabs = await cdp.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button[data-role="panel-tab"]')]
    if (nodes.length === 0) return null
    return {
      labels: nodes.map((node) => (node.textContent ?? '').trim()),
      selected: nodes.map((node) => node.getAttribute('aria-selected')),
    }
  })()`)
  await clickTab(cdp, '概览')
  await waitFor(cdp, `document.body.innerText.includes('127.0.0.1:47001') ? true : null`, {
    label: '概览 tab 内容', timeoutMs: 8_000, intervalMs: 200,
  })
  await clickTab(cdp, '文案生成')
  await waitFor(cdp, `document.body.innerText.includes('文案风格（skill 注入）') ? true : null`, {
    label: '切回文案 tab', timeoutMs: 8_000, intervalMs: 200,
  })

  // 4) 文案风格入口：点第二个风格芯片，断言 aria-pressed 转移（真实 React 交互，不是静态文案）。
  const styleBefore = await cdp.evaluate(`(() => {
    const chips = [...document.querySelectorAll('button[data-role="copy-style"]')]
    if (chips.length === 0) return null
    const before = chips.map((node) => node.getAttribute('aria-pressed'))
    const target = chips[1]
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    target.click()
    return { count: chips.length, before }
  })()`)
  if (styleBefore !== null) {
    await waitFor(cdp, `(() => {
      const chips = [...document.querySelectorAll('button[data-role="copy-style"]')]
      return chips.length > 1 && chips[1].getAttribute('aria-pressed') === 'true' ? true : null
    })()`, { label: '文案风格切换', timeoutMs: 8_000, intervalMs: 200 })
  }
  await screenshot(cdp, out)

  // 3) 热更新（可选）。
  if (args.includes('--hmr')) await checkHotUpdate(cdp, code)

  const summary = { sidebar, panel: { subtitle: PANEL_SUBTITLE, cards }, tabs, style: styleBefore, screenshot: out }
  console.log(JSON.stringify(summary, null, 2))
  if (cards.length < 4) {
    console.error('✖ 面板内容不完整；页面文本：\n' + panelText.slice(0, 1200))
    code = 1
  }
  if (tabs === null || tabs.labels.length !== 4 || tabs.selected[0] !== 'true') {
    console.error('✖ 面板 tab 异常（期望 5 个、默认「自动发布」）：' + JSON.stringify(tabs))
    code = 1
  }
  if (styleBefore === null || styleBefore.count !== 5) {
    console.error('✖ 文案风格入口异常（期望 5 个芯片）：' + JSON.stringify(styleBefore))
    code = 1
  }
} catch (error) {
  console.error('✖ ' + error.message)
  code = 1
} finally {
  try {
    await browserCdp.send('Browser.close')
  } catch {}
  await delay(500)
  if (browser.child.exitCode === null) browser.child.kill()
}

process.exitCode = code
