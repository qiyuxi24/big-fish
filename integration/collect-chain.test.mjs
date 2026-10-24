/**
 * 采集链路端到端（integration）：面板 rpc → daemon HTTP → mtop（假 transport）→ SQLite → 读回。
 *
 * 为什么需要它：`seller-collect` 的单测只覆盖「采集器 + 内存库」，面板接的是 rpc → HTTP →
 * runtime 装配，三段里任何一段没接上（路由没注册、runtime 没注入、rpc 白名单漏字段）单测都看不见。
 * 这里用真实 SQLite 文件、真实 HTTP、真实 rpc 桥，只把最外层的 mtop 网络换成假 transport
 * ——AGENTS §5 禁止在本仓直连真实闲鱼接口，真机采集交由用户在普通终端跑。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createSellerRepository, loadDaemonConfig, openStore } from '../packages/core/src/index.ts'
import { startDaemonRuntime } from '../packages/daemon/src/index.ts'
import { createDaemonClient } from '../packages/plugin-ops/src/client.js'
import { createRpcBridge } from '../packages/plugin-ops/src/rpc.js'

const ACCOUNT_ID = 'acc-collect'
const SELLER_ID = '2200000000001'
const OTHER_SELLER_ID = '3300000000002'
const ITEM_IDS = ['1091933071728', '1091933071729']
const NOW = 1_700_000_000_000

function scratchDir() {
  const base = fileURLToPath(new URL('../.scratch/integration/', import.meta.url))
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, 'collect-'))
}

/** mtop 信封：ret 数组 + data；签名失败/风控都不在这里模拟（另有单测）。 */
function success(data) {
  return { status: 200, headers: {}, text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data }) }
}

function readData(request) {
  const raw = new URLSearchParams(request.body).get('data')
  return raw === null ? {} : JSON.parse(raw)
}

/**
 * 假 mtop：只认采集链路要用的三个接口，其余一律报错（多发/发错接口要立刻暴露）。
 * 详情里故意塞 desc 与 imageInfos —— 它们**不许**落库，断言在测试末尾。
 */
function createFakeMtop(calls) {
  return {
    request: async (request) => {
      const api = new URL(request.url).searchParams.get('api') ?? ''
      calls.push(api)
      if (api === 'mtop.idle.web.user.page.head') {
        const data = readData(request)
        return success({
          baseInfo: { kcUserId: data.userId },
          module: { base: { displayName: '行情店', ipLocation: '西安' }, tabs: { item: { number: ITEM_IDS.length } } },
        })
      }
      if (api === 'mtop.idle.web.xyh.item.list') {
        return success({
          cardList: ITEM_IDS.map((itemId) => ({ cardData: { detailParams: { itemId, title: '列表占位标题', soldPrice: '129' } } })),
          hasMore: false,
          pageNumber: 1,
        })
      }
      if (api === 'mtop.taobao.idle.pc.detail') {
        const data = readData(request)
        return success({
          itemDO: {
            itemId: data.itemId,
            title: '机械键盘 有线 背光',
            desc: '这段描述绝不能落库',
            soldPrice: '129',
            categoryId: 50023914,
            imageInfos: [{ url: 'https://img.example/a.jpg' }, { url: 'https://img.example/b.jpg' }],
            browseCnt: 12,
            wantCnt: 3,
            collectCnt: 1,
            soldCnt: 0,
            gmtCreate: 1792591919000,
          },
          sellerDO: { sellerId: SELLER_ID, nick: '行情店', city: '西安', itemCount: ITEM_IDS.length },
        })
      }
      throw new Error('假 transport 收到了未预期的 api：' + api)
    },
  }
}

