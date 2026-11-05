#!/usr/bin/env node
/**
 * 真机验收：一条命令跑完「混合类目批量 dry-run」。
 *
 * 为什么必须在普通终端跑：DSH 沙箱里 Chrome 能起浏览器进程，但渲染进程起不来，
 * CDP 页面命令（Runtime.evaluate 等）会超时 —— 发布步骤机依赖页面自动化，只能在非沙箱环境执行。
 *
 * 它做什么：
 *   1. 自己拉起一个 **BF_PUBLISH_DRYRUN=1** 的 daemon（绝不提交），跑完即停；
 *   2. 同一个 batchId 入队两条：支持类目（学习笔记，应 done）+ 不支持类目（教材教辅，应 failed）；
 *   3. 轮询 /batches/:id 直到终态，判定「一条成功、一条失败、互不拖累」；
 *   4. 打印报告、落一份证据 JSON、退出码 0/1/2。
 *
 * 前置：本机 Chrome 已带 --remote-debugging-port=9222 启动并登录 https://www.goofish.com/。
 *
 * @module scripts/publish-acceptance
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ACCEPTANCE_PORT,
  buildAcceptanceDrafts,
  evaluateOutcome,
  formatReport,
  isAbsolutePath,
  isTerminal,
  makeSolidPng,
  parseAcceptanceArgs,
  resolveDataRoot,
} from './lib/publish-acceptance.mjs'
import { spawnDaemon, waitForExit, waitForReady } from './lib/daemon-runtime.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const daemonCliPath = join(repoRoot, 'packages', 'daemon', 'src', 'cli.ts')

const USAGE_TEXT = [
  '真机验收：混合类目批量 dry-run（一条支持类目 + 一条不支持类目，同一批次）',
  '',
  '用法：node scripts/publish-acceptance.mjs [选项]',
  '',
  '选项：',
  '  --port N           自起 daemon 的端口（默认 ' + String(DEFAULT_ACCEPTANCE_PORT) + '，避开日常 daemon）',
  '  --url URL          复用已在跑的 daemon（回环地址）；注意：必须确认它也是 BF_PUBLISH_DRYRUN=1 启动的',
  '  --data-dir DIR     数据目录（默认与 daemon 一致：Windows %LOCALAPPDATA%/bigfish）',
  '  --chrome-port N    Chrome DevTools 端口（默认 9222）',
  '  --account ID       指定账号；默认取 /status 里的第一个已导入账号',
  '  --batch-id ID      指定批次 id；默认 b-accept-<时间戳>',
  '  --images A,B       发布用图片绝对路径（默认自动生成两张 PNG 到 .scratch/acceptance/images）',
  '  --timeout-ms N     等批次终态的超时（默认 300000）',
  '  --interval-ms N    轮询间隔（默认 5000）',
  '  --json-out FILE    证据 JSON 输出路径（默认 .scratch/acceptance/<批次>.json）',
  '  --help, -h         显示本帮助',
  '',
  '退出码：0 通过；1 未通过/执行失败；2 参数错误。',
].join('\n')

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error('✖ ' + messageOf(error))
    process.exitCode = 1
  },
)

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let options
  try {
    options = parseAcceptanceArgs(argv)
  } catch (error) {
    console.error('✖ ' + messageOf(error))
    console.error('')
    console.error(USAGE_TEXT)
    return 2
  }
  if (options.help) {
    console.log(USAGE_TEXT)
    return 0
  }

  const shotsDir = resolve(repoRoot, '.scratch', 'acceptance', 'shots')
  const stamp = String(Date.now())
  const batchId = options.batchId ?? 'b-accept-' + stamp
  const evidencePath = options.jsonOut ?? resolve(repoRoot, '.scratch', 'acceptance', batchId + '.json')
  const daemonUrl = options.url ?? 'http://127.0.0.1:' + String(options.port)
  const dataDir = options.dataDir ?? resolveDataRoot(process.env, homedir, process.platform)

  console.log('· 数据目录 ' + dataDir)
  console.log('· 批次     ' + batchId)
  console.log('· 截图     ' + shotsDir)
  console.log('· daemon   ' + daemonUrl)

  await assertChrome(options.chromePort)

  let owned
  let evidence
  let code = 1
  try {
    owned = options.url === undefined ? await startDryRunDaemon(options, dataDir, shotsDir) : undefined
    const token = await resolveToken(options, dataDir, owned)
    const client = createClient(daemonUrl, token)
    const accountId = await resolveAccount(client, options.account)
    console.log('· 账号     ' + accountId)

    const images = await resolveImages(options.images)
    const drafts = buildAcceptanceDrafts({ accountId, images, stamp })
    const tasks = []
    for (const draft of [drafts.supported, drafts.unsupported]) {
      const receipt = await client.post('/tasks', { ...draft, batchId })
      const task = receipt.data ?? receipt
      tasks.push(task)
      console.log('· 入队     ' + String(task.id ?? '?') + ' [' + draft.payload.category + '] state=' + String(task.state ?? '?'))
    }

    const batch = await waitForBatch(client, batchId, options, (progress) => {
      console.log('  … ' + String(progress.total) + ' 条，' + JSON.stringify(progress.counts))
    })
    const verdict = evaluateOutcome(batch)
    console.log(formatReport({ batchId, batch, verdict, screenshotsDir: shotsDir, daemonUrl }))
    evidence = { batchId, daemonUrl, accountId, images, shotsDir: shotsDir, verdict, batch, at: new Date().toISOString() }
    code = verdict.pass ? 0 : 1
  } catch (error) {
    console.error('✖ ' + messageOf(error))
    evidence = { batchId, daemonUrl, error: messageOf(error), at: new Date().toISOString() }
  } finally {
    if (owned !== undefined) await stopDaemon(owned)
    if (evidence !== undefined) {
      await mkdir(dirname(evidencePath), { recursive: true })
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
      console.log('· 证据     ' + evidencePath)
    }
  }
  return code
}

/** Chrome 调试端口必须先就绪：publish 通道是「附加到用户已登录的 Chrome」，不会自己起浏览器。 */
async function assertChrome(chromePort) {
  const url = 'http://127.0.0.1:' + String(chromePort) + '/json/version'
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) throw new Error('HTTP ' + String(response.status))
    console.log('· Chrome   ' + String(chromePort) + ' 已就绪')
  } catch (error) {
    throw new Error(
      'Chrome DevTools 端口 ' + String(chromePort) + ' 连不上（' + messageOf(error) + '）。先启动带调试端口的 Chrome 并登录闲鱼：' +
        (isWindows
          ? '\n  "C:/Program Files/Google/Chrome/Application/chrome.exe" --remote-debugging-port=' + String(chromePort) + ' --user-data-dir=%TEMP%/bigfish-accept'
          : '\n  google-chrome --remote-debugging-port=' + String(chromePort) + ' --user-data-dir=/tmp/bigfish-accept'),
    )
  }
}

