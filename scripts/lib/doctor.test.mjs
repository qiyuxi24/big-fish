/**
 * scripts/lib/doctor.mjs 的纯函数单测：不读盘、不探端口、不 spawn。
 * 副作用层（scripts/doctor.mjs 的 inspect）靠真机跑，不进单测。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCTOR_FLAGS,
  diagnose,
  formatBytes,
  parseDoctorArgs,
  renderReport,
  verdictOf,
} from './doctor.mjs'

/** 造一份「一切正常」的快照，用例只覆盖自己关心的字段。 */
function healthySnapshot() {
  return {
    node: 'v24.0.0',
    platform: 'win32',
    dataRoot: 'C:\\D',
    stateRoot: 'C:\\D',
    dbPath: 'C:\\D\\bigfish.db',
    dbSize: 1000,
    walSize: 100,
    shmSize: 32,
    tokenPath: 'C:\\D\\daemon.token',
    tokenSize: 64,
    settings: { present: true, valid: true, keys: ['copyStyle'], path: 'C:\\D\\settings.json' },
    credentialsDir: 'C:\\D\\credentials',
    credentialCount: 2,
    pidPath: 'C:\\D\\run\\daemon.pid',
    pidRecord: { pid: 100 },
    processAlive: true,
    logPath: 'C:\\D\\logs\\daemon.log',
    logSize: 2048,
    rotatedLogSize: undefined,
    pluginLogPath: 'C:\\D\\plugin.log',
    pluginLogSize: undefined,
    profile: { current: { path: 'C:\\D\\chrome-profile', size: 100 }, legacy: { path: 'C:\\H\\.bigfish\\chrome-profile', size: undefined } },
    port: 47001,
    health: { ok: true, pid: 100 },
    logTail: [],
  }
}

/** 按 title 前缀取一条结论，找不到就抛（避免断言悄悄失效）。 */
function rowOf(rows, needle) {
  const found = rows.find(row => row.title.includes(needle))
  assert.ok(found !== undefined, '没有找到含「' + needle + '」的结论，实际：' + rows.map(row => row.title).join(' | '))
  return found
}

test('parseDoctorArgs：默认值', () => {
  const options = parseDoctorArgs([])
  assert.equal(options.json, false)
  assert.equal(options.help, false)
  assert.equal(options.host, '127.0.0.1')
  assert.equal(options.port, undefined)
  assert.equal(options.dataDir, undefined)
  assert.equal(options.stateDir, undefined)
  assert.equal(options.tail, undefined)
})

test('parseDoctorArgs：--flag=value 与 --flag value 两种写法等价', () => {
  assert.equal(parseDoctorArgs(['--port=48001']).port, 48001)
  assert.equal(parseDoctorArgs(['--port', '48001']).port, 48001)
  assert.equal(parseDoctorArgs(['--tail=0']).tail, 0)
})

test('parseDoctorArgs：--host 只收回环地址', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(parseDoctorArgs(['--host', host]).host, host)
  }
  assert.throws(() => parseDoctorArgs(['--host', '0.0.0.0']), /只允许回环地址/)
  assert.throws(() => parseDoctorArgs(['--host', '192.168.1.2']), /只允许回环地址/)
})

test('parseDoctorArgs：非法值都报错，且报错里带参数名', () => {
  assert.throws(() => parseDoctorArgs(['--port', '0']), /--port/)
  assert.throws(() => parseDoctorArgs(['--port', '70000']), /--port/)
  assert.throws(() => parseDoctorArgs(['--port', 'abc']), /--port/)
  assert.throws(() => parseDoctorArgs(['--port']), /--port 需要一个值/)
  assert.throws(() => parseDoctorArgs(['--tail', '-1']), /--tail/)
  assert.throws(() => parseDoctorArgs(['--data-dir', '  ']), /--data-dir/)
  assert.throws(() => parseDoctorArgs(['--state-dir', '']), /--state-dir/)
  assert.throws(() => parseDoctorArgs(['--json=1']), /--json 不接受值/)
})

test('parseDoctorArgs：未知参数报错并列出可用参数', () => {
  assert.throws(() => parseDoctorArgs(['--nope']), /未知参数：--nope/)
  assert.throws(() => parseDoctorArgs(['start']), error => {
    assert.match(error.message, /未知参数：start/)
    assert.match(error.message, new RegExp(DOCTOR_FLAGS.join(' ')))
    return true
  })
})

