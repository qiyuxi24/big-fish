/**
 * 真机验收脚本（scripts/publish-acceptance.mjs）的纯函数层：参数解析、草稿构造、批次判定、报告渲染。
 *
 * 为什么要有这个脚本：真机发布链路（CDP 页面自动化）必须在**非沙箱终端**里跑——DSH 沙箱启动的
 * Chrome 渲染进程起不来（CDP 页面命令超时）。所以把「一条命令跑完混合类目批量 dry-run」沉淀成脚本，
 * 用户在自己终端执行即可，不需要看文档拼 curl。
 *
 * 安全边界：脚本自己拉起一个带 BF_PUBLISH_DRYRUN=1 的 daemon（绝不提交），跑完即停；
 * 复用已运行 daemon（--url）时必须由用户确认它也是 dry-run 启动的。
 *
 * @module scripts/lib/publish-acceptance
 */
import { deflateSync } from 'node:zlib'

/** 队列端口默认值（与 packages/core/src/config.ts 的 DEFAULT_PORT 保持一致；另起端口避免抢用户 daemon）。 */
export const DEFAULT_ACCEPTANCE_PORT = 47991

/** 真机验收默认超时：两条任务 + 写桶退避，5 分钟够用。 */
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 300_000

/** 轮询间隔：批次的 queued/leased 归零即终态。 */
export const DEFAULT_POLL_INTERVAL_MS = 5_000

/** 验收用「支持类目」：网页端发布矩阵里确认可发的一类（docs/auto-publish.md §3.4）。 */
export const SUPPORTED_CATEGORY = '学习笔记'

/** 验收用「不支持类目」：网页端明确不支持，用来验证单条失败不拖垮整批。 */
export const UNSUPPORTED_CATEGORY = '教材教辅'

/** 验收草稿的默认地址（真机历史校准值，见 docs/auto-publish.md §5.1）。 */
export const DEFAULT_ADDRESS = '西北工业大学长安校区星天苑'

/** 支持 --xxx 与 --flag=value 两种写法。 */
const FLAGS_WITH_VALUE = new Set([
  '--port',
  '--url',
  '--data-dir',
  '--chrome-port',
  '--account',
  '--batch-id',
  '--images',
  '--timeout-ms',
  '--interval-ms',
  '--json-out',
])

/** 解析失败时抛的错误：CLI 捕获后打印用法并以退出码 2 结束。 */
class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * 解析命令行。
 *
 * @param {string[]} argv - process.argv.slice(2)。
 * @returns {{help: boolean, port: number, url: string | undefined, dataDir: string | undefined,
 *   chromePort: number, account: string | undefined, batchId: string | undefined,
 *   images: string[] | undefined, timeoutMs: number, intervalMs: number, jsonOut: string | undefined}}
 */
export function parseAcceptanceArgs(argv) {
  const options = {
    help: false,
    port: DEFAULT_ACCEPTANCE_PORT,
    url: undefined,
    dataDir: undefined,
    chromePort: 9222,
    account: undefined,
    batchId: undefined,
    images: undefined,
    timeoutMs: DEFAULT_ACCEPTANCE_TIMEOUT_MS,
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
    jsonOut: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    const [flag, inline] = splitFlag(token)
    if (!FLAGS_WITH_VALUE.has(flag)) throw new UsageError('未知参数：' + token)
    const [value, consumed] = inline === undefined ? [requireNext(argv, index, flag), 1] : [inline, 0]
    index += consumed
    assignOption(options, flag, value)
  }
  return options
}

function splitFlag(token) {
  const at = token.indexOf('=')
  if (at < 0) return [token, undefined]
  return [token.slice(0, at), token.slice(at + 1)]
}

function requireNext(argv, index, flag) {
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('--')) throw new UsageError(flag + ' 需要一个值')
  return next
}

