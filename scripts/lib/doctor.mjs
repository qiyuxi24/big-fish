/**
 * `pnpm doctor` 的纯函数层：参数解析 + 「快照 → 逐条结论」的判定。
 *
 * 为什么单独拆：判定逻辑是这次体检真正的价值（它编码了「什么算正常」），必须能单测；
 * 而读盘、探端口、读日志尾部都是副作用，放在 scripts/doctor.mjs 里。
 * 本文件不碰 fs / net，输入输出都是普通对象。
 * @module scripts/lib/doctor
 */

/** doctor 支持的参数（没有子命令，与 daemon-service 那套不同）。 */
export const DOCTOR_FLAGS = ['--port', '--host', '--data-dir', '--state-dir', '--tail', '--json', '--help']

/** 回环地址白名单；daemon 只监听本机，体检也只该连本机。 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']

/**
 * 解析 doctor 的参数。
 *
 * 为什么不复用 scripts/lib/daemon-service.mjs 的 parseServiceArgs：那套要求第一个位置参数
 * 必须是 start/stop/…，体检没有子命令、还多一个 --json；硬套会让两边互相迁就越改越歪。
 * @param {readonly string[]} argv 不含 node 与脚本路径
 * @returns {{json: boolean, help: boolean, port: number | undefined, host: string, dataDir: string | undefined, stateDir: string | undefined, tail: number | undefined}}
 */
export function parseDoctorArgs(argv) {
  const options = {
    json: false,
    help: false,
    port: undefined,
    host: '127.0.0.1',
    dataDir: undefined,
    stateDir: undefined,
    tail: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    const eq = raw.indexOf('=')
    const flag = eq === -1 ? raw : raw.slice(0, eq)
    const inline = eq === -1 ? undefined : raw.slice(eq + 1)
    const takeValue = () => {
      if (inline !== undefined) return inline
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error(flag + ' 需要一个值')
      return String(value)
    }
    if (flag === '--help' || flag === '-h') {
      if (inline !== undefined) throw new Error(flag + ' 不接受值')
      options.help = true
    } else if (flag === '--json') {
      if (inline !== undefined) throw new Error('--json 不接受值')
      options.json = true
    } else if (flag === '--port') {
      const value = Number(takeValue())
      if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error('--port 必须是 1~65535 的整数')
      options.port = value
    } else if (flag === '--host') {
      const value = takeValue()
      if (!LOOPBACK_HOSTS.includes(value)) throw new Error('--host 只允许回环地址（' + LOOPBACK_HOSTS.join(' / ') + '），收到 ' + value)
      options.host = value
    } else if (flag === '--data-dir') options.dataDir = requireNonEmpty(takeValue(), '--data-dir')
    else if (flag === '--state-dir') options.stateDir = requireNonEmpty(takeValue(), '--state-dir')
    else if (flag === '--tail') {
      const value = Number(takeValue())
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('--tail 必须是非负整数')
      options.tail = value
    } else throw new Error('未知参数：' + raw + '（可用：' + DOCTOR_FLAGS.join(' ') + '）')
  }
  return options
}

/** 空字符串在 Windows 上会被当成当前目录，提前挡住。 */
function requireNonEmpty(value, flag) {
  if (String(value).trim() === '') throw new Error(flag + ' 不能是空字符串')
  return String(value).trim()
}

/**
 * 人类可读的字节数（B/KB/MB/GB，一位小数）。与 scripts/lib/daemon-service.mjs 的 formatBytes 同格式。
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Math.max(0, Math.floor(Number.isFinite(bytes) ? bytes : 0))
  if (value < 1024) return String(value) + 'B'
  const units = ['KB', 'MB', 'GB']
  let scaled = value / 1024
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return scaled.toFixed(1) + units[unit]
}

/**
 * 把体检快照变成逐条结论。
 *
 * 每条 { level: 'ok' | 'warn' | 'bad', title, detail?, fix? }；顺序就是给人读的顺序：
 * 先位置（状态/数据目录）→ 文件（token/db/settings/凭据）→ 进程（pid/health）→ 日志 → profile。
 * 只有 bad 才算「必须修」，warn 是「看一眼」——退出码据此区分（doctor.mjs 里）。
 * @param {object} snapshot inspect() 的产物
 * @returns {Array<{level: 'ok' | 'warn' | 'bad', title: string, detail?: string, fix?: string}>}
 */
