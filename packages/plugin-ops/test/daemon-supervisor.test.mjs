import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DAEMON_LOG_MAX_BYTES,
  DEFAULT_START_COOLDOWN_MS,
  buildSpawnArgs,
  createDaemonSupervisor,
  decideStart,
  resolveDaemonEndpoint,
  resolveDaemonEntry,
  resolveNodeBinary,
  rotateLogIfNeeded,
} from '../src/daemon-supervisor.js'
import { isNetworkFailure, withDaemonWatch } from '../src/daemon-watch.js'

const DAEMON_URL = 'http://127.0.0.1:47001'
const DATA_DIR = 'C:\\Users\\x\\AppData\\Local\\bigfish'
// Windows 上 PATH 里找的是 node.exe/node.cmd，其它平台是 node（与实现一致）。
const NODE_NAME = process.platform === 'win32' ? 'node.exe' : 'node'
// PATH 分隔符按平台：Windows 是 ';'（用 ':' 切 'D:\...' 会切坏盘符）。
const PATH_DELIMITER = process.platform === 'win32' ? ';' : ':'

/** 假时钟：sleep 推进时间，避免真实等待。 */
function fakeClock(start = 1_000) {
  let t = start
  return {
    now: () => t,
    sleep: async (ms) => { t += ms },
    advance: (ms) => { t += ms },
    get value() { return t },
  }
}

/** 假子进程：记录 exit 回调便于模拟「起来就退出」。 */
function fakeChild(pid = 4242) {
  const handlers = {}
  return {
    pid,
    once: (event, cb) => { handlers[event] = cb },
    emitExit: (code) => { if (handlers.exit) handlers.exit(code) },
  }
}

/** 拉起成功后「就绪」：第一次探测失败，之后成功。 */
function healthSequence(values) {
  let index = 0
  return async () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value
  }
}

test('resolveDaemonEndpoint：只认回环，缺省端口回落 47001', () => {
  assert.deepEqual(resolveDaemonEndpoint('http://127.0.0.1:47001'), { host: '127.0.0.1', port: 47001 })
  assert.deepEqual(resolveDaemonEndpoint('http://127.0.0.1'), { host: '127.0.0.1', port: 47001 })
  assert.deepEqual(resolveDaemonEndpoint('http://localhost:48001'), { host: '127.0.0.1', port: 48001 })
  assert.deepEqual(resolveDaemonEndpoint('http://[::1]:47001'), { host: '::1', port: 47001 })
  // 远端 daemon 不在本机拉起
  assert.equal(resolveDaemonEndpoint('http://192.168.1.9:47001'), undefined)
  assert.equal(resolveDaemonEndpoint('https://daemon.example.com'), undefined)
  assert.equal(resolveDaemonEndpoint('not a url'), undefined)
})

test('resolveNodeBinary：配置优先，其次 execPath 是 node，最后扫 PATH', () => {
  const nodeExe = resolve('/nodejs', NODE_NAME)
  const pathNode = join(resolve('/opt/bin'), NODE_NAME)
  const files = new Set([nodeExe, pathNode])
  const isFile = (path) => files.has(path)

  assert.equal(resolveNodeBinary({ configured: nodeExe, execPath: '/x/electron', isFile }), nodeExe)
  // 配置了但文件不存在：直接失败，不回退（避免悄悄用别的 node）
  assert.equal(resolveNodeBinary({ configured: resolve('/nope', NODE_NAME), execPath: nodeExe, isFile }), undefined)
  // execPath 本身是 node 时直接用
  assert.equal(resolveNodeBinary({ execPath: nodeExe, isFile }), nodeExe)
  // execPath 是 Electron：落到 PATH
  assert.equal(
    resolveNodeBinary({ execPath: 'C:\\Program Files\\DeepSeek\\DeepSeek.exe', pathEnv: resolve('/opt/bin'), delimiter: PATH_DELIMITER, isFile }),
    pathNode,
  )
  assert.equal(resolveNodeBinary({ execPath: '/x/electron', pathEnv: resolve('/empty'), delimiter: PATH_DELIMITER, isFile }), undefined)
  assert.equal(resolveNodeBinary({ execPath: '', pathEnv: '', isFile }), undefined)
})

