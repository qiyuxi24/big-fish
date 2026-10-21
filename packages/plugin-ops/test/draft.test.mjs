import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPublishCommand, draftDedupeKey, loadPublishDraft, validatePublishDraft } from '../src/draft.js'
import { DaemonError } from '../src/client.js'

/** 合法草稿：价格是整数分，图片是 Windows 绝对路径。 */
const valid = { title: '测试商品', desc: '这是一段描述', priceCents: 1990, images: ['D:\\pics\\a.png'] }

function expectValidation(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DaemonError, '应当是 DaemonError')
    assert.equal(error.code, 'VALIDATION')
    assert.match(error.message, pattern)
    return true
  })
}

test('合法草稿被规范化：可选字段不出现即 undefined', () => {
  const draft = validatePublishDraft(valid)
  assert.equal(draft.title, '测试商品')
  assert.equal(draft.desc, '这是一段描述')
  assert.equal(draft.priceCents, 1990)
  assert.deepEqual(draft.images, ['D:\\pics\\a.png'])
  assert.equal(draft.quantity, undefined)
  assert.equal(draft.shipping, undefined)
  assert.equal(draft.pricingMode, undefined)
  assert.equal(draft.address, undefined)
  assert.equal(draft.category, undefined)
})

test('priceCents 必须是正整数分（拒绝浮点、0、字符串、超安全整数）', () => {
  for (const priceCents of [19.9, 0, -100, '1990', Number.MAX_SAFE_INTEGER + 2]) {
    expectValidation(() => validatePublishDraft({ ...valid, priceCents }), /priceCents/)
  }
})

test('desc/title/图片字段类型不对直接报 VALIDATION', () => {
  expectValidation(() => validatePublishDraft({ ...valid, desc: '   ' }), /desc/)
  expectValidation(() => validatePublishDraft({ ...valid, title: 42 }), /title/)
  expectValidation(() => validatePublishDraft({ ...valid, images: [] }), /images/)
  expectValidation(() => validatePublishDraft({ ...valid, images: ['/abs/a.png', 'relative.png'] }), /绝对路径/)
  expectValidation(() => validatePublishDraft({ ...valid, images: [42] }), /images\[0\]/)
})

test('shipping/quantity 只接受约定取值', () => {
  expectValidation(() => validatePublishDraft({ ...valid, shipping: 'paid' }), /shipping/)
  expectValidation(() => validatePublishDraft({ ...valid, quantity: 0 }), /quantity/)
  expectValidation(() => validatePublishDraft({ ...valid, quantity: 1.5 }), /quantity/)
  assert.equal(validatePublishDraft({ ...valid, shipping: 'free', quantity: 2 }).quantity, 2)
})

test('loadPublishDraft：读文件失败与 JSON 坏都收敛成 VALIDATION', async () => {
  await assert.rejects(
    loadPublishDraft('x', async () => { throw new Error('ENOENT') }),
    (error) => error instanceof DaemonError && error.code === 'VALIDATION' && /读不到草稿文件/.test(error.message),
  )
  await assert.rejects(
    loadPublishDraft('x', async () => '{not json'),
    (error) => error instanceof DaemonError && error.code === 'VALIDATION' && /合法 JSON/.test(error.message),
  )
  const draft = await loadPublishDraft('x', async () => JSON.stringify(valid))
  assert.equal(draft.priceCents, 1990)
})

test('category 可选：类型不对报 VALIDATION，参与幂等键', () => {
  const withCategory = validatePublishDraft({ ...valid, category: '电子资料' })
  assert.equal(withCategory.category, '电子资料')
  expectValidation(() => validatePublishDraft({ ...valid, category: 42 }), /category/)
  const plain = draftDedupeKey(validatePublishDraft(valid))
  const categorized = draftDedupeKey(withCategory)
  assert.notEqual(plain, categorized, '换分类等于换发布目标，不能复用幂等键')
  assert.equal(categorized, draftDedupeKey(validatePublishDraft({ ...valid, category: '电子资料' })))
})

test('幂等键：同样内容同键，改价格换键，形态固定', () => {
  const first = draftDedupeKey(validatePublishDraft(valid))
  const second = draftDedupeKey(validatePublishDraft({ ...valid }))
  const changed = draftDedupeKey(validatePublishDraft({ ...valid, priceCents: 2990 }))
  assert.match(first, /^publish:[0-9a-f]{8}$/)
  assert.equal(first, second)
  assert.notEqual(first, changed)
})

test('buildPublishCommand：dry-run 不带 --submit，含空格路径加引号', () => {
  const dryRun = buildPublishCommand({ draftPath: 'C:\\tmp\\draft.json' })
  assert.equal(dryRun, 'npm run daemon:publish -- --draft C:\\tmp\\draft.json')
  assert.equal(dryRun.includes('--submit'), false)

  const full = buildPublishCommand({
    draftPath: 'C:\\tmp dir\\draft.json',
    submit: true,
    accountId: 'acc-1',
    chromePort: 9333,
    screenshotsDir: 'C:/tmp/shots',
  })
  assert.match(full, /--draft "C:\\tmp dir\\draft.json"/)
  assert.match(full, /--submit/)
  assert.match(full, /--account-id acc-1/)
  assert.match(full, /--chrome-port 9333/)
  assert.match(full, /--screenshots C:\/tmp\/shots/)
})