export function diagnose(snapshot) {
  const rows = []
  const add = (level, title, detail, fix) => rows.push({
    level,
    title,
    ...(detail === undefined ? {} : { detail }),
    ...(fix === undefined ? {} : { fix }),
  })

  if (snapshot.stateRoot !== snapshot.dataRoot) {
    add('warn', '状态目录与数据目录不是同一个',
      '状态根 ' + snapshot.stateRoot + '；数据根 ' + snapshot.dataRoot,
      'pid 与日志在状态根，db/token/凭据在数据根。想合到一起：给 start 与 doctor 传同一个 --data-dir。')
  } else {
    add('ok', '状态目录 = 数据目录', snapshot.dataRoot)
  }

  if (snapshot.tokenSize === undefined) {
    add('bad', '没有 daemon.token', snapshot.tokenPath,
      '跑一次 pnpm daemon:start（首次启动会生成 64 字节的 token）。')
  } else {
    add('ok', 'daemon.token 存在', formatBytes(snapshot.tokenSize) + '：' + snapshot.tokenPath)
  }

  if (snapshot.dbSize === undefined) {
    add('warn', '还没有 bigfish.db', snapshot.dbPath, 'daemon 首次启动时创建；从没启动过就属于正常。')
  } else {
    const wal = snapshot.walSize ?? 0
    add('ok', 'SQLite 库存在',
      '主库 ' + formatBytes(snapshot.dbSize) + '，wal ' + formatBytes(wal) + '，shm ' + formatBytes(snapshot.shmSize ?? 0))
    // wal 长期比主库还大，说明 checkpoint 没跑成（进程被强杀时最常见）。
    if (wal > snapshot.dbSize && wal > 1024 * 1024) {
      add('warn', 'wal 比主库还大',
        'wal ' + formatBytes(wal) + ' > 主库 ' + formatBytes(snapshot.dbSize),
        '正常退出时 SQLite 会 checkpoint。跑一次 pnpm daemon:restart 让它合并；反复出现说明进程被强杀。')
    }
  }

  if (snapshot.settings.present !== true) {
    add('ok', '还没有 settings.json', '第一次在面板里保存设置后才出现（默认值写在代码里）。')
  } else if (snapshot.settings.valid !== true) {
    add('bad', 'settings.json 解析失败，daemon 会起不来', snapshot.settings.error,
      '删掉该文件即可回到默认值：' + snapshot.settings.path)
  } else {
    const keys = Array.isArray(snapshot.settings.keys) ? snapshot.settings.keys : []
    add('ok', 'settings.json 可解析', '字段：' + (keys.length === 0 ? '（空）' : keys.join(', ')))
  }

  if (snapshot.credentialCount === 0) {
    add('warn', '凭据目录里没有账号', snapshot.credentialsDir,
      '跑 pnpm daemon:import-account（或面板「账号」tab 扫码）导入登录态；没有账号什么任务都跑不了。')
  } else {
    add('ok', '已导入 ' + String(snapshot.credentialCount) + ' 个账号凭据')
  }

  // daemon 存活：pid 文件 + 进程 + /health 三者交叉，与 daemon:status 同一套判定口径。
  const record = snapshot.pidRecord
  if (snapshot.health.ok === true) {
    const pidText = typeof snapshot.health.pid === 'number' ? '（pid ' + String(snapshot.health.pid) + '）' : ''
    if (record === undefined) {
      add('warn', '端口 ' + String(snapshot.port) + ' 上有 daemon 在跑，但没有 pid 登记' + pidText,
        'pnpm daemon:status 会报 unmanaged，stop 也找不到它',
        '下次 pnpm daemon:start 会接管登记（不会重复启动）。')
    } else if (snapshot.processAlive !== true) {
      add('warn', 'pid 文件指向的进程 ' + String(record.pid) + ' 已不存在，但端口还有应答' + pidText,
        undefined, '直接 pnpm daemon:stop：会按端口上的实例处理，并清理残留 pid 文件。')
    } else {
      add('ok', 'daemon 正在运行（pid ' + String(record.pid) + '，端口 ' + String(snapshot.port) + '）')
    }
  } else if (record !== undefined && snapshot.processAlive === true) {
    add('bad', '进程 ' + String(record.pid) + ' 活着但 /health 不通', snapshot.health.error,
      '看本报告最后的日志尾部；必要时 pnpm daemon:restart。')
  } else if (record !== undefined) {
    add('warn', '残留的 pid 文件（进程已不在）', snapshot.pidPath,
      '跑一次 pnpm daemon:stop 清理，或直接 pnpm daemon:start。')
  } else {
    add('warn', 'daemon 没在跑', '端口 ' + String(snapshot.port), 'pnpm daemon:start；面板的 xy_* 工具全靠它。')
  }

  if (snapshot.logSize === undefined) {
    add('warn', '还没有 daemon 日志', snapshot.logPath, '第一次 start 后生成（<状态目录>/logs/daemon.log）。')
  } else {
    add('ok', 'daemon 日志', formatBytes(snapshot.logSize) + '：' + snapshot.logPath
      + (snapshot.rotatedLogSize === undefined ? '' : '（另有历史 .1 ' + formatBytes(snapshot.rotatedLogSize) + '）'))
  }
  if (snapshot.pluginLogSize !== undefined) {
    add('ok', '插件日志', formatBytes(snapshot.pluginLogSize) + '：' + snapshot.pluginLogPath
      + '（面板拉起 daemon 的失败原因写在这里）')
  }

  // 两份 profile 是历史 bug 的化石：留着会一直吃盘，而且登录态不共享。
  const current = snapshot.profile.current
  const legacy = snapshot.profile.legacy
  if (current.size !== undefined && legacy.size !== undefined && legacy.path !== current.path) {
    add('bad', '存在两份 chrome-profile（登录态不共享，且白占盘）',
      current.path + ' ' + formatBytes(current.size) + '；' + legacy.path + ' ' + formatBytes(legacy.size),
      '新版只用 ' + current.path + '。确认旧的那份里没有想留的登录态后，手动删掉它。')
  } else if (current.size !== undefined) {
    add('ok', 'chrome-profile', formatBytes(current.size) + '：' + current.path)
  } else {
    add('warn', '还没有 chrome-profile', current.path, '第一次扫码登录 / 发布时创建。')
  }

  return rows
}