test('resolveDaemonEntry：配置优先，否则按插件位置找兄弟目录的 cli.ts', () => {
  const pluginDir = resolve('/repo/packages/plugin-ops')
  const siblingEntry = resolve('/repo/packages/daemon/src/cli.ts')
  const customEntry = resolve('/custom/cli.ts')
  const isFile = (path) => path === siblingEntry || path === customEntry
  assert.equal(resolveDaemonEntry({ pluginDir, isFile }), siblingEntry)
  assert.equal(resolveDaemonEntry({ configured: customEntry, pluginDir, isFile }), customEntry)
  assert.equal(resolveDaemonEntry({ configured: resolve('/missing.ts'), pluginDir, isFile }), undefined)
  assert.equal(resolveDaemonEntry({}), undefined)
})

test('buildSpawnArgs：显式传数据目录与端口，插件和 daemon 共用同一份 token', () => {
  const args = buildSpawnArgs({ entry: '/repo/daemon/src/cli.ts', dataDir: DATA_DIR, tokenPath: DATA_DIR + '\\daemon.token', host: '127.0.0.1', port: 47001 })
  assert.deepEqual(args, [
    '/repo/daemon/src/cli.ts',
    '--data-dir', DATA_DIR,
    '--token-path', DATA_DIR + '\\daemon.token',
    '--host', '127.0.0.1',
    '--port', '47001',
  ])
})

test('decideStart：关闭 / 冷却窗口 / 到期', () => {
  assert.deepEqual(decideStart({ enabled: false, now: 1_000 }), { attempt: false, reason: 'disabled' })
  assert.deepEqual(decideStart({ enabled: true, now: 1_000 }), { attempt: true, reason: 'due' })
  assert.deepEqual(
    decideStart({ enabled: true, now: 1_000 + DEFAULT_START_COOLDOWN_MS - 1, lastAttemptAt: 1_000 }),
    { attempt: false, reason: 'cooldown' },
  )
  assert.deepEqual(
    decideStart({ enabled: true, now: 1_000 + DEFAULT_START_COOLDOWN_MS, lastAttemptAt: 1_000 }),
    { attempt: true, reason: 'due' },
  )
  assert.deepEqual(
    decideStart({ enabled: true, now: 1_000, lastAttemptAt: 1_000, cooldownMs: 0 }),
    { attempt: true, reason: 'due' },
  )
})

test('ensure：自动拉起关闭时直接返回 disabled，不探测', async () => {
  let probed = false
  const supervisor = createDaemonSupervisor({
    enabled: false,
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    writeLog: () => {},
    effects: { health: async () => { probed = true; return { ok: false } } },
  })
  assert.equal(supervisor.enabled, false)
  const result = await supervisor.ensure('rpc:health')
  assert.equal(result.status, 'disabled')
  assert.equal(probed, false)
})

test('ensure：daemon 已在线时不再拉起进程', async () => {
  let spawns = 0
  const supervisor = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    writeLog: () => {},
    effects: {
      health: async () => ({ ok: true }),
      spawn: () => { spawns += 1; return fakeChild() },
      now: () => 1_000,
    },
  })
  const result = await supervisor.ensure('rpc:health')
  assert.equal(result.status, 'running')
  assert.equal(spawns, 0)
})

test('ensure：远端 daemonUrl 不本地拉起（skipped）', async () => {
  let spawns = 0
  const supervisor = createDaemonSupervisor({
    daemonUrl: 'http://10.0.0.5:47001',
    dataDir: DATA_DIR,
    writeLog: () => {},
    effects: {
      health: async () => ({ ok: false }),
      spawn: () => { spawns += 1; return fakeChild() },
      now: () => 1_000,
    },
  })
  const result = await supervisor.ensure()
  assert.equal(result.status, 'skipped')
  assert.equal(spawns, 0)
})

test('ensure：找不到 node / 找不到入口都降级为 unavailable 且不 spawn', async () => {
  let spawns = 0
  const noNode = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    writeLog: () => {},
    effects: {
      health: async () => ({ ok: false }),
      isFile: () => false,
      spawn: () => { spawns += 1; return fakeChild() },
      now: () => 1_000,
    },
  })
  const nodeResult = await noNode.ensure()
  assert.equal(nodeResult.status, 'unavailable')
  assert.match(nodeResult.message, /node/)

  const clock = fakeClock()
  const nodeExe = resolve('/usr/bin', NODE_NAME)
  const noEntry = createDaemonSupervisor({
    nodePath: nodeExe,
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    pluginDir: '/repo/packages/plugin-ops',
    writeLog: () => {},
    effects: {
      health: async () => ({ ok: false }),
      // node 找得到（配置的路径），daemon 入口找不到
      isFile: (path) => path === nodeExe,
      spawn: () => { spawns += 1; return fakeChild() },
      now: clock.now,
      sleep: clock.sleep,
    },
  })
  const entryResult = await noEntry.ensure()
  assert.equal(entryResult.status, 'unavailable')
  assert.match(entryResult.message, /入口/)
  assert.equal(spawns, 0)
})

