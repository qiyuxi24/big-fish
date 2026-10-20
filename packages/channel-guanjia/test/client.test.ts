import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, GuanJiaClient } from '../src/client.ts'
import { PATHS } from '../src/methods.ts'
import { computeSign } from '../src/sign.ts'
import {
  TEST_BASE_URL,
  TEST_CREDENTIALS,
  TEST_NOW,
  captureError,
  captureRejection,
  createClient,
  createFakeTransport,
  okReply
} from './helpers.ts'

interface MethodCase {
  name: string
  invoke: (client: GuanJiaClient) => Promise<unknown>
  path: string
  body: Record<string, unknown>
}

const METHOD_CASES: MethodCase[] = [
  { name: 'shops', invoke: (c) => c.shops(), path: '/api/user/shops', body: {} },
  { name: 'categories', invoke: (c) => c.categories(), path: '/api/product/categories', body: {} },
  { name: 'attributes', invoke: (c) => c.attributes(12), path: '/api/product/attributes', body: { category_id: 12 } },
  { name: 'productList 默认分页', invoke: (c) => c.productList(), path: '/api/product/list', body: { page: 1, page_size: 20 } },
  {
    name: 'productList 自定义分页与状态',
    invoke: (c) => c.productList({ page: 2, pageSize: 50, status: 1 }),
    path: '/api/product/list',
    body: { page: 2, page_size: 50, status: 1 }
  },
  { name: 'productDetail', invoke: (c) => c.productDetail(7), path: '/api/product/detail', body: { product_id: 7 } },
  { name: 'skus', invoke: (c) => c.skus(7), path: '/api/product/skus', body: { product_id: 7 } },
  {
    name: 'createProduct 原样透传',
    invoke: (c) => c.createProduct({ title: '测试商品', price: 1990 }),
    path: '/api/product/create',
    body: { title: '测试商品', price: 1990 }
  },
  {
    name: 'createProductsBatch',
    invoke: (c) => c.createProductsBatch([{ title: 'a' }, { title: 'b' }]),
    path: '/api/product/create_batch',
    body: { products: [{ title: 'a' }, { title: 'b' }] }
  },
  { name: 'publishProduct', invoke: (c) => c.publishProduct(7), path: '/api/product/publish', body: { product_id: 7 } },
  { name: 'unpublishProduct', invoke: (c) => c.unpublishProduct(7), path: '/api/product/unpublish', body: { product_id: 7 } },
  {
    name: 'updateProduct',
    invoke: (c) => c.updateProduct(7, { title: '新标题' }),
    path: '/api/product/update',
    body: { title: '新标题', product_id: 7 }
  },
  { name: 'updateStock 单规格', invoke: (c) => c.updateStock(7, 5), path: '/api/product/update_stock', body: { product_id: 7, stock: 5 } },
  {
    name: 'updateStock 带 sku',
    invoke: (c) => c.updateStock(7, 5, 88),
    path: '/api/product/update_stock',
    body: { product_id: 7, stock: 5, sku_id: 88 }
  },
  { name: 'deleteProduct', invoke: (c) => c.deleteProduct(7), path: '/api/product/delete', body: { product_id: 7 } },
  { name: 'orderList 默认分页', invoke: (c) => c.orderList(), path: '/api/order/list', body: { page: 1, page_size: 20 } },
  {
    name: 'orderList 带状态',
    invoke: (c) => c.orderList({ status: 2 }),
    path: '/api/order/list',
    body: { page: 1, page_size: 20, status: 2 }
  },
  { name: 'orderDetail', invoke: (c) => c.orderDetail(9), path: '/api/order/detail', body: { order_id: 9 } },
  { name: 'orderCards', invoke: (c) => c.orderCards(9), path: '/api/order/cards', body: { order_id: 9 } },
  {
    name: 'shipOrder',
    invoke: (c) => c.shipOrder(9, 'SF123456', '顺丰速运'),
    path: '/api/order/ship',
    body: { order_id: 9, logistics_no: 'SF123456', logistics_company: '顺丰速运' }
  },
  {
    name: 'updateOrderPrice',
    invoke: (c) => c.updateOrderPrice(9, 1990),
    path: '/api/order/update_price',
    body: { order_id: 9, price: 1990 }
  },
  { name: 'logisticsCompanies', invoke: (c) => c.logisticsCompanies(), path: '/api/logistics/companies', body: {} },
  { name: 'balance', invoke: (c) => c.balance(), path: '/api/mch/balance', body: {} }
]

test('常量：默认地址、15s 超时、20 个路径且不含代下单', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://open.goofish.pro')
  assert.equal(DEFAULT_TIMEOUT_MS, 15_000)
  assert.equal(Object.keys(PATHS).length, 20)
  assert.ok(!Object.values(PATHS).some((path) => path.includes('place')))
  assert.ok(Object.values(PATHS).every((path) => path.startsWith('/api/')))
})

