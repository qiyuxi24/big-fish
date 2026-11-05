/**
 * scripts/lib/daemon-service.mjs 的纯函数单测：不 spawn、不连端口。
 * 真实生命周期（start/status/stop）在 scripts/daemon-service.mjs 里，靠真机验证，不进单测（沙箱禁 spawn）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_LOG_TAIL,
  DEFAULT_PORT,
  MAX_LOG_BYTES,
  MAX_LOG_READ_BYTES,
  MAX_LOG_TAIL,
  PID_FILE_NAME,
  SERVICE_COMMANDS,
  daemonArgs,
  evaluateServiceState,
  formatBytes,
  formatPidFile,
  formatUptime,
  healthUrl,
  isLoopbackHost,
  parsePidFile,
  parseServiceArgs,
  resolveDaemonPort,
  resolveServicePaths,
  resolveStateRoot,
  tailLines,
} from './daemon-service.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('parseServiceArgs：最小 start 只有子命令', () => {
  const options = parseServiceArgs(['start'])
  assert.equal(options.command, 'start')
  assert.equal(options.port, undefined)
  assert.equal(options.host, undefined)
  assert.equal(options.dataDir, undefined)
  assert.equal(options.stateDir, undefined)
  assert.equal(options.tail, undefined)
  assert.equal(options.timeoutMs, undefined)
  assert.equal(options.help, false)
})

test('parseServiceArgs：全量参数（分离写法）', () => {
  const options = parseServiceArgs([
    'start',
    '--port',
    '47999',
    '--host',
    '::1',
    '--data-dir',
    './.scratch/data',
    '--state-dir',
    './.scratch/state',
    '--tail',
    '5',
    '--timeout-ms',
    '9000',
  ])
  assert.equal(options.command, 'start')
  assert.equal(options.port, 47999)
  assert.equal(options.host, '::1')
  assert.equal(options.dataDir, './.scratch/data')
  assert.equal(options.stateDir, './.scratch/state')
  assert.equal(options.tail, 5)
  assert.equal(options.timeoutMs, 9000)
})

test('parseServiceArgs：--flag=value 内联写法', () => {
  const options = parseServiceArgs(['status', '--port=48000', '--tail=3'])
  assert.equal(options.port, 48000)
  assert.equal(options.tail, 3)
})

test('parseServiceArgs：--help 不要求子命令', () => {
  const options = parseServiceArgs(['--help'])
  assert.equal(options.help, true)
  assert.equal(options.command, undefined)
})

test('parseServiceArgs：非法输入全部报错', () => {
  assert.throws(() => parseServiceArgs([]), /缺少子命令/)
  assert.throws(() => parseServiceArgs(['rm']), /未知子命令/)
  assert.throws(() => parseServiceArgs(['start', '--verbose']), /未知参数/)
  assert.throws(() => parseServiceArgs(['start', '--port']), /缺少取值/)
  assert.throws(() => parseServiceArgs(['start', '--port=']), /缺少取值/)
  assert.throws(() => parseServiceArgs(['start', '--host', '0.0.0.0']), /只允许回环/)
  assert.throws(() => parseServiceArgs(['start', '--port', '0']), /超出范围/)
  assert.throws(() => parseServiceArgs(['start', '--port', '70000']), /超出范围/)
  assert.throws(() => parseServiceArgs(['start', '--port', 'abc']), /必须是整数/)
  assert.throws(() => parseServiceArgs(['logs', '--tail', '0']), /必须 ≥1/)
  assert.throws(() => parseServiceArgs(['logs', '--tail', String(MAX_LOG_TAIL + 1)]), /最多/)
  assert.throws(() => parseServiceArgs(['start', '--timeout-ms', '1.5']), /必须是正整数/)
  assert.throws(() => parseServiceArgs(['start', '--state-dir', '  ']), /不能为空/)
})

test('resolveDaemonPort：--port 优先于 BF_PORT，非法 BF_PORT 报错', () => {
  assert.equal(resolveDaemonPort({ port: 48000 }, { BF_PORT: '47002' }), 48000)
  assert.equal(resolveDaemonPort({ port: undefined }, { BF_PORT: '47002' }), 47002)
  assert.equal(resolveDaemonPort({ port: undefined }, {}), DEFAULT_PORT)
  assert.equal(resolveDaemonPort({ port: undefined }, { BF_PORT: '  ' }), DEFAULT_PORT)
  assert.throws(() => resolveDaemonPort({ port: undefined }, { BF_PORT: 'abc' }), /BF_PORT/)
  assert.throws(() => resolveDaemonPort({ port: undefined }, { BF_PORT: '0' }), /超出范围/)
})

test('resolveStateRoot：Windows 用 LOCALAPPDATA，回退 homedir/.bigfish', () => {
  assert.equal(resolveStateRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32'), join('C:\\Users\\u\\AppData\\Local', 'bigfish'))
  assert.equal(resolveStateRoot({}, 'C:\\Users\\u', 'win32'), join('C:\\Users\\u', '.bigfish'))
  assert.equal(resolveStateRoot({ LOCALAPPDATA: '   ' }, 'C:\\Users\\u', 'win32'), join('C:\\Users\\u', '.bigfish'))
  assert.equal(resolveStateRoot({ LOCALAPPDATA: 'C:\\AppData' }, '/home/u', 'linux'), join('/home/u', '.bigfish'))
})

test('resolveServicePaths：run/daemon.pid 与 logs/daemon.log；--state-dir 覆盖根目录', () => {
  const paths = resolveServicePaths({ env: { LOCALAPPDATA: 'C:\\LA' }, home: 'C:\\Users\\u', platform: 'win32' })
  assert.equal(paths.root, join('C:\\LA', 'bigfish'))
  assert.equal(paths.pidPath, join('C:\\LA', 'bigfish', 'run', PID_FILE_NAME))
  assert.equal(paths.logPath, join('C:\\LA', 'bigfish', 'logs', 'daemon.log'))
  const isolated = resolveServicePaths({ stateDir: join(repoRoot, '.scratch', 'svc'), env: {}, home: '/home/u', platform: 'linux' })
  assert.equal(isolated.root, join(repoRoot, '.scratch', 'svc'))
  assert.equal(isolated.logDir, join(repoRoot, '.scratch', 'svc', 'logs'))
})

test('parsePidFile：JSON 记录 / 纯数字 / 非法输入', () => {
  const record = parsePidFile(JSON.stringify({ pid: 1234, port: 47001, host: '127.0.0.1', startedAt: 1700000000000, dataDir: 'D:\\data', logPath: 'D:\\log' }))
  assert.deepEqual(record, { pid: 1234, port: 47001, host: '127.0.0.1', startedAt: 1700000000000, dataDir: 'D:\\data', logPath: 'D:\\log' })
  assert.deepEqual(parsePidFile('  99\n'), { pid: 99 })
  assert.deepEqual(parsePidFile(JSON.stringify({ pid: 7, port: -1, host: 42 })), { pid: 7 })
  assert.equal(parsePidFile(''), undefined)
  assert.equal(parsePidFile('  '), undefined)
  assert.equal(parsePidFile('not-a-pid'), undefined)
  assert.equal(parsePidFile('{"pid":'), undefined)
  assert.equal(parsePidFile(JSON.stringify({ port: 47001 })), undefined)
  assert.equal(parsePidFile(JSON.stringify({ pid: '1234' })), undefined)
  assert.equal(parsePidFile(JSON.stringify({ pid: 0 })), undefined)
  assert.equal(parsePidFile('-5'), undefined)
})

test('formatPidFile：固定字段顺序 + 末尾换行，且可回读', () => {
  const record = { pid: 7, port: 47001, host: '127.0.0.1', startedAt: 1000, dataDir: 'D:\\d', logPath: 'D:\\l' }
  const text = formatPidFile(record)
  const expected = JSON.stringify({ pid: 7, port: 47001, host: '127.0.0.1', startedAt: 1000, dataDir: 'D:\\d', logPath: 'D:\\l' }, null, 2) + '\n'
  assert.equal(text, expected)
  assert.deepEqual(parsePidFile(text), record)
  assert.equal(formatPidFile({ pid: 8 }).endsWith('\n'), true)
  assert.deepEqual(parsePidFile(formatPidFile({ pid: 8 })), { pid: 8 })
})

test('healthUrl：IPv6 回环加方括号；非回环拒绝', () => {
  assert.equal(healthUrl({ host: '127.0.0.1', port: 47001 }), 'http://127.0.0.1:47001/health')
  assert.equal(healthUrl({ host: 'localhost', port: 1 }), 'http://localhost:1/health')
  assert.equal(healthUrl({ host: '::1', port: 47001 }), 'http://[::1]:47001/health')
  assert.throws(() => healthUrl({ host: '192.168.1.2', port: 47001 }), /只允许回环/)
})

test('daemonArgs：--port 总是显式传', () => {
  assert.deepEqual(daemonArgs({ port: 47001 }), ['--port', '47001'])
  assert.deepEqual(daemonArgs({ dataDir: 'D:\\data', port: 47999, host: '127.0.0.1' }), [
    '--data-dir',
    'D:\\data',
    '--port',
    '47999',
    '--host',
    '127.0.0.1',
  ])
})

test('evaluateServiceState：五态矩阵', () => {
  const record = { pid: 100, port: 47001 }
  assert.deepEqual(evaluateServiceState({ pidRecord: record, processAlive: true, health: { ok: true, pid: 100 } }), {
    state: 'running',
    pid: 100,
    port: 47001,
  })
  assert.deepEqual(evaluateServiceState({ pidRecord: record, processAlive: true, health: { ok: false, error: 'ECONNREFUSED' } }), {
    state: 'unhealthy',
    pid: 100,
    port: 47001,
  })
  assert.deepEqual(evaluateServiceState({ pidRecord: record, processAlive: false, health: { ok: false } }), {
    state: 'stale-pid',
    pid: 100,
    port: 47001,
  })
  // 最常见的坏组合：pid 文件指向的进程早没了，但端口上有另一个实例在应答。
  // 必须报 unmanaged（带健康响应里的真实 pid），否则 stop 会以为「没东西可停」并 exit 0。
  assert.deepEqual(evaluateServiceState({ pidRecord: record, processAlive: false, health: { ok: true, pid: 200, port: 47002 } }), {
    state: 'unmanaged',
    pid: 200,
    port: 47002,
  })
  // 健康响应里没有 pid（旧版 daemon）时不要退回 pid 文件里那个已死的 pid，只报端口。
  assert.deepEqual(evaluateServiceState({ pidRecord: record, processAlive: false, health: { ok: true } }), {
    state: 'unmanaged',
    port: 47001,
  })
  assert.deepEqual(evaluateServiceState({ pidRecord: undefined, processAlive: false, health: { ok: true, pid: 200, port: 47002 } }), {
    state: 'unmanaged',
    pid: 200,
    port: 47002,
  })
  assert.deepEqual(evaluateServiceState({ pidRecord: undefined, processAlive: false, health: { ok: false } }), { state: 'not-running' })
  assert.deepEqual(evaluateServiceState({ pidRecord: undefined, processAlive: false, health: undefined }), { state: 'not-running' })
})

test('tailLines：CRLF / 末尾换行 / 行数不足 / 非法 count', () => {
  assert.deepEqual(tailLines('a\nb\nc\n', 2), ['b', 'c'])
  assert.deepEqual(tailLines('a\r\nb\r\nc\r\n', 10), ['a', 'b', 'c'])
  assert.deepEqual(tailLines('a\nb\nc', 2), ['b', 'c'])
  assert.deepEqual(tailLines('a\nb', 10), ['a', 'b'])
  assert.deepEqual(tailLines('', 10), [])
  assert.deepEqual(tailLines('a\n', 0), [])
  assert.deepEqual(tailLines('a\n', -1), [])
  assert.deepEqual(tailLines('a\n', 1.9), ['a'])
})

test('formatUptime：秒 / 分 / 时 / 天 边界', () => {
  assert.equal(formatUptime(0), '0s')
  assert.equal(formatUptime(999), '0s')
  assert.equal(formatUptime(1000), '1s')
  assert.equal(formatUptime(59_999), '59s')
  assert.equal(formatUptime(60_000), '1m 0s')
  assert.equal(formatUptime(3_661_000), '1h 1m')
  assert.equal(formatUptime(86_399_000), '23h 59m')
  assert.equal(formatUptime(86_400_000), '1d 0h')
  assert.equal(formatUptime(-5), '0s')
})

test('formatBytes：B / KB / MB 边界', () => {
  assert.equal(formatBytes(0), '0B')
  assert.equal(formatBytes(1023), '1023B')
  assert.equal(formatBytes(1024), '1.0KB')
  assert.equal(formatBytes(1536), '1.5KB')
  assert.equal(formatBytes(8 * 1024 * 1024), '8.0MB')
  assert.equal(formatBytes(-5), '0B')
})

test('日志上限常量：读侧 64KB、轮转阈值 8MB，且轮转阈值远大于读窗口', () => {
  assert.equal(MAX_LOG_READ_BYTES, 64 * 1024)
  assert.equal(MAX_LOG_BYTES, 8 * 1024 * 1024)
  // 读窗口必须远小于轮转阈值，否则「只读末尾」省不下什么。
  assert.ok(MAX_LOG_READ_BYTES * 8 <= MAX_LOG_BYTES)
})

test('常量：DEFAULT_PORT 与 packages/core/src/config.ts 一致', () => {
  assert.equal(DEFAULT_PORT, 47001)
  assert.equal(DEFAULT_LOG_TAIL, 40)
  assert.deepEqual(SERVICE_COMMANDS, ['start', 'stop', 'restart', 'status', 'logs'])
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('0.0.0.0'), false)
  const coreConfig = readFileSync(join(repoRoot, 'packages', 'core', 'src', 'config.ts'), 'utf8')
  const matched = /export const DEFAULT_PORT = (\d+)/.exec(coreConfig)
  assert.ok(matched, '没在 packages/core/src/config.ts 找到 DEFAULT_PORT')
  assert.equal(Number(matched[1]), DEFAULT_PORT)
})