test('ensure：spawn 抛错记为 failed，不影响调用方', async () => {
  const clock = fakeClock()
  const logs = []
  const supervisor = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    daemonEntry: '/repo/packages/daemon/src/cli.ts',
    nodePath: '/usr/bin/node',
    writeLog: () => {},
    log: (line) => logs.push(line),
    effects: {
      health: async () => ({ ok: false }),
      isFile: () => true,
      spawn: () => { throw new Error('EPERM') },
      now: clock.now,
      sleep: clock.sleep,
    },
  })
  const result = await supervisor.ensure()
  assert.equal(result.status, 'failed')
  assert.match(result.message, /spawn 失败/)
  assert.match(result.message, /EPERM/)
  assert.equal(supervisor.snapshot().status, 'failed')
  assert.match(supervisor.snapshot().lastError, /spawn 失败/)
  assert.equal(logs.length, 1)
  assert.equal(JSON.parse(logs[0]).level, 'warn')
})

test('ensure：拉起后轮询到就绪 → started，并带上 pid', async () => {
  const clock = fakeClock()
  const spawnCalls = []
  const pidWrites = []
  const supervisor = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    daemonEntry: '/repo/packages/daemon/src/cli.ts',
    nodePath: '/usr/bin/node',
    writeLog: () => {},
    effects: {
      health: healthSequence([{ ok: false }, { ok: false }, { ok: true }]),
      isFile: () => true,
      spawn: (node, args, options) => {
        spawnCalls.push({ node, args, options })
        return fakeChild(777)
      },
      now: clock.now,
      sleep: clock.sleep,
      writePid: (path, record) => { pidWrites.push({ path, record }) },
    },
  })
  const result = await supervisor.ensure('rpc:health')
  assert.equal(result.status, 'started')
  assert.match(result.message, /pid 777/)
  assert.deepEqual(result.detail, { pid: 777, pidFile: DATA_DIR + '\\run\\daemon.pid' })
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].node, '/usr/bin/node')
  assert.equal(spawnCalls[0].args[0], '/repo/packages/daemon/src/cli.ts')
  assert.deepEqual(spawnCalls[0].options, { logPath: DATA_DIR + '\\logs\\daemon.log' })
  // 拉起成功必须登记 pid 文件，否则 pnpm daemon:status|stop 看不见这个实例。
  assert.deepEqual(pidWrites, [{ path: DATA_DIR + '\\run\\daemon.pid', record: { pid: 777, port: 47001, host: '127.0.0.1', startedAt: clock.value } }])
  assert.equal(supervisor.snapshot().status, 'started')
  assert.equal(supervisor.snapshot().daemonLog, DATA_DIR + '\\logs\\daemon.log')
})

test('ensure：health 自报的 pid 优先于子进程 pid（node 可能再 fork 一层）', async () => {
  const clock = fakeClock()
  const pidWrites = []
  const supervisor = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    daemonEntry: '/repo/packages/daemon/src/cli.ts',
    nodePath: '/usr/bin/node',
    writeLog: () => {},
    effects: {
      health: healthSequence([{ ok: false }, { ok: true, value: { pid: 8888 } }]),
      isFile: () => true,
      spawn: () => fakeChild(777),
      now: clock.now,
      sleep: clock.sleep,
      writePid: (path, record) => { pidWrites.push({ path, record }) },
    },
  })
  const result = await supervisor.ensure('rpc:health')
  assert.equal(result.status, 'started')
  assert.equal(result.detail.pid, 8888)
  assert.equal(pidWrites[0].record.pid, 8888)
})