function assignOption(options, flag, value) {
  if (flag === '--port') options.port = parseInteger(value, flag, 1, 65535)
  else if (flag === '--url') options.url = requireUrl(value)
  else if (flag === '--data-dir') options.dataDir = requireText(value, flag)
  else if (flag === '--chrome-port') options.chromePort = parseInteger(value, flag, 1, 65535)
  else if (flag === '--account') options.account = requireText(value, flag)
  else if (flag === '--batch-id') options.batchId = requireBatchId(value)
  else if (flag === '--images') options.images = parseImages(value)
  else if (flag === '--timeout-ms') options.timeoutMs = parseInteger(value, flag, 10_000, 1_800_000)
  else if (flag === '--interval-ms') options.intervalMs = parseInteger(value, flag, 500, 60_000)
  else if (flag === '--json-out') options.jsonOut = requireText(value, flag)
  else throw new UsageError('未知参数：' + flag)
}

function parseInteger(value, flag, min, max) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(flag + ' 必须是 ' + String(min) + '..' + String(max) + ' 的整数，收到 ' + JSON.stringify(value))
  }
  return parsed
}

function requireText(value, flag) {
  const trimmed = String(value).trim()
  if (trimmed === '') throw new UsageError(flag + ' 不能为空')
  return trimmed
}

function requireUrl(value) {
  const trimmed = requireText(value, '--url').replace(/\/+$/, '')
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(trimmed)) {
    throw new UsageError('--url 只允许本机回环地址，例如 http://127.0.0.1:47001，收到 ' + value)
  }
  return trimmed
}

/** 批次 id 规则与 packages/core 的 assertBatchId 对齐（b- 前缀 + 允许的字符）。 */
export function requireBatchId(value) {
  const trimmed = requireText(value, '--batch-id')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new UsageError('--batch-id 只允许字母数字与 ._-（首字符不能是符号），收到 ' + trimmed)
  }
  return trimmed
}

function parseImages(value) {
  const paths = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (paths.length === 0) throw new UsageError('--images 至少要一张图片的绝对路径')
  for (const path of paths) {
    if (!isAbsolutePath(path)) throw new UsageError('图片必须是本机绝对路径：' + path)
  }
  return paths
}

/** 与 daemon 的草稿校验同口径：POSIX 绝对路径或 Windows 盘符绝对路径。 */
export function isAbsolutePath(path) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * 数据根目录：Windows 走 LOCALAPPDATA，其他平台走 ~/.local/share（与 packages/core/src/config.ts 一致）。
 *
 * @param {Record<string, string | undefined>} env
 * @param {() => string} homedir - 注入 home 目录读取（测试用）。
 * @param {string} platform - process.platform 注入。
 * @returns {string}
 */
export function resolveDataRoot(env, homedir, platform) {
  const sep = platform === 'win32' ? '\\' : '/'
  if (platform === 'win32') {
    const userProfile = env['USERPROFILE']
    const localAppData = env['LOCALAPPDATA'] ?? (userProfile === undefined ? undefined : joinPath(userProfile, sep, 'AppData', 'Local'))
    return joinPath(localAppData ?? homedir(), sep, 'bigfish')
  }
  return joinPath(homedir(), sep, '.local', 'share', 'bigfish')
}

function joinPath(base, sep, ...rest) {
  return [base.replace(/[\\/]+$/, ''), ...rest].join(sep)
}

/**
 * 构造两条验收草稿：第一条用支持类目（应 done），第二条用不支持类目（应 failed 且不拖垮整批）。
 *
 * @param {{accountId: string, images: string[], stamp: string, address?: string}} input
 * @returns {{supported: object, unsupported: object}}
 */
export function buildAcceptanceDrafts(input) {
  const address = input.address ?? DEFAULT_ADDRESS
  const supported = {
    kind: 'publish',
    dedupeKey: 'publish:accept-' + input.stamp + '-ok',
    payload: {
      accountId: input.accountId,
      title: '高数笔记 手写整理 考研复习（验收勿拍）',
      desc: '自动发布链路验收草稿：仅用于验证「批量入队 → CDP 步骤机」链路，不会真的上架（dry-run）。\n请勿拍下。',
      priceCents: 100,
      images: input.images,
      shipping: 'free',
      category: SUPPORTED_CATEGORY,
      address,
    },
  }
  const unsupported = {
    kind: 'publish',
    dedupeKey: 'publish:accept-' + input.stamp + '-bad',
    payload: {
      accountId: input.accountId,
      title: '二手教材 教辅（验收预期失败）',
      desc: '自动发布链路验收草稿：验证「同批里一条类目不支持时，另一条仍能继续」。请勿拍下。',
      priceCents: 100,
      images: input.images,
      shipping: 'free',
      category: UNSUPPORTED_CATEGORY,
      address,
    },
  }
  return { supported, unsupported }
}