/**
 * 结论汇总：有 bad → 'bad'，只有 warn → 'warn'，否则 'ok'。退出码与首行都据此决定。
 * @param {readonly {level: string}[]} rows
 * @returns {'ok' | 'warn' | 'bad'}
 */
export function verdictOf(rows) {
  if (rows.some(row => row.level === 'bad')) return 'bad'
  if (rows.some(row => row.level === 'warn')) return 'warn'
  return 'ok'
}

/**
 * 渲染人类可读报告。
 * @param {object} snapshot
 * @param {readonly {level: string, title: string, detail?: string, fix?: string}[]} rows
 * @returns {string}
 */
export function renderReport(snapshot, rows) {
  const icon = { ok: '✔', warn: '!', bad: '✖' }
  const lines = ['bigfish 体检报告（只读，不启动也不修改任何东西）', '']
  for (const row of rows) {
    lines.push((icon[row.level] ?? '?') + ' ' + row.title)
    if (row.detail !== undefined) lines.push('    ' + row.detail)
    if (row.fix !== undefined) lines.push('    → ' + row.fix)
  }
  const tail = Array.isArray(snapshot.logTail) ? snapshot.logTail : []
  if (tail.length > 0) {
    lines.push('', '—— daemon 日志尾部 ' + String(tail.length) + ' 行 ——')
    lines.push(...tail)
  }
  const verdict = verdictOf(rows)
  const bad = rows.filter(row => row.level === 'bad').length
  const warn = rows.filter(row => row.level === 'warn').length
  lines.push('', verdict === 'ok' ? '结论：没有发现需要处理的问题。'
    : '结论：' + String(bad) + ' 条要修，' + String(warn) + ' 条建议看一眼。')
  return lines.join('\n')
}