test('ensure：状态目录不可写 → 仍算 started，只在日志里 warn', async () => {
  const clock = fakeClock()
  const warnings = []
  const supervisor = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    daemonEntry: '/repo/packages/daemon/src/cli.ts',
    nodePath: '/usr/bin/node',
    writeLog: (level, message) => { if (level === 'warn') warnings.push(message) },
    effects: {
      health: healthSequence([{ ok: false }, { ok: true }]),
      isFile: () => true,
      spawn: () => fakeChild(777),
      now: clock.now,
      sleep: clock.sleep,
      writePid: () => false,
    },
  })
  const result = await supervisor.ensure('rpc:health')
  assert.equal(result.status, 'started')
  assert.equal(result.detail.pidFile, '')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /pid 文件/)
})

test('ensure：子进程先退出 → failed，带 exit code 与 daemon.log 尾巴', async () => {
  const clock = fakeClock()
  const child = fakeChild(999)
  const supervisor = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    daemonEntry: '/repo/packages/daemon/src/cli.ts',
    nodePath: '/usr/bin/node',
    writeLog: () => {},
    effects: {
      health: async () => ({ ok: false }),
      isFile: () => true,
      spawn: () => {
        // 第一次 sleep 后进程退出（面板下一次轮询前就知道失败了）
        setTimeout(() => child.emitExit(3), 0)
        return child
      },
      now: clock.now,
      sleep: async (ms) => { clock.advance(ms); await new Promise((done) => setImmediate(done)) },
      readTail: (path) => {
        assert.equal(path, DATA_DIR + '\\logs\\daemon.log')
        return 'Error: listen EADDRINUSE'
      },
    },
  })
  const result = await supervisor.ensure()
  assert.equal(result.status, 'failed')
  assert.match(result.message, /code=3/)
  assert.equal(result.detail.exitCode, 3)
  assert.match(result.detail.tail, /EADDRINUSE/)
})

test('ensure：单飞（并发两次只拉起一次）', async () => {
  const clock = fakeClock()
  let spawns = 0
  let releaseHealth
  const gate = new Promise((done) => { releaseHealth = done })
  const supervisor = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    daemonEntry: '/repo/packages/daemon/src/cli.ts',
    nodePath: '/usr/bin/node',
    writeLog: () => {},
    effects: {
      health: async () => { await gate; return { ok: true } },
      isFile: () => true,
      spawn: () => { spawns += 1; return fakeChild() },
      now: clock.now,
      sleep: clock.sleep,
    },
  })
  const first = supervisor.ensure()
  const second = supervisor.ensure()
  releaseHealth()
  const [a, b] = await Promise.all([first, second])
  assert.equal(spawns, 0) // 第一次探测就 ok，不需要 spawn
  assert.equal(a.status, 'running')
  assert.equal(b.status, 'running')
})

test('ensure：失败后进入冷却，冷却窗口内不再尝试', async () => {
  const clock = fakeClock()
  let spawns = 0
  const supervisor = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    daemonEntry: '/repo/packages/daemon/src/cli.ts',
    nodePath: '/usr/bin/node',
    writeLog: () => {},
    effects: {
      health: async () => ({ ok: false }),
      isFile: () => true,
      spawn: () => { spawns += 1; throw new Error('boom') },
      now: clock.now,
      sleep: clock.sleep,
    },
  })
  const first = await supervisor.ensure()
  assert.equal(first.status, 'failed')
  const second = await supervisor.ensure()
  assert.equal(second.status, 'skipped')
  assert.equal(second.reason, 'cooldown')
  assert.equal(spawns, 1)
  // 冷却到期后允许再试
  clock.advance(DEFAULT_START_COOLDOWN_MS)
  const third = await supervisor.ensure()
  assert.equal(third.status, 'failed')
  assert.equal(spawns, 2)
})