for (const methodCase of METHOD_CASES) {
  test(`${methodCase.name} → ${methodCase.path}`, async () => {
    const fake = createFakeTransport(() => okReply({ echoed: true }))
    const client = createClient(fake.transport)
    await methodCase.invoke(client)
    assert.equal(fake.requests.length, 1)
    const request = fake.requests[0]
    if (request === undefined) throw new Error('unreachable')
    assert.equal(request.url, TEST_BASE_URL + methodCase.path)
    assert.equal(request.method, 'POST')
    assert.deepEqual(JSON.parse(request.body), methodCase.body)
    assert.equal(request.headers['Content-Type'], 'application/json')
    assert.equal(request.headers['X-App-Id'], TEST_CREDENTIALS.appId)
    assert.equal(request.headers['X-Mch-Id'], TEST_CREDENTIALS.mchId)
    assert.equal(request.headers['X-Timestamp'], '1724414553')
    assert.match(request.headers['X-Sign'] ?? '', /^[0-9a-f]{32}$/)
  })
}

test('发送的字节与签名严格一致（紧凑 JSON，无空格）', async () => {
  const fake = createFakeTransport(() => okReply({}))
  const client = createClient(fake.transport)
  await client.publishProduct(7)
  const request = fake.requests[0]
  if (request === undefined) throw new Error('unreachable')
  assert.equal(request.body, '{"product_id":7}')
  assert.equal(request.headers['X-Sign'], computeSign(TEST_CREDENTIALS, request.body, 1724414553))
})

test('code === 0 时返回 data（泛型可用）', async () => {
  const fake = createFakeTransport(() => okReply({ list: [{ id: 1 }] }))
  const client = createClient(fake.transport)
  const data = await client.call<{ list: { id: number }[] }>(PATHS.productList, { page: 1, page_size: 20 })
  assert.equal(data.list.length, 1)
  assert.equal(data.list[0]?.id, 1)
})

test('updateProduct 的 data 不能覆盖 product_id', async () => {
  const fake = createFakeTransport(() => okReply(null))
  const client = createClient(fake.transport)
  await client.updateProduct(7, { product_id: 999, title: 'x' })
  const request = fake.requests[0]
  if (request === undefined) throw new Error('unreachable')
  assert.deepEqual(JSON.parse(request.body), { product_id: 7, title: 'x' })
})

test('baseUrl 尾部斜杠会被归一化', async () => {
  const fake = createFakeTransport(() => okReply(null))
  const client = createClient(fake.transport, () => TEST_NOW, 'https://sandbox.example.com/')
  await client.balance()
  assert.equal(fake.requests[0]?.url, 'https://sandbox.example.com/api/mch/balance')
})

test('非法 baseUrl 在构造期抛 VALIDATION', () => {
  const fake = createFakeTransport(() => okReply(null))
  const error = captureError(() => createClient(fake.transport, () => TEST_NOW, 'ftp://x'))
  assert.equal(error.code, 'VALIDATION')
})

test('参数校验：非法 id / 空文本 / 空批量 / 负金额 / 非对象', () => {
  const client = createClient(createFakeTransport(() => okReply(null)).transport)
  const notRecord: Record<string, unknown> = JSON.parse('[]')
  assert.equal(captureError(() => client.productDetail(0)).code, 'VALIDATION')
  assert.equal(captureError(() => client.deleteProduct(-1)).code, 'VALIDATION')
  assert.equal(captureError(() => client.shipOrder(1, '  ', '顺丰')).code, 'VALIDATION')
  assert.equal(captureError(() => client.updateOrderPrice(1, -5)).code, 'VALIDATION')
  assert.equal(captureError(() => client.updateStock(1, 1.5)).code, 'VALIDATION')
  assert.equal(captureError(() => client.createProductsBatch([])).code, 'VALIDATION')
  assert.equal(captureError(() => client.createProduct(notRecord)).code, 'VALIDATION')
})

test('传输层抛错 → NETWORK 且可重试', async () => {
  const fake = createFakeTransport(() => {
    throw new Error('socket hang up')
  })
  const client = createClient(fake.transport)
  const error = await captureRejection(() => client.shops())
  assert.equal(error.code, 'NETWORK')
  assert.equal(error.retryable, true)
  assert.equal(error.details.path, PATHS.shops)
  assert.ok(error.cause instanceof Error)
})

test('HTTP 非 200 → NETWORK 且可重试', async () => {
  const fake = createFakeTransport(() => ({ status: 502, text: 'bad gateway' }))
  const client = createClient(fake.transport)
  const error = await captureRejection(() => client.shops())
  assert.equal(error.code, 'NETWORK')
  assert.equal(error.retryable, true)
  assert.equal(error.details.status, 502)
})

test('响应非 JSON → NETWORK', async () => {
  const client = createClient(createFakeTransport(() => ({ status: 200, text: 'not-json' })).transport)
  const error = await captureRejection(() => client.shops())
  assert.equal(error.code, 'NETWORK')
  assert.equal(error.retryable, true)
})

test('响应缺 code 或为数组 → UNKNOWN 且不可重试', async () => {
  const missing = createClient(createFakeTransport(() => ({ status: 200, text: '{"msg":"x"}' })).transport)
  const missingError = await captureRejection(() => missing.shops())
  assert.equal(missingError.code, 'UNKNOWN')
  assert.equal(missingError.retryable, false)

  const array = createClient(createFakeTransport(() => ({ status: 200, text: '[1,2]' })).transport)
  assert.equal((await captureRejection(() => array.shops())).code, 'UNKNOWN')
})
