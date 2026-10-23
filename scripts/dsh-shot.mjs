#!/usr/bin/env node
/**
 * 用 headless Chrome + CDP 验证 DSH Web 里的 BigFish 侧边栏面板（截图 + 断言）。
 *
 * 为什么不用 `chrome --screenshot`：这个 SPA 常驻 WebSocket/SSE，headless 的
 * 虚拟时间永远不收敛，进程会挂死。这里改用常驻 CDP 会话：navigate → 轮询
 * Runtime.evaluate → Page.captureScreenshot → Browser.close。
 *
 * 用例：
 *   node scripts/dsh-shot.mjs                     # 截图并断言 6 个 tab 的关键元素
 *   node scripts/dsh-shot.mjs --hmr               # 再验一次 client.js 热更新（不刷新页面）
 *   node scripts/dsh-shot.mjs --url <tokenUrl>    # 指定别的实例
 *   node scripts/dsh-shot.mjs --out .scratch/shots/x.png --port 9333
 *
 * 断言口径：只断言「结构 + 契约」（data-role 存在、tab 数、文案不变的部分）。
 * daemon 在不在线都能跑：在线时账号表要出徽标，离线时只要求降级文案出现。
 * 退出码：0 = 都符合预期；1 = 有断言失败（打印页面文本）。
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
const PANEL_SUBTITLE = '发布 / 账号 / 文案 / 采集 · 面板只组参数，执行交给 agent 与 daemon'
const PANEL_LABEL = 'BigFish 闲鱼运营'
const TAB_LABELS = ['自动发布', '账号', '文案', '采集', '概览', '诊断']
const OFFLINE_TEXT = '未连接后台（daemon 未启动）'

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
  await delay(500)
}

/** 读某个 data-role 元素的文本（没有则 null）。 */
async function roleText(cdp, role) {
  return cdp.evaluate(`(() => {
    const hit = document.querySelector('[data-role="${role}"]')
    return hit === null ? null : (hit.innerText ?? '').trim()
  })()`)
}

/** 读某类 data-role 元素的文本数组。 */
async function roleTexts(cdp, role) {
  return cdp.evaluate(`(() => [...document.querySelectorAll('[data-role="${role}"]')].map((node) => (node.innerText ?? '').trim()))()`)
}

