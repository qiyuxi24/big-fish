#!/usr/bin/env node
/**
 * 在隔离 DSH_HOME 里起一个可**热调试**的 DSH Web 实例（BigFish 侧边栏面板）。
 *
 * 为什么不用用户自己的 ~/.dsh：那会改到你正在用的 GUI 插件树。这里造
 * `.scratch/.dshdev/profiles/bigfish-dev`（bundles 里插 @bigfish/ops-bundle），
 * 再用独立端口起一个 web 进程；dsh-client-hmr 会 stat-poll 本仓的
 * `packages/plugin-ops/client.js`，所以改完保存、页面不刷新即换新版面板。
 *
 * 认证：`dsh web` 启动会打印带 token 的 URL，首访把 token 换成 dsh-auth-* cookie；
 * 本脚本自己完成这次交换，后续请求都带 cookie（无 cookie 是 401）。
 *
 * 用法：
 *   node scripts/dsh-dev.mjs                 # 起服务（默认 127.0.0.1:47080）
 *   node scripts/dsh-dev.mjs --port 47090    # 换端口
 *   node scripts/dsh-dev.mjs --fresh         # 丢掉旧 DSH_HOME 重建
 *   node scripts/dsh-dev.mjs --stop          # 停掉后台实例
 *   node scripts/dsh-dev.mjs --check         # 只检查已在跑的实例（不起新进程）
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureProfile } from './lib/dsh-profile.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const port = Number(valueOf('--port', '47080'))
const dshHome = join(repoRoot, '.scratch/.dshdev')
const stateDir = join(dshHome, 'run')
const pidPath = join(stateDir, 'server.pid')
const logPath = join(stateDir, 'server.log')
const baseUrl = 'http://127.0.0.1:' + String(port) + '/'

/** 从日志里找最后一次 `dsh web: <url>` 打印的带 token URL。 */
function readTokenUrl() {
  if (!existsSync(logPath)) return undefined
  const matches = [...readFileSync(logPath, 'utf8').matchAll(/dsh web: (http:\/\/\S+)/g)]
  return matches.length === 0 ? undefined : matches[matches.length - 1][1]
}

/** 用 token URL 换 dsh-auth-* cookie（303 响应带 Set-Cookie）。 */
async function authenticate(tokenUrl) {
  let response
  try {
    response = await fetch(tokenUrl, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
  } catch (error) {
    return { reason: String(error).slice(0, 120) }
  }
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const cookie = setCookies.map((value) => value.split(';')[0]).join('; ')
  if (cookie === '' || response.status !== 303) return { reason: 'token 交换失败：HTTP ' + String(response.status) }
  return { cookie }
}

/** 带 cookie 的 GET。 */
function get(url, cookie) {
  return fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(8000) })
}