test('formatBytes：边界', () => {
  assert.equal(formatBytes(0), '0B')
  assert.equal(formatBytes(-5), '0B')
  assert.equal(formatBytes(1023), '1023B')
  assert.equal(formatBytes(1024), '1.0KB')
  assert.equal(formatBytes(1536), '1.5KB')
  assert.equal(formatBytes(8 * 1024 * 1024), '8.0MB')
  assert.equal(formatBytes(Number.NaN), '0B')
})

test('diagnose：一切正常时全是 ok，结论 ok', () => {
  const rows = diagnose(healthySnapshot())
  assert.equal(verdictOf(rows), 'ok')
  assert.equal(rows.every(row => row.level === 'ok'), true)
  rowOf(rows, 'daemon 正在运行')
  rowOf(rows, 'SQLite 库存在')
})

test('diagnose：状态目录与数据目录不同 → warn，并给出合并办法', () => {
  const snapshot = healthySnapshot()
  snapshot.stateRoot = 'C:\\S'
  const row = rowOf(diagnose(snapshot), '状态目录与数据目录不是同一个')
  assert.equal(row.level, 'warn')
  assert.match(row.detail, /C:\\S/)
  assert.match(row.fix, /--data-dir/)
})

test('diagnose：没有 token → bad（没有它 daemon 起不来）', () => {
  const snapshot = healthySnapshot()
  snapshot.tokenSize = undefined
  const row = rowOf(diagnose(snapshot), '没有 daemon.token')
  assert.equal(row.level, 'bad')
  assert.match(row.fix, /daemon:start/)
})

test('diagnose：从没启动过（无 db）只算 warn，不算坏', () => {
  const snapshot = healthySnapshot()
  snapshot.dbSize = undefined
  snapshot.walSize = undefined
  snapshot.shmSize = undefined
  snapshot.health = { ok: false, error: 'ECONNREFUSED' }
  snapshot.pidRecord = undefined
  snapshot.processAlive = false
  snapshot.logSize = undefined
  const rows = diagnose(snapshot)
  assert.equal(rowOf(rows, '还没有 bigfish.db').level, 'warn')
  assert.equal(rowOf(rows, 'daemon 没在跑').level, 'warn')
  assert.equal(verdictOf(rows), 'warn')
})

test('diagnose：wal 比主库大且超过 1MB → warn（进程被强杀的化石）', () => {
  const snapshot = healthySnapshot()
  snapshot.dbSize = 1024
  snapshot.walSize = 4 * 1024 * 1024
  const rows = diagnose(snapshot)
  const row = rowOf(rows, 'wal 比主库还大')
  assert.equal(row.level, 'warn')
  assert.match(row.fix, /daemon:restart/)
})

test('diagnose：wal 很小但比主库大 → 不报（阈值以外不打扰）', () => {
  const snapshot = healthySnapshot()
  snapshot.dbSize = 1000
  snapshot.walSize = 2000
  const rows = diagnose(snapshot)
  assert.equal(rows.some(row => row.title.includes('wal 比主库还大')), false)
})

test('diagnose：settings.json 解析失败 → bad，建议删文件', () => {
  const snapshot = healthySnapshot()
  snapshot.settings = { present: true, valid: false, keys: [], path: 'C:\\D\\settings.json', error: 'Unexpected token }' }
  const row = rowOf(diagnose(snapshot), 'settings.json 解析失败')
  assert.equal(row.level, 'bad')
  assert.match(row.detail, /Unexpected token/)
  assert.match(row.fix, /C:\\D\\settings\.json/)
})

test('diagnose：settings.json 不存在是正常的，不是问题', () => {
  const snapshot = healthySnapshot()
  snapshot.settings = { present: false, valid: true, keys: [], path: 'C:\\D\\settings.json' }
  const row = rowOf(diagnose(snapshot), '还没有 settings.json')
  assert.equal(row.level, 'ok')
})

test('diagnose：没有账号 → warn，指向导入命令', () => {
  const snapshot = healthySnapshot()
  snapshot.credentialCount = 0
  const row = rowOf(diagnose(snapshot), '凭据目录里没有账号')
  assert.equal(row.level, 'warn')
  assert.match(row.fix, /daemon:import-account/)
})

test('diagnose：健康应答但没有 pid 登记 → warn（status 会报 unmanaged）', () => {
  const snapshot = healthySnapshot()
  snapshot.pidRecord = undefined
  snapshot.processAlive = false
  const row = rowOf(diagnose(snapshot), '但没有 pid 登记')
  assert.equal(row.level, 'warn')
  assert.match(row.fix, /daemon:start/)
})

