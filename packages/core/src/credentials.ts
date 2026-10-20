/**
 * 账号凭据加密落盘：AES-256-GCM + 每目录 32 字节随机主密钥（权限 0600）。
 * 密文文件为 <dir>/<accountId>.cred.json，内容 {v,iv,tag,data} 全 base64，不含明文。
 * 注意：Windows 的文件权限语义弱于 POSIX，0600 只是尽力而为。
 * @module @bigfish/core/credentials
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { XianyuError, fail } from './errors.ts'

/** 账号 id：只允许安全字符，避免路径穿越与跨平台文件名问题。 */
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const FILE_VERSION = 1
const FILE_SUFFIX = '.cred.json'

export interface CredentialRecord {
  accountId: string
  cookies: Record<string, string>
  updatedAt: number
  meta?: Record<string, unknown>
}

export interface CredentialSaveInput {
  accountId: string
  cookies: Record<string, string>
  meta?: Record<string, unknown>
}

export interface CredentialStoreOptions {
  dir: string
  /** 主密钥路径，默认 <dir>/credential.key。 */
  keyPath?: string
  now?: () => number
}

interface CipherFile {
  v: number
  iv: string
  tag: string
  data: string
}

export class CredentialStore {
  readonly dir: string
  readonly keyPath: string
  readonly now: () => number
  keyCache: Buffer | undefined = undefined

  constructor(options: CredentialStoreOptions) {
    if (options.dir.trim() === '') throw new TypeError('CredentialStore.dir 不能为空')
    this.dir = resolve(options.dir)
    this.keyPath = options.keyPath === undefined ? join(this.dir, 'credential.key') : resolve(options.keyPath)
    this.now = options.now ?? Date.now
  }

  /** 加密保存（覆盖同名账号的旧凭据）。 */
  async save(input: CredentialSaveInput): Promise<void> {
    const accountId = assertAccountId(input.accountId)
    const cookies = assertCookies(input.cookies)
    const key = await this.ensureKey()
    const record: CredentialRecord = {
      accountId,
      cookies,
      updatedAt: Math.trunc(this.now()),
      ...(input.meta === undefined ? {} : { meta: input.meta }),
    }
    const body = encryptRecord(record, key)
    const target = this.recordPath(accountId)
    const tmp = target + '.tmp'
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await writeFile(tmp, JSON.stringify(body), { mode: 0o600 })
      await rename(tmp, target)
    } catch (error) {
      try {
        await rm(tmp, { force: true })
      } catch {
        // 清理临时文件失败不覆盖真正的写入错误。
      }
      throw new XianyuError({ code: 'STORAGE', message: '凭据写入失败: ' + accountId, cause: error })
    }
  }

  /** 读取并解密；账号不存在返回 undefined。 */
  async load(accountId: string): Promise<CredentialRecord | undefined> {
    const id = assertAccountId(accountId)
    const target = this.recordPath(id)
    let text: string
    try {
      text = await readFile(target, 'utf8')
    } catch (error) {
      if (isFsErrorCode(error, 'ENOENT')) return undefined
      throw new XianyuError({ code: 'STORAGE', message: '凭据读取失败: ' + id, cause: error })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new XianyuError({ code: 'STORAGE', message: '凭据文件损坏: ' + id, cause: error })
    }
    const key = await this.ensureKey()
    return decryptRecord(parsed, key, id)
  }

  /** 已保存的账号 id 列表（按文件名，不解密）。 */
  async list(): Promise<string[]> {
    let entries: Dirent[] = []
    try {
      entries = await readdir(this.dir, { withFileTypes: true })
    } catch (error) {
      if (isFsErrorCode(error, 'ENOENT')) return []
      throw new XianyuError({ code: 'STORAGE', message: '凭据目录读取失败: ' + this.dir, cause: error })
    }
    const ids: string[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(FILE_SUFFIX)) continue
      const id = entry.name.slice(0, -FILE_SUFFIX.length)
      if (ACCOUNT_ID_RE.test(id)) ids.push(id)
    }
    return ids.sort()
  }

  /** 删除凭据；返回是否真的删掉了。 */
  async remove(accountId: string): Promise<boolean> {
    const id = assertAccountId(accountId)
    try {
      await unlink(this.recordPath(id))
      return true
    } catch (error) {
      if (isFsErrorCode(error, 'ENOENT')) return false
      throw new XianyuError({ code: 'STORAGE', message: '凭据删除失败: ' + id, cause: error })
    }
  }

  /** 读取或创建主密钥；并发创建时以先写入者为准。 */
  async ensureKey(): Promise<Buffer> {
    if (this.keyCache !== undefined) return this.keyCache
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    let key: Buffer
    try {
      key = await readFile(this.keyPath)
    } catch (error) {
      if (!isFsErrorCode(error, 'ENOENT')) {
        throw new XianyuError({ code: 'STORAGE', message: '主密钥读取失败: ' + this.keyPath, cause: error })
      }
      key = await this.createKey(this.keyPath)
    }
    if (key.length !== KEY_BYTES) {
      throw new XianyuError({
        code: 'STORAGE',
        message: '主密钥长度非法（期望 ' + String(KEY_BYTES) + ' 字节，实际 ' + String(key.length) + ' 字节）',
      })
    }
    this.keyCache = key
    return key
  }

  /** 独占创建主密钥；EEXIST 说明并发方已经写好，读回来复用同一把密钥。 */
  async createKey(path: string): Promise<Buffer> {
    const candidate = randomBytes(KEY_BYTES)
    try {
      await writeFile(path, candidate, { mode: 0o600, flag: 'wx' })
      return candidate
    } catch (error) {
      if (!isFsErrorCode(error, 'EEXIST')) {
        throw new XianyuError({ code: 'STORAGE', message: '主密钥创建失败: ' + path, cause: error })
      }
      try {
        return await readFile(path)
      } catch (readError) {
        throw new XianyuError({ code: 'STORAGE', message: '主密钥读取失败: ' + path, cause: readError })
      }
    }
  }

  recordPath(accountId: string): string {
    return join(this.dir, accountId + FILE_SUFFIX)
  }
}