/** 等服务就绪：token 交换成功且首页 200。 */
async function waitReady(deadlineMs) {
  const started = Date.now()
  let reason = '日志里还没有 dsh web 启动 URL'
  while (Date.now() - started < deadlineMs) {
    const tokenUrl = readTokenUrl()
    if (tokenUrl !== undefined) {
      const auth = await authenticate(tokenUrl)
      if (auth.cookie !== undefined) {
        try {
          const response = await get(baseUrl, auth.cookie)
          if (response.ok) return { cookie: auth.cookie, tokenUrl }
          reason = '首页 HTTP ' + String(response.status)
        } catch (error) {
          reason = String(error).slice(0, 120)
        }
      } else {
        reason = auth.reason ?? 'token 交换失败'
      }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('服务未就绪，最后原因：' + reason)
}

/** 取启动图里的所有 bundle URL（兼容 entries / batches 两种 wire 形态）。 */
function bootUrls(html) {
  const match = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html)
  if (match === null) throw new Error('首页 HTML 里没有 __DSH_BOOT__（client 模块系统未装配）')
  const graph = JSON.parse(match[1])
  const rows = Array.isArray(graph.entries)
    ? graph.entries
    : Array.isArray(graph.batches) ? graph.batches : []
  return rows.map((row) => (typeof row.url === 'string' ? row.url : undefined)).filter(Boolean)
}

/** 断言：启动图里有我们的 client 行，且宿主真的把 bundle 字节发出来了。 */
async function verifyClientRow(cookie) {
  const html = await (await get(baseUrl, cookie)).text()
  if (!html.includes('@bigfish/plugin-ops')) {
    throw new Error('启动图里没有 @bigfish/plugin-ops —— package.json 的 dsh.client 没被扫描到')
  }
  const urls = [...new Set(bootUrls(html))]
  if (urls.length === 0) throw new Error('启动图没有任何 client bundle URL')
  let source = ''
  for (const url of urls) {
    const response = await get(new URL(url.replace(/&amp;/g, '&'), baseUrl), cookie)
    if (!response.ok) throw new Error('拉取 client bundle 失败：' + url + ' → HTTP ' + String(response.status))
    source += await response.text()
  }
  for (const expected of ["id: '@bigfish/plugin-ops'", 'sidebar.panellist', "name: 'main'"]) {
    if (!source.includes(expected)) throw new Error('client bundle 字节里缺少：' + expected)
  }
  return { urls: urls.length, bytes: source.length }
}

/** 读 pid 文件并判断进程是否还在。 */
function runningPid() {
  if (!existsSync(pidPath)) return undefined
  const pid = Number(readFileSync(pidPath, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}

/** 打印就绪信息（面板位置、热调试方式、停止命令）。 */
function report(ready, info) {
  console.log('✔ DSH Web 已就绪：' + ready.tokenUrl)
  console.log('✔ client 行已装配：' + String(info.urls) + ' 个 bundle / ' + String(info.bytes) + ' 字节')
  console.log('  侧边栏应出现「BigFish 闲鱼运营」栏位（🐟），点开是面板占位页。')
  console.log('  热调试：改 packages/plugin-ops/client.js 保存后，页面不刷新即换新（dsh-client-hmr stat-poll）。')
  console.log('  停止：node scripts/dsh-dev.mjs --stop')
}

/** 主流程；用 exitCode 收尾而不是 process.exit（Windows 上后者会在 fetch 连接关闭时触发 libuv 断言）。 */
async function main() {
  mkdirSync(stateDir, { recursive: true })

  if (has('--stop')) {
    const pid = runningPid()
    if (pid === undefined) {
      console.log('没有在跑的 bigfish dev 实例')
      return
    }
    try { process.kill(pid) } catch {}
    rmSync(pidPath, { force: true })
    console.log('已停止 bigfish dev 实例（pid ' + String(pid) + '）')
    return
  }

  if (has('--fresh')) rmSync(dshHome, { recursive: true, force: true })
  mkdirSync(stateDir, { recursive: true })

  const checkOnly = has('--check')
  if (!checkOnly) {
    const existing = runningPid()
    if (existing !== undefined) {
      try {
        const ready = await waitReady(4000)
        console.log('已有 dev 实例在跑：pid ' + String(existing))
        report(ready, await verifyClientRow(ready.cookie))
        return
      } catch {
        try { process.kill(existing) } catch {}
        rmSync(pidPath, { force: true })
      }
    }

    const target = ensureProfile({ repoRoot, dshHome })
    const logFd = openSync(logPath, 'a')
    const child = spawn(process.execPath, [target.cli, '--profile', 'bigfish-dev', '--port', String(port), '--no-open'], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    closeSync(logFd)
    child.unref()
    writeFileSync(pidPath, String(child.pid) + '\n')
    console.log('启动中：pid ' + String(child.pid) + ' → ' + baseUrl + '（日志 ' + logPath + '）')
    try {
      const ready = await waitReady(120_000)
      report(ready, await verifyClientRow(ready.cookie))
    } catch (error) {
      const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-25).join('\n') : '(无日志)'
      console.error('✖ ' + error.message + '\n最近日志：\n' + tail)
      process.exitCode = 1
    }
    return
  }

  const ready = await waitReady(10_000)
  console.log('已有 dev 实例：' + ready.tokenUrl)
  report(ready, await verifyClientRow(ready.cookie))
}

await main()