test('采集链路：链接解析 → 门禁 → 采集入库 → 面板读回（真实 SQLite + HTTP + rpc）', async (t) => {
  const dir = scratchDir()
  const config = loadDaemonConfig({ BF_DATA_DIR: dir }, { port: 0 })
  const calls = []
  const runtime = await startDaemonRuntime({
    config,
    transport: createFakeMtop(calls),
    autoStartWorker: false,
    autoStartKeepAlive: false,
    now: () => NOW,
    version: 'test',
  })
  const client = createDaemonClient({ daemonUrl: runtime.daemon.url, tokenPath: config.tokenPath, timeoutMs: 20_000 })
  const bridge = createRpcBridge({ client })
  t.after(async () => {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // 前置：登录态落在加密凭据库（采集器从库里取，明文 cookie 不进 HTTP 响应）。
  await runtime.credentials.save({ accountId: ACCOUNT_ID, cookies: { unb: SELLER_ID, _m_h5_tk: 'tok_1700000000000' } })

  // 1) 面板第一步：粘贴商家主页链接 → 本地解析出 sellerId（零网络）。
  const parsed = await bridge.handle('reference.parseLink', { link: 'https://www.goofish.com/personal?userId=' + SELLER_ID })
  assert.equal(parsed.ok, true, JSON.stringify(parsed.error ?? {}))
  assert.equal(parsed.value.kind, 'seller')
  assert.equal(parsed.value.sellerId, SELLER_ID)
  assert.deepEqual(calls, [])

  // 2) 写本地库必须两次确认：没 confirm 直接拒，且一次 mtop 都不打。
  const denied = await bridge.handle('seller.collect', { accountId: ACCOUNT_ID, sellerId: SELLER_ID })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'VALIDATION')
  assert.match(denied.error.message, /confirm/)
  assert.deepEqual(calls, [])

  // 3) 确认后采集：主页 → 列表 → 逐件详情，逐件 upsert 落库。
  const collected = await bridge.handle('seller.collect', {
    accountId: ACCOUNT_ID,
    sellerId: SELLER_ID,
    maxItems: 20,
    confirm: true,
  })
  assert.equal(collected.ok, true, JSON.stringify(collected.error ?? {}))
  assert.equal(collected.value.stored, ITEM_IDS.length)
  assert.equal(collected.value.self, true)
  assert.deepEqual(collected.value.skipped, [])
  assert.deepEqual(calls, [
    'mtop.idle.web.user.page.head',
    'mtop.idle.web.xyh.item.list',
    'mtop.taobao.idle.pc.detail',
    'mtop.taobao.idle.pc.detail',
  ])

  // 4) 面板第二/三步：已采商家列表 + 该商家入库明细。
  const sellers = await bridge.handle('sellers.list', {})
  assert.equal(sellers.ok, true, JSON.stringify(sellers.error ?? {}))
  assert.equal(sellers.value.length, 1)
  assert.equal(sellers.value[0].sellerId, SELLER_ID)
  assert.equal(sellers.value[0].storedCount, ITEM_IDS.length)
  assert.equal(sellers.value[0].isSelf, true)

  const items = await bridge.handle('seller.items', { sellerId: SELLER_ID })
  assert.equal(items.ok, true, JSON.stringify(items.error ?? {}))
  assert.equal(items.value.total, ITEM_IDS.length)
  assert.equal(items.value.items.length, ITEM_IDS.length)
  const row = items.value.items[0]
  assert.equal(row.priceCents, 12900)
  assert.equal(row.categoryId, '50023914')
  assert.equal(row.imageCount, 2)
  // 结构特征：标题 3 段、描述 1 句；假响应的图只有 url（没宽高）→ 比例 unknown，只计数。
  assert.equal(row.copyFeatures.titleSegments, 3)
  assert.equal(row.copyFeatures.descSentences, 1)
  assert.equal(row.imageFeatures.count, 2)
  assert.equal(row.imageFeatures.aspect, 'unknown')
  // 红线：描述全文与图片地址都不落库（不是「存了只是没返回」）。
  for (const key of ['desc', 'imageInfos', 'imageUrl', 'images', 'siblingItems']) {
    assert.equal(Object.hasOwn(row, key), false, key + ' 不该出现在入库记录里')
  }
  assert.equal(JSON.stringify(row).includes('img.example'), false)
  assert.equal(JSON.stringify(row).includes('这段描述'), false)

  // 5) 持久化在文件里：换一条连接读同一个 db 也能读到（排除进程内缓存）。
  const store = openStore({ path: config.dbPath })
  try {
    assert.equal(createSellerRepository({ store }).countItems(SELLER_ID), ITEM_IDS.length)
  } finally {
    store.close()
  }

  // 6) 他人的店：不勾「仅用于看行情」必须 UNAUTHORIZED，且不再打任何接口。
  const before = calls.length
  const other = await bridge.handle('seller.collect', {
    accountId: ACCOUNT_ID,
    sellerId: OTHER_SELLER_ID,
    confirm: true,
  })
  assert.equal(other.ok, false)
  assert.equal(other.error.code, 'UNAUTHORIZED')
  assert.match(other.error.message, /仅用于看行情/)
  assert.equal(calls.length, before)
})
