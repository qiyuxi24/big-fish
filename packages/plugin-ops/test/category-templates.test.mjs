/**
 * 品类模板守卫：面板「打印机」的字段清单必须与 skill 输入契约、成色枚举保持一致。
 * 这些断言的目的是让「改模板忘了改契约」在单测阶段就红。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CONDITION_LABELS, CONDITIONS } from '../src/copy.js'
import {
  CATEGORY_IDS,
  CATEGORY_TEMPLATES,
  COMMON_FIELDS,
  findCategoryTemplate,
  listCategoryTemplates,
} from '../src/category-templates.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const inputSchemaPath = join(repoRoot, '.agents', 'skills', 'xianyu-listing-copy', 'references', 'input-schema.json')

const FIELD_TYPES = new Set(['text', 'enum', 'integer', 'list', 'bool'])
/** 品类字段 id 会变成 specs 的键，限制比 common 更严。 */
const SPEC_KEY_RE = /^[a-z][a-z0-9]{0,15}$/
const COMMON_ID_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/

function assertField(field, where) {
  assert.equal(typeof field.id, 'string', where + '.id 必须是字符串')
  assert.equal(typeof field.label, 'string', where + '.label 必须是字符串')
  assert.ok(FIELD_TYPES.has(field.type), where + '.type 非法：' + String(field.type))
  assert.ok(field.group === 'base' || field.group === 'media' || field.group === 'story' || field.group === 'specs', where + '.group 非法')
  if (field.type === 'enum') {
    assert.ok(Array.isArray(field.options) && field.options.length > 0, where + ' 是 enum 但没给 options')
    for (const option of field.options) {
      assert.equal(typeof option.value, 'string')
      assert.equal(typeof option.label, 'string')
    }
    if (field.required === true) assert.equal('default' in field, false, where + ' 必填时不该有 default（缺省不猜）')
  }
  if (field.type === 'integer') {
    assert.equal(Number.isInteger(field.min), true, where + ' 缺 min')
    assert.equal(Number.isInteger(field.max), true, where + ' 缺 max')
  }
  if (field.type === 'list') assert.equal(Number.isInteger(field.maxItems), true, where + ' 缺 maxItems')
  if (field.maxLength !== undefined) assert.ok(field.maxLength > 0 && field.maxLength <= 200, where + '.maxLength 越界')
}

test('common 字段：id 唯一、类型/约束合法、必填只有面板能提供的那几项', () => {
  const ids = new Set()
  for (const field of COMMON_FIELDS) {
    assertField(field, 'common.' + field.id)
    assert.match(field.id, COMMON_ID_RE)
    assert.equal(ids.has(field.id), false, 'common 字段 id 重复：' + field.id)
    ids.add(field.id)
  }
  // 面板无法选文件、也不该替用户猜成色：必填只保留这三项（imagePaths 由对话补）。
  assert.deepEqual(COMMON_FIELDS.filter(field => field.required === true).map(field => field.id).sort(), ['condition', 'priceYuan', 'productName'])
  assert.equal(ids.has('imagePaths'), true)
  assert.equal(ids.has('reason'), true)
  assert.equal(ids.has('usedMonths'), true)
})

test('品类模板：id 唯一，规格键可用于 specs，且不允许跨品类重名冲突', () => {
  assert.equal(new Set(CATEGORY_IDS).size, CATEGORY_IDS.length)
  for (const category of CATEGORY_TEMPLATES) {
    assert.match(category.id, /^[a-z][a-z0-9-]{0,15}$/)
    assert.ok(category.label.length > 0)
    const specIds = new Set()
    for (const field of category.specs) {
      assertField(field, category.id + '.' + field.id)
      assert.equal(field.group, 'specs')
      assert.match(field.id, SPEC_KEY_RE, '规格键必须是 specs 可用的短英文：' + field.id)
      assert.equal(specIds.has(field.id), false, category.id + ' 规格字段重复：' + field.id)
      specIds.add(field.id)
    }
  }
  // 「其他」不预设规格：问了也是空，反而诱导模型编参数。
  assert.deepEqual(findCategoryTemplate('other')?.specs, [])
  assert.equal(findCategoryTemplate('nope'), undefined)
})

test('成色枚举与 src/copy.js 权威定义一致（含中文名）', () => {
  const condition = COMMON_FIELDS.find(field => field.id === 'condition')
  assert.deepEqual(condition.options.map(option => option.value), CONDITIONS)
  assert.deepEqual(condition.options.map(option => option.label), CONDITIONS.map(value => CONDITION_LABELS[value]))
})

test('必填字段覆盖 skill 输入契约的 required（priceCents 由 priceYuan 换算）', () => {
  const schema = JSON.parse(readFileSync(inputSchemaPath, 'utf8'))
  const provided = new Set([...COMMON_FIELDS, ...CATEGORY_TEMPLATES.flatMap(category => category.specs)].map(field => field.id))
  const alias = { priceCents: 'priceYuan' }
  for (const key of schema.required) {
    const mapped = alias[key] ?? key
    assert.equal(provided.has(mapped), true, 'skill 要求必填的 ' + key + ' 在面板模板里没有入口')
  }
  // 契约里新增的选填字段，模板要么给入口，要么明确不归面板管（imagePaths 已给）。
  const templated = new Set([...provided])
  for (const key of Object.keys(schema.properties)) {
    const mapped = alias[key] ?? key
    if (templated.has(mapped)) continue
    // specs 由品类规格字段逐项填充（不是模板里的单个字段），其余是面板暂不管的。
    assert.ok(['specs', 'variantCount', 'marketPriceCents', 'tone', 'categoryHint'].includes(key), '契约字段 ' + key + ' 没有面板入口，也没登记为「面板不管」')
  }
})

test('listCategoryTemplates 返回深拷贝：调用方改返回值不会污染模块常量', () => {
  const first = listCategoryTemplates()
  first.common[0].label = '被改掉了'
  first.categories[0].specs.push({ id: 'hack', label: 'hack', type: 'text', group: 'specs' })
  const second = listCategoryTemplates()
  assert.equal(second.common[0].label, COMMON_FIELDS[0].label)
  assert.equal(second.categories[0].specs.length, CATEGORY_TEMPLATES[0].specs.length)
})