test('diagnose：pid 死但端口有应答 → warn，指向 stop 按端口处理', () => {
  const snapshot = healthySnapshot()
  snapshot.pidRecord = { pid: 999999 }
  snapshot.processAlive = false
  snapshot.health = { ok: true, pid: 8500 }
  const row = rowOf(diagnose(snapshot), '已不存在，但端口还有应答')
  assert.equal(row.level, 'warn')
  // 活着的那个 pid 必须出现在结论里：不然用户不知道该 stop 谁。
  assert.match(row.title, /999999/)
  assert.match(row.title, /pid 8500/)
  assert.match(row.fix, /daemon:stop/)
})

test('diagnose：进程活着但 /health 不通 → bad（要去看日志）', () => {
  const snapshot = healthySnapshot()
  snapshot.health = { ok: false, error: 'ECONNREFUSED' }
  const row = rowOf(diagnose(snapshot), '/health 不通')
  assert.equal(row.level, 'bad')
  assert.match(row.detail, /ECONNREFUSED/)
})

test('diagnose：残留 pid 文件 → warn，指向 stop/start', () => {
  const snapshot = healthySnapshot()
  snapshot.health = { ok: false, error: 'ECONNREFUSED' }
  snapshot.processAlive = false
  const row = rowOf(diagnose(snapshot), '残留的 pid 文件')
  assert.equal(row.level, 'warn')
  assert.match(row.detail, /daemon\.pid/)
})

test('diagnose：两份 chrome-profile 并存 → bad（登录态不共享且吃盘）', () => {
  const snapshot = healthySnapshot()
  snapshot.profile = {
    current: { path: 'C:\\D\\chrome-profile', size: 175 * 1024 * 1024 },
    legacy: { path: 'C:\\H\\.bigfish\\chrome-profile', size: 330 * 1024 * 1024 },
  }
  const row = rowOf(diagnose(snapshot), '存在两份 chrome-profile')
  assert.equal(row.level, 'bad')
  assert.match(row.detail, /175\.0MB/)
  assert.match(row.detail, /330\.0MB/)
  assert.match(row.fix, /C:\\D\\chrome-profile/)
})

test('diagnose：只有新版 profile → ok；一份都没有 → warn', () => {
  const ok = diagnose(healthySnapshot())
  assert.equal(rowOf(ok, 'chrome-profile').level, 'ok')

  const snapshot = healthySnapshot()
  snapshot.profile = { current: { path: 'C:\\D\\chrome-profile', size: undefined }, legacy: { path: 'C:\\H\\.bigfish\\chrome-profile', size: undefined } }
  assert.equal(rowOf(diagnose(snapshot), '还没有 chrome-profile').level, 'warn')
})

test('diagnose：两份路径相同（非 win32 或自定义 home）不能误报两份', () => {
  const snapshot = healthySnapshot()
  const same = { path: 'C:\\D\\chrome-profile', size: 100 }
  snapshot.profile = { current: same, legacy: { ...same } }
  const rows = diagnose(snapshot)
  assert.equal(rows.some(row => row.title.includes('存在两份')), false)
  assert.equal(rowOf(rows, 'chrome-profile').level, 'ok')
})

test('verdictOf：bad 优先于 warn，全 ok 才是 ok', () => {
  assert.equal(verdictOf([]), 'ok')
  assert.equal(verdictOf([{ level: 'ok' }, { level: 'warn' }]), 'warn')
  assert.equal(verdictOf([{ level: 'warn' }, { level: 'bad' }]), 'bad')
  assert.equal(verdictOf([{ level: 'bad' }, { level: 'ok' }]), 'bad')
})

test('renderReport：带图标、fix 用 → 前缀、末尾有结论行与日志尾部', () => {
  const snapshot = healthySnapshot()
  snapshot.logTail = ['{"level":"info"}', '{"level":"error"}']
  const rows = [
    { level: 'ok', title: '一切正常' },
    { level: 'warn', title: '看一眼', detail: '细节', fix: '跑 pnpm daemon:start' },
    { level: 'bad', title: '要修', fix: '删掉它' },
  ]
  const text = renderReport(snapshot, rows)
  assert.match(text, /✔ 一切正常/)
  assert.match(text, /! 看一眼\n    细节\n    → 跑 pnpm daemon:start/)
  assert.match(text, /✖ 要修/)
  assert.match(text, /结论：1 条要修，1 条建议看一眼。/)
  assert.match(text, /—— daemon 日志尾部 2 行 ——/)
  assert.ok(text.includes('{"level":"error"}'))
})

test('renderReport：全 ok 时结论是「没有发现需要处理的问题」', () => {
  const snapshot = healthySnapshot()
  const text = renderReport(snapshot, [{ level: 'ok', title: 'x' }])
  assert.match(text, /结论：没有发现需要处理的问题。/)
  assert.equal(text.includes('日志尾部'), false)
})