test('withDaemonWatch：只有 NETWORK 才触发 ensure，结果原样返回', async () => {
  const calls = []
  const supervisor = { ensure: async (reason) => { calls.push(reason); return { status: 'started' } } }
  const ok = { handle: async () => ({ ok: true, value: { version: '0.3.0' } }) }
  const watchedOk = withDaemonWatch(ok, supervisor)
  assert.deepEqual(await watchedOk.handle('health', {}, undefined), { ok: true, value: { version: '0.3.0' } })
  assert.equal(calls.length, 0)

  const network = { handle: async () => ({ ok: false, error: { code: 'NETWORK', message: 'down' } }) }
  const watched = withDaemonWatch(network, supervisor)
  const networkResult = await watched.handle('status', {}, undefined)
  assert.equal(networkResult.error.code, 'NETWORK')
  assert.deepEqual(calls, ['rpc:status'])

  // 非 NETWORK 错误（如 VALIDATION）说明 daemon 在线，不该拉起
  const validation = { handle: async () => ({ ok: false, error: { code: 'VALIDATION', message: 'bad' } }) }
  await withDaemonWatch(validation, supervisor).handle('tasks.list', {}, undefined)
  assert.deepEqual(calls, ['rpc:status'])

  // ensure 抛错也不能污染 rpc 结果
  const boom = { handle: async () => ({ ok: false, error: { code: 'NETWORK', message: 'down' } }) }
  const throwing = withDaemonWatch(boom, { ensure: async () => { throw new Error('nope') } })
  assert.equal((await throwing.handle('health', {}, undefined)).error.code, 'NETWORK')
})

test('withDaemonWatch / isNetworkFailure：入参与判定', () => {
  assert.throws(() => withDaemonWatch({}, { ensure: () => {} }), TypeError)
  assert.throws(() => withDaemonWatch({ handle: () => {} }, {}), TypeError)
  assert.equal(isNetworkFailure({ ok: false, error: { code: 'NETWORK' } }), true)
  assert.equal(isNetworkFailure({ ok: false, error: { code: 'INTERNAL' } }), false)
  assert.equal(isNetworkFailure({ ok: true }), false)
  assert.equal(isNetworkFailure(null), false)
  assert.equal(isNetworkFailure({ ok: false, error: null }), false)
})

test('withDaemonWatch：透传桥的其它字段', () => {
  const bridge = { handle: async () => ({ ok: true }), endpoints: ['health'], WRITE_ENDPOINTS: [] }
  const watched = withDaemonWatch(bridge, { ensure: async () => ({}) })
  assert.deepEqual(watched.endpoints, ['health'])
  assert.deepEqual(watched.WRITE_ENDPOINTS, [])
  assert.equal(watched.handle === bridge.handle, false)
})

test('ensure：冷却期内跳过；面板按钮 force=true 时跳过冷却再试一次', async () => {
  const clock = fakeClock()
  let spawns = 0
  const supervisor = createDaemonSupervisor({
    daemonUrl: DAEMON_URL,
    dataDir: DATA_DIR,
    daemonEntry: '/repo/packages/daemon/src/cli.ts',
    nodePath: '/usr/bin/node',
    writeLog: () => {},
    effects: {
      health: async () => ({ ok: false }),
      isFile: () => true,
      spawn: () => {
        spawns += 1
        throw new Error('EPERM')
      },
      now: clock.now,
      sleep: clock.sleep,
    },
  })
  assert.equal((await supervisor.ensure('rpc')).status, 'failed')
  assert.equal(spawns, 1)
  // 冷却窗口内：不再重复拉起（避免面板 3 秒轮询把机器刷爆）。
  const skipped = await supervisor.ensure('rpc')
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.reason, 'cooldown')
  assert.equal(spawns, 1)
  // 人点了「启动」：force 跳过冷却，并记下 forced 原因。
  const forced = await supervisor.ensure('panel', { force: true })
  assert.equal(forced.status, 'failed')
  assert.equal(spawns, 2)
})


test('rotateLogIfNeeded：超过 8MB 滚成 .1，不到阈值与文件不存在都不动', async () => {
  const base = fileURLToPath(new URL('../../.scratch/supervisor-test/', import.meta.url))
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  const logPath = join(base, 'daemon.log')
  // 不存在：不算错，也不需要造文件。
  assert.deepEqual(rotateLogIfNeeded(logPath), { rotated: false, size: 0 })
  // 小文件：留着。
  writeFileSync(logPath, 'x'.repeat(1024))
  assert.deepEqual(rotateLogIfNeeded(logPath), { rotated: false, size: 1024 })
  assert.equal(existsSync(logPath + '.1'), false)
  // 超阈值：滚成 .1，原文件消失（下次 openSync 'a' 会新建）。
  writeFileSync(logPath, 'y'.repeat(DAEMON_LOG_MAX_BYTES + 1))
  const result = rotateLogIfNeeded(logPath)
  assert.equal(result.rotated, true)
  assert.equal(existsSync(logPath), false)
  assert.equal(existsSync(logPath + '.1'), true)
  rmSync(base, { recursive: true, force: true })
})