/** 自起 dry-run daemon：先把 BF_PUBLISH_DRYRUN 等人写进 env，再走 daemon-runtime 的 spawn。 */
async function startDryRunDaemon(options, dataDir, shotsDir) {
  const health = await probeHealth('http://127.0.0.1:' + String(options.port))
  if (health !== undefined) {
    throw new Error('端口 ' + String(options.port) + ' 上已有 daemon 在跑；先停掉它，或用 --url 复用它（须确认是 dry-run 启动）')
  }
  process.env['BF_PUBLISH_DRYRUN'] = '1'
  delete process.env['BF_PUBLISH_SUBMIT']
  process.env['BF_CHROME_PORT'] = String(options.chromePort)
  process.env['BF_PUBLISH_SCREENSHOTS'] = shotsDir
  const logPath = join(resolve(repoRoot, '.scratch', 'acceptance'), 'daemon.log')
  await mkdir(dirname(logPath), { recursive: true })
  const spawned = spawnDaemon({ repoRoot, cliPath: daemonCliPath, dataDir, port: options.port, host: '127.0.0.1', logPath })
  if (spawned.pid === undefined) throw new Error('daemon 子进程没有 pid')
  console.log('· daemon   已启动 pid ' + String(spawned.pid) + '（BF_PUBLISH_DRYRUN=1，dry-run 不会提交）')
  const ready = await waitForReady({ pid: spawned.pid, host: '127.0.0.1', port: options.port, timeoutMs: 30_000, getSpawnError: spawned.getSpawnError })
  if (!ready.ok) throw new Error('daemon 启动失败：' + ready.reason + '（日志 ' + logPath + '）')
  return spawned
}