/** 批次里还有任务在排队/执行中吗。 */
export function isTerminal(counts) {
  return (counts['queued'] ?? 0) === 0 && (counts['leased'] ?? 0) === 0
}

/**
 * 判定验收是否通过。
 *
 * 期望：支持类目那条 done；不支持类目那条 failed（非可重试）；批次 total=2；没有 needs_review 以外的不确定态。
 *
 * @param {{total: number, counts: Record<string, number>, tasks: {state: string, lastError?: string, dedupeKey?: string}[]}} batch
 * @returns {{pass: boolean, reasons: string[]}}
 */
export function evaluateOutcome(batch) {
  // daemon 的 BatchStats 把明细放在 items（前 200 条 TaskRecord）；tasks 只在测试与旧调用里出现。
  const tasks = batch.tasks ?? batch.items ?? []
  const reasons = []
  if (batch.total !== 2) reasons.push('批次任务数应为 2，实际 ' + String(batch.total))
  if ((batch.counts['done'] ?? 0) !== 1) reasons.push('done 应为 1，实际 ' + String(batch.counts['done'] ?? 0))
  if ((batch.counts['failed'] ?? 0) !== 1) reasons.push('failed 应为 1，实际 ' + String(batch.counts['failed'] ?? 0))
  const bad = tasks.find((task) => task.state === 'failed')
  if (bad === undefined) reasons.push('没有找到 failed 的那条任务（不支持类目应失败）')
  else if (!/分类|类目|category/i.test(bad.lastError ?? '')) {
    reasons.push('failed 任务的原因不像「类目不支持」：' + String(bad.lastError ?? '').slice(0, 120))
  }
  const done = tasks.find((task) => task.state === 'done')
  if (done === undefined) reasons.push('没有找到 done 的那条任务（支持类目应成功填表）')
  return { pass: reasons.length === 0, reasons }
}

/**
 * 渲染终端报告。
 *
 * @param {{batchId: string, batch: object, verdict: {pass: boolean, reasons: string[]}, screenshotsDir: string, daemonUrl: string}} input
 * @returns {string}
 */
export function formatReport(input) {
  const lines = []
  lines.push('')
  lines.push('批次 ' + input.batchId + '（daemon ' + input.daemonUrl + '）')
  lines.push('总计 ' + String(input.batch.total) + ' 条，状态分布 ' + JSON.stringify(input.batch.counts))
  for (const task of input.batch.tasks ?? input.batch.items ?? []) {
    lines.push('  - ' + task.state.padEnd(14) + String(task.dedupeKey ?? task.id) + (task.lastError ? ' | ' + String(task.lastError).replace(/\s+/g, ' ').slice(0, 140) : ''))
  }
  lines.push('')
  lines.push(input.verdict.pass ? '✔ 验收通过：同批一条成功、一条失败，互不拖累' : '✖ 验收未通过')
  for (const reason of input.verdict.reasons) lines.push('  · ' + reason)
  lines.push('截图 ' + input.screenshotsDir)
  return lines.join('\n')
}

/**
 * 生成一张纯色 PNG（真机验收用图片，不往仓库提交二进制）。
 *
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number]} rgb
 * @returns {Buffer}
 */
export function makeSolidPng(width, height, rgb) {
  const [r, g, b] = rgb
  const rowLength = width * 3 + 1
  const raw = Buffer.alloc(rowLength * height)
  for (let y = 0; y < height; y += 1) {
    const offset = y * rowLength
    raw[offset] = 0
    for (let x = 0; x < width; x += 1) {
      const at = offset + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const idat = deflateSync(raw)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export { UsageError }