/** 热更新用例：改 client.js → 不刷新页面 → 新文案应出现；再还原并等恢复。 */
async function checkHotUpdate(cdp) {
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
const problems = []

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
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(PANEL_SUBTITLE)}) ? true : null`, {
    label: 'BigFish 面板内容', timeoutMs: 20_000,
  })

  // 3) tab 条：6 个、默认「自动发布」。
  const tabs = await cdp.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button[data-role="panel-tab"]')]
    return {
      labels: nodes.map((node) => (node.textContent ?? '').trim()),
      selected: nodes.map((node) => node.getAttribute('aria-selected')),
    }
  })()`)
  if (tabs.labels.join('|') !== TAB_LABELS.join('|')) problems.push('tab 条与预期不同：' + JSON.stringify(tabs.labels))
  if (tabs.selected[0] !== 'true') problems.push('默认 tab 不是「自动发布」：' + JSON.stringify(tabs.selected))

  // 4) 自动发布（默认 tab）：daemon 状态块 + 工作流树 + 流水线 + 草稿集。
  const daemonState = await roleText(cdp, 'daemon-state')
  if (daemonState === null) problems.push('自动发布页没有 data-role=daemon-state')
  const workflowTree = await roleText(cdp, 'workflow-tree')
  if (workflowTree === null) problems.push('自动发布页没有 data-role=workflow-tree（工作流区）')
  const publishText = await cdp.evaluate('document.body.innerText')
  for (const needle of ['进程管理', '流水线', '草稿集', '发布前校验']) {
    if (!publishText.includes(needle)) problems.push('自动发布页缺少「' + needle + '」')
  }
  const manage = await cdp.evaluate(`(() => [...document.querySelectorAll('[data-role="daemon-start"],[data-role="daemon-stop"]')].map((node) => node.getAttribute('data-role')))()`)
  if (!manage.includes('daemon-start') || !manage.includes('daemon-stop')) problems.push('进程管理按钮缺失：' + JSON.stringify(manage))
  const daemonOnline = daemonState !== null && daemonState.includes('在线')
  if (!daemonOnline && daemonState !== null && !daemonState.includes(OFFLINE_TEXT)) {
    problems.push('daemon 状态块既不是在线也不是离线降级：' + daemonState.slice(0, 120))
  }
  await screenshot(cdp, out)

  // 5) 账号 tab：daemon 在线时应有账号表与徽标；离线时只要求降级提示。
  await clickTab(cdp, '账号')
  await delay(1500)
  const accountTable = await roleText(cdp, 'account-table')
  const accountOffline = await roleText(cdp, 'account-offline')
  const rows = await roleTexts(cdp, 'account-row')
  const badges = await roleTexts(cdp, 'account-status')
  let badge = null
  if (accountOffline === null) {
    if (accountTable === null) problems.push('账号 tab 没有 data-role=account-table，也没有 offline 降级')
    if (rows.length === 0) problems.push('账号 tab 没有账号行（daemon 在线时至少应有 1 个已导入账号）')
    const verifyButton = await cdp.evaluate(`document.querySelector('[data-role="account-verify"]') !== null`)
    if (!verifyButton) problems.push('账号行没有「检测」按钮（data-role=account-verify）')
    // 进 tab 会自动 verify：等徽标从「检测中」落定（最多 30s，真实 mtop 调用）。
    const settled = await waitFor(cdp, `(() => {
      const node = document.querySelector('[data-role="account-status"]')
      if (node === null) return null
      const text = (node.innerText ?? '').trim()
      return text === '' || text === '检测中' ? null : text
    })()`, { label: '账号徽标落定', timeoutMs: 30_000, intervalMs: 500 }).catch(() => null)
    badge = settled ?? (badges.length > 0 ? badges[0] : null)
    if (badge === null || !/在线|已过期|无法确认|未检测/.test(String(badge))) problems.push('账号徽标未落定或文案异常：' + JSON.stringify(badge))
    if (badge !== null && badge !== '在线' && !String(badge).includes('已过期') && !String(badge).includes('无法确认')) {
      problems.push('账号徽标不是已知文案：' + String(badge))
    }
  }
  const checkedAt = await roleText(cdp, 'account-checked')
  const updatedAt = await roleText(cdp, 'account-updated')
  await screenshot(cdp, out.replace(/\.png$/, '-account.png'))

  // 6) 概览：导入登录态入口与 daemon 地址。
  await clickTab(cdp, '概览')
  const overviewText = await cdp.evaluate('document.body.innerText')
  for (const needle of ['xy_import_account', '127.0.0.1:47001']) {
    if (!overviewText.includes(needle)) problems.push('概览页缺少「' + needle + '」')
  }

  // 7) 文案：5 个风格芯片，点第二个断 aria-pressed 转移（真实 React 交互）。
  await clickTab(cdp, '文案')
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
  if (styleBefore === null || styleBefore.count !== 5) problems.push('文案风格芯片异常（期望 5 个）：' + JSON.stringify(styleBefore))
  else {
    await waitFor(cdp, `(() => {
      const chips = [...document.querySelectorAll('button[data-role="copy-style"]')]
      return chips.length > 1 && chips[1].getAttribute('aria-pressed') === 'true' ? true : null
    })()`, { label: '文案风格切换', timeoutMs: 8_000, intervalMs: 200 })
  }

  // 8) 采集 + 诊断：只断契约文案（不联网）。
  await clickTab(cdp, '采集')
  const referenceText = await cdp.evaluate('document.body.innerText')
  if (!referenceText.includes('xy_reference_collect')) problems.push('采集页缺少 xy_reference_collect')
  await clickTab(cdp, '诊断')
  const diagnoseText = await cdp.evaluate('document.body.innerText')
  for (const needle of ['xy_status', 'xy_ping']) {
    if (!diagnoseText.includes(needle)) problems.push('诊断页缺少「' + needle + '」')
  }
  if (await roleText(cdp, 'daemon-state') === null) problems.push('诊断页没有 daemon 状态块')

  // 9) 热更新（可选）。
  if (args.includes('--hmr')) await checkHotUpdate(cdp)

  const summary = {
    sidebar,
    tabs,
    daemon: { online: daemonOnline, state: (daemonState ?? '').split('\n').slice(0, 3).join(' | ') },
    account: { rows: rows.length, badge, checkedAt, updatedAt, offline: accountOffline },
    publishText: publishText.slice(0, 120),
    screenshots: [out, out.replace(/\.png$/, '-account.png')],
    problems,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (problems.length > 0) {
    console.error('✖ 断言失败：\n- ' + problems.join('\n- '))
    code = 1
  } else {
    console.log('✔ 面板 6 个 tab 的结构与契约都符合预期' + (daemonOnline ? '（daemon 在线，账号徽标：' + String(badge) + '）' : '（daemon 离线，走降级分支）'))
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