function assertAccountId(value: string): string {
  if (typeof value !== 'string' || !ACCOUNT_ID_RE.test(value) || value === '.' || value === '..') {
    fail('VALIDATION', '非法 accountId: ' + String(value).slice(0, 80))
  }
  return value
}

function assertCookies(value: Record<string, string>): Record<string, string> {
  const input: unknown = value
  if (!isRecord(input)) fail('VALIDATION', 'cookies 必须是对象')
  const cookies: Record<string, string> = {}
  for (const [name, cookieValue] of Object.entries(input)) {
    if (typeof cookieValue !== 'string') fail('VALIDATION', 'cookies.' + name + ' 必须是字符串')
    cookies[name] = cookieValue
  }
  return cookies
}

function encryptRecord(record: CredentialRecord, key: Buffer): CipherFile {
  let plaintext: Buffer
  try {
    plaintext = Buffer.from(JSON.stringify(record), 'utf8')
  } catch (error) {
    throw new XianyuError({ code: 'VALIDATION', message: '凭据内容无法序列化（meta 里可能有循环引用）', cause: error })
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  plaintext.fill(0)
  return { v: FILE_VERSION, iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') }
}

function decryptRecord(body: unknown, key: Buffer, accountId: string): CredentialRecord {
  const file = parseCipherFile(body, accountId)
  const iv = Buffer.from(file.iv, 'base64')
  const tag = Buffer.from(file.tag, 'base64')
  const data = Buffer.from(file.data, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || data.length === 0) {
    throw new XianyuError({ code: 'STORAGE', message: '凭据文件格式非法: ' + accountId })
  }
  let plaintext: Buffer
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(data), decipher.final()])
  } catch (error) {
    throw new XianyuError({ code: 'STORAGE', message: '凭据解密失败（主密钥可能已更换）: ' + accountId, cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext.toString('utf8'))
  } catch (error) {
    throw new XianyuError({ code: 'STORAGE', message: '凭据内容损坏: ' + accountId, cause: error })
  }
  plaintext.fill(0)
  return toCredentialRecord(parsed, accountId)
}

function parseCipherFile(body: unknown, accountId: string): CipherFile {
  if (!isRecord(body)) {
    throw new XianyuError({ code: 'STORAGE', message: '凭据文件格式非法: ' + accountId })
  }
  const version = body['v']
  const iv = body['iv']
  const tag = body['tag']
  const data = body['data']
  if (version !== FILE_VERSION || typeof iv !== 'string' || typeof tag !== 'string' || typeof data !== 'string') {
    throw new XianyuError({ code: 'STORAGE', message: '凭据文件格式非法: ' + accountId })
  }
  return { v: FILE_VERSION, iv, tag, data }
}

function toCredentialRecord(value: unknown, accountId: string): CredentialRecord {
  if (!isRecord(value)) {
    throw new XianyuError({ code: 'STORAGE', message: '凭据内容损坏: ' + accountId })
  }
  if (value['accountId'] !== accountId) {
    throw new XianyuError({ code: 'STORAGE', message: '凭据账号不匹配: ' + accountId })
  }
  const updatedAt = value['updatedAt']
  if (!isInteger(updatedAt)) {
    throw new XianyuError({ code: 'STORAGE', message: '凭据内容损坏: ' + accountId })
  }
  const rawCookies = value['cookies']
  if (!isRecord(rawCookies)) {
    throw new XianyuError({ code: 'STORAGE', message: '凭据内容损坏: ' + accountId })
  }
  const cookies: Record<string, string> = {}
  for (const [name, cookieValue] of Object.entries(rawCookies)) {
    if (typeof cookieValue !== 'string') {
      throw new XianyuError({ code: 'STORAGE', message: '凭据内容损坏: ' + accountId })
    }
    cookies[name] = cookieValue
  }
  const rawMeta = value['meta']
  const meta = isRecord(rawMeta) ? rawMeta : undefined
  return { accountId, cookies, updatedAt, ...(meta === undefined ? {} : { meta }) }
}

function isFsErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
