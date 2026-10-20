import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CredentialStore } from '../src/credentials.ts'
import { XianyuError } from '../src/errors.ts'

const scratchRoot = fileURLToPath(new URL('../../../.scratch/', import.meta.url))
const UPDATED_AT = 1_700_000_000_123
let workDir = ''

before(async () => {
  await mkdir(scratchRoot, { recursive: true })
  workDir = await mkdtemp(join(scratchRoot, 'core-credentials-'))
})

after(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function dirIn(name: string): string {
  return join(workDir, name)
}

function validationError(error: unknown): boolean {
  assert.ok(error instanceof XianyuError, '应抛 XianyuError')
  assert.equal(error.code, 'VALIDATION')
  return true
}

function storageError(error: unknown): boolean {
  assert.ok(error instanceof XianyuError, '应抛 XianyuError')
  assert.equal(error.code, 'STORAGE')
  return true
}

test('save/load 往返保留 cookies、updatedAt 与 meta', async () => {
  const store = new CredentialStore({ dir: dirIn('roundtrip'), now: () => UPDATED_AT })
  await store.save({
    accountId: 'acc-1',
    cookies: { _m_h5_tk: 'tk-123456789', cookie2: 'hidden-value-abc' },
    meta: { nickname: '小号' },
  })
  const loaded = await store.load('acc-1')
  assert.ok(loaded !== undefined)
  assert.equal(loaded.accountId, 'acc-1')
  assert.deepEqual(loaded.cookies, { _m_h5_tk: 'tk-123456789', cookie2: 'hidden-value-abc' })
  assert.equal(loaded.updatedAt, UPDATED_AT)
  assert.deepEqual(loaded.meta, { nickname: '小号' })
})

test('密文落盘：文件里搜不到 cookie 明文，主密钥为 32 字节', async () => {
  const dir = dirIn('encrypted')
  const store = new CredentialStore({ dir, now: () => UPDATED_AT })
  const cookieValue = 'plaintext-cookie-value-should-not-leak'
  await store.save({ accountId: 'acc-1', cookies: { _m_h5_tk: cookieValue } })
  const recordPath = join(dir, 'acc-1.cred.json')
  const text = await readFile(recordPath, 'utf8')
  assert.ok(!text.includes(cookieValue))
  assert.ok(!text.includes('_m_h5_tk'))
  const body: unknown = JSON.parse(text)
  assert.equal(typeof body, 'object')
  assert.notEqual(body, null)
  const fields = body as Record<string, unknown>
  assert.equal(fields['v'], 1)
  for (const key of ['iv', 'tag', 'data']) {
    assert.equal(typeof fields[key], 'string')
  }
  assert.match(String(fields['data']), /^[A-Za-z0-9+/]+={0,2}$/)
  const keyBytes = await readFile(join(dir, 'credential.key'))
  assert.equal(keyBytes.length, 32)
})

test('主密钥复用：换实例不换密钥，旧凭据仍可解密', async () => {
  const dir = dirIn('reuse')
  const first = new CredentialStore({ dir, now: () => UPDATED_AT })
  await first.save({ accountId: 'acc-1', cookies: { a: 'one' } })
  const keyBefore = await readFile(join(dir, 'credential.key'))
  const second = new CredentialStore({ dir, now: () => UPDATED_AT })
  await second.save({ accountId: 'acc-2', cookies: { b: 'two' } })
  const keyAfter = await readFile(join(dir, 'credential.key'))
  assert.deepEqual(keyAfter, keyBefore)
  assert.deepEqual((await second.load('acc-1'))?.cookies, { a: 'one' })
  assert.deepEqual((await second.load('acc-2'))?.cookies, { b: 'two' })
})

test('list 返回排序后的账号，remove 幂等', async () => {
  const dir = dirIn('list')
  const store = new CredentialStore({ dir, now: () => UPDATED_AT })
  await store.save({ accountId: 'acc-2', cookies: { a: '1' } })
  await store.save({ accountId: 'acc-1', cookies: { a: '2' } })
  assert.deepEqual(await store.list(), ['acc-1', 'acc-2'])
  assert.equal(await store.remove('acc-1'), true)
  assert.equal(await store.remove('acc-1'), false)
  assert.deepEqual(await store.list(), ['acc-2'])
  assert.equal(await store.load('acc-1'), undefined)
})

test('目录不存在时 list 返回空数组', async () => {
  const store = new CredentialStore({ dir: dirIn('missing') })
  assert.deepEqual(await store.list(), [])
})

test('非法 accountId 抛 VALIDATION', async () => {
  const store = new CredentialStore({ dir: dirIn('validation') })
  for (const accountId of ['', 'a/b', 'a b', '..', '.', 'x'.repeat(65), '账号一']) {
    await assert.rejects(store.load(accountId), validationError)
    await assert.rejects(store.remove(accountId), validationError)
    await assert.rejects(store.save({ accountId, cookies: {} }), validationError)
  }
  assert.ok(await store.load('x'.repeat(64)) === undefined)
})

test('cookies 值必须是字符串', async () => {
  const store = new CredentialStore({ dir: dirIn('cookie-validation') })
  const cookies = { a: 42 } as unknown as Record<string, string>
  await assert.rejects(store.save({ accountId: 'acc-1', cookies }), validationError)
})

test('主密钥被替换后解密失败抛 STORAGE，不泄露明文', async () => {
  const dir = dirIn('wrong-key')
  const store = new CredentialStore({ dir, now: () => UPDATED_AT })
  await store.save({ accountId: 'acc-1', cookies: { a: 'secret-cookie' } })
  await writeFile(join(dir, 'credential.key'), randomBytes(32))
  const reopened = new CredentialStore({ dir, now: () => UPDATED_AT })
  await assert.rejects(reopened.load('acc-1'), (error: unknown) => {
    storageError(error)
    assert.ok(error instanceof Error)
    assert.ok(!error.message.includes('secret-cookie'))
    return true
  })
})

test('损坏的凭据文件抛 STORAGE', async () => {
  const dir = dirIn('corrupt')
  const store = new CredentialStore({ dir })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'bad.cred.json'), 'not-json', 'utf8')
  await assert.rejects(store.load('bad'), storageError)
  await writeFile(join(dir, 'shape.cred.json'), JSON.stringify({ v: 2 }), 'utf8')
  await assert.rejects(store.load('shape'), storageError)
})

test('POSIX 下主密钥权限为 0600', async () => {
  if (process.platform === 'win32') return
  const dir = dirIn('mode')
  const store = new CredentialStore({ dir, now: () => UPDATED_AT })
  await store.save({ accountId: 'acc-1', cookies: { a: '1' } })
  const info = await stat(join(dir, 'credential.key'))
  assert.equal(info.mode & 0o777, 0o600)
})