async function stopDaemon(spawned) {
  if (!spawned || spawned.pid === undefined) return
  try {
    if (isWindows) spawnSync('taskkill', ['/PID', String(spawned.pid), '/T'], { windowsHide: true, timeout: 8000 })
    else process.kill(spawned.pid, 'SIGTERM')
  } catch {
    // 停不下来就强杀：验收脚本不该留下孤儿 daemon。
    try { spawned.child?.kill() } catch {}
  }
  const exited = await waitForExit(spawned.pid, 8000)
  if (!exited) {
    try { spawned.child?.kill() } catch {}
    await waitForExit(spawned.pid, 3000)
  }
  console.log('· daemon   已停止')
}

async function probeHealth(base) {
  try {
    const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return undefined
    const body = await response.json()
    return body?.ok === true ? body.data : undefined
  } catch {
    return undefined
  }
}

async function resolveToken(options, dataDir, owned) {
  if (options.url !== undefined) {
    const tokenPath = join(dataDir, 'daemon.token')
    if (!existsSync(tokenPath)) throw new Error('复用已有 daemon 需要读 ' + tokenPath + ' 里的 token；不存在就改用自起模式（去掉 --url）')
    return (await readFile(tokenPath, 'utf8')).trim()
  }
  if (owned === undefined) throw new Error('内部错误：既没有 --url 也没有自起 daemon')
  const tokenPath = join(dataDir, 'daemon.token')
  for (let index = 0; index < 40; index += 1) {
    if (existsSync(tokenPath)) {
      const token = (await readFile(tokenPath, 'utf8')).trim()
      if (token !== '') return token
    }
    await new Promise((done) => setTimeout(done, 200))
  }
  throw new Error('等不到 ' + tokenPath + '（daemon 应该会创建它）')
}

function createClient(base, token) {
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text }
    if (!response.ok) {
      const error = parsed?.error ?? parsed
      throw new Error(method + ' ' + path + ' 失败（HTTP ' + String(response.status) + '）：' + JSON.stringify(error).slice(0, 400))
    }
    return parsed
  }
  return {
    get: (path) => call('GET', path, undefined),
    post: (path, body) => call('POST', path, body),
  }
}

async function resolveAccount(client, requested) {
  if (requested !== undefined) return requested
  const status = await client.get('/status')
  const accounts = status?.data?.accounts ?? status?.accounts ?? []
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('daemon 里没有已导入账号：先 pnpm daemon:import-account 或面板里导入登录态')
  }
  return String(accounts[0])
}

/** 没给 --images 就现场生成两张 PNG（真机验收不该依赖仓库里的历史截图）。 */
async function resolveImages(provided) {
  if (provided !== undefined) {
    for (const path of provided) {
      if (!isAbsolutePath(path)) throw new Error('图片必须是绝对路径：' + path)
      if (!existsSync(path)) throw new Error('图片不存在：' + path)
    }
    return provided
  }
  const dir = resolve(repoRoot, '.scratch', 'acceptance', 'images')
  await mkdir(dir, { recursive: true })
  const first = join(dir, 'accept-1.png')
  const second = join(dir, 'accept-2.png')
  await writeFile(first, makeSolidPng(600, 600, [232, 240, 254]))
  await writeFile(second, makeSolidPng(600, 600, [254, 242, 232]))
  return [first, second]
}

async function waitForBatch(client, batchId, options, onProgress) {
  const startedAt = Date.now()
  let last = undefined
  while (Date.now() - startedAt < options.timeoutMs) {
    const response = await client.get('/batches/' + encodeURIComponent(batchId))
    last = response?.data ?? response
    onProgress(last)
    if (last.total > 0 && isTerminal(last.counts)) return last
    await new Promise((done) => setTimeout(done, options.intervalMs))
  }
  throw new Error('等批次终态超时（' + String(options.timeoutMs) + 'ms），最后状态 ' + JSON.stringify(last?.counts ?? {}))
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
