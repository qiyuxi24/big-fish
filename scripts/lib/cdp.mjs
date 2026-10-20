/**
 * 极简 CDP 客户端（仅用 Node 24 全局 WebSocket / fetch，零依赖）。
 *
 * 为什么需要它：`chrome --headless=new --screenshot` 遇到带长连接 WebSocket 的 SPA
 * 会一直挂住（虚拟时间不收敛），无法截图也读不到 DOM。这里改成常驻 headless
 * 浏览器 + DevTools 协议：自己 navigate、轮询 evaluate、截图，用完 Browser.close。
 *
 * 用途：本地开发时验证 DSH Web 的侧边栏栏位、面板渲染、client 插件热更新。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const CHROME_CANDIDATES = [
  process.env.BF_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

/** 找浏览器可执行文件；找不到抛错（不要静默降级到别的方式）。 */
export function resolveChrome() {
  for (const path of CHROME_CANDIDATES) {
    if (typeof path === 'string' && path !== '' && existsSync(path)) return path
  }
  throw new Error('找不到 Chrome/Edge；用 BF_CHROME 环境变量指定可执行文件')
}

/** 起 headless 浏览器并等 DevTools 就绪；返回 {port, browserWs, kill}。 */
export async function launchChrome({ userDataDir, port }) {
  const chrome = resolveChrome()
  mkdirSync(userDataDir, { recursive: true })
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1280,900',
    '--remote-debugging-port=' + String(port),
    '--user-data-dir=' + userDataDir,
    'about:blank',
  ], { stdio: 'ignore', detached: false })

  const deadline = Date.now() + 30_000
  let version
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + String(port) + '/json/version', { signal: AbortSignal.timeout(1500) })
      if (response.ok) {
        version = await response.json()
        break
      }
    } catch {}
    await delay(200)
  }
  if (version === undefined) {
    child.kill()
    throw new Error('headless 浏览器 30s 内没起来（端口 ' + String(port) + '）')
  }
  return { child, port, browserWs: version.webSocketDebuggerUrl }
}

/** 一个 CDP 连接：send(method, params) + on(event) + close()。 */
export class Cdp {
  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败：' + wsUrl)), { once: true })
    })
    return new Cdp(socket)
  }

  #socket
  #nextId = 0
  #pending = new Map()
  #listeners = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id)
        if (pending === undefined) return
        this.#pending.delete(message.id)
        if (message.error !== undefined) pending.reject(new Error(message.error.message ?? 'CDP 错误'))
        else pending.resolve(message.result)
        return
      }
      const listeners = this.#listeners.get(message.method)
      if (listeners !== undefined) for (const listener of listeners) listener(message.params ?? {})
    })
  }

  send(method, params = {}) {
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? []
    listeners.push(listener)
    this.#listeners.set(method, listeners)
    return () => {
      const current = this.#listeners.get(method) ?? []
      this.#listeners.set(method, current.filter((item) => item !== listener))
    }
  }

  /** 求值一段表达式（awaitPromise + 返回 JSON 值）。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error('页面求值异常：' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
    }
    return result.result.value
  }

  close() {
    this.#socket.close()
  }
}

/** 在新标签页打开 url，等到 load 事件 + 额外 settleMs。 */
export async function openPage({ port, url, settleMs = 1500 }) {
  const response = await fetch('http://127.0.0.1:' + String(port) + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
  if (!response.ok) throw new Error('新建标签页失败：HTTP ' + String(response.status))
  const target = await response.json()
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', () => resolve()))
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url })
  await Promise.race([loaded, delay(15_000)])
  await delay(settleMs)
  return { cdp, targetId: target.id }
}

/** 轮询页面表达式直到返回真值。 */
export async function waitFor(cdp, expression, { timeoutMs = 20_000, intervalMs = 300, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = String(error).slice(0, 200)
    }
    await delay(intervalMs)
  }
  throw new Error('等待超时：' + label + '（最后结果 ' + String(last) + '）')
}

/** 截图到文件（整页可视区域）。 */
export async function screenshot(cdp, filePath) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(filePath, Buffer.from(result.data, 'base64'))
  return filePath
}
