import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createBuy } from './buys'
import { updateSettings } from '../settings'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db

// Predicates for assert.rejects take `unknown` — narrow via instanceof
// (a `(e: DomainError) => …` param would violate strictFunctionTypes).
const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
})

test('buy creates a new stock row with QR code and records buy items', async () => {
  const { buyId, total } = await createBuy({
    staffId: 1,
    items: [{ cardId: 1, condition: 'NM', quantity: 2, payPrice: 400 }],
    method: 'cash',
  }, dbc)
  assert.equal(total, 800)
  const [inv] = await dbc.select().from(schema.inventoryItems)
    .where(and(eq(schema.inventoryItems.cardId, 1), eq(schema.inventoryItems.condition, 'NM')))
  assert.equal(inv.quantity, 2)
  assert.equal(inv.costPrice, 400)
  assert.ok(inv.qrCode.length > 0)
  const items = await dbc.select().from(schema.buyItems).where(eq(schema.buyItems.buyId, buyId))
  assert.equal(items.length, 1)
  assert.equal(items[0].inventoryItemId, inv.id)
})

test('merge on intake: existing active row gets quantity added and cost blended', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 2, costPrice: 300, qrCode: 'qr-1',
  })
  await createBuy({
    staffId: 1,
    items: [{ cardId: 1, condition: 'NM', quantity: 2, payPrice: 500 }],
    method: 'cash',
  }, dbc)
  const [inv] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, 1))
  assert.equal(inv.quantity, 4)
  assert.equal(inv.costPrice, 400) // (300×2 + 500×2) / 4
  const all = await dbc.select().from(schema.inventoryItems)
  assert.equal(all.length, 1) // no duplicate row
})

test('store credit buy writes a positive ledger row', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  const { buyId, total } = await createBuy({
    staffId: 1,
    items: [{ cardId: 1, condition: 'LP', quantity: 1, payPrice: 650 }],
    method: 'store_credit',
    customerId: 1,
  }, dbc)
  assert.equal(total, 650)
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].delta, 650)
  assert.equal(ledger[0].reason, 'buylist')
  assert.equal(ledger[0].refId, buyId)
  assert.equal(ledger[0].refType, 'buy')
})

test('validation and not-found errors', async () => {
  const good = { cardId: 1, condition: 'NM', quantity: 1, payPrice: 100 }
  await assert.rejects(
    createBuy({ staffId: 1, items: [], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, condition: 'MINT' }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, quantity: 0 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, payPrice: -100 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, payPrice: 100.5 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [good], method: 'store_credit' }, dbc), // no customer
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [good], method: 'store_credit', customerId: 99 }, dbc),
    domainCode('NOT_FOUND'),
  )
})

// --- Overpayment cap + marketAtBuy snapshot ---
// seedBase settings default primaryPriceSource = 'cardmarket'.

async function seedMarket(trendPence: number) {
  await dbc.insert(schema.priceCache).values({ cardId: 1, cardmarketTrend: trendPence })
}

test('staff buy at exactly 110% of market is allowed and snapshots marketAtBuy', async () => {
  await seedMarket(1000)
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'staff',
    items: [{ cardId: 1, condition: 'NM', quantity: 1, payPrice: 1100 }],
    method: 'cash',
  }, dbc)
  const [item] = await dbc.select().from(schema.buyItems).where(eq(schema.buyItems.buyId, buyId))
  assert.equal(item.marketAtBuy, 1000)
  assert.equal(item.payPrice, 1100)
})

test('staff buy above 110% of market is rejected with BUY_CAP_EXCEEDED', async () => {
  await seedMarket(1000)
  await assert.rejects(
    createBuy({
      staffId: 1, staffRole: 'staff',
      items: [{ cardId: 1, condition: 'NM', quantity: 1, payPrice: 1101 }],
      method: 'cash',
    }, dbc),
    (e: unknown) => {
      assert.ok(e instanceof DomainError)
      assert.equal(e.code, 'BUY_CAP_EXCEEDED')
      assert.equal(e.meta?.maxPay, 1100)
      assert.equal(e.meta?.market, 1000)
      return true
    },
  )
  // Nothing written — the buy failed before the transaction.
  const buys = await dbc.select().from(schema.buyTransactions)
  assert.equal(buys.length, 0)
})

test('admin bypasses the cap; marketAtBuy still recorded', async () => {
  await seedMarket(1000)
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'admin',
    items: [{ cardId: 1, condition: 'NM', quantity: 1, payPrice: 5000 }],
    method: 'cash',
  }, dbc)
  const [item] = await dbc.select().from(schema.buyItems).where(eq(schema.buyItems.buyId, buyId))
  assert.equal(item.marketAtBuy, 1000)
  assert.equal(item.payPrice, 5000)
})

test('no cached market price: cap cannot apply, marketAtBuy is null', async () => {
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'staff',
    items: [{ cardId: 1, condition: 'NM', quantity: 1, payPrice: 99999 }],
    method: 'cash',
  }, dbc)
  const [item] = await dbc.select().from(schema.buyItems).where(eq(schema.buyItems.buyId, buyId))
  assert.equal(item.marketAtBuy, null)
})

test('cap falls back to the other price source when the primary is missing', async () => {
  // primary is cardmarket; only tcgplayer has a price
  await dbc.insert(schema.priceCache).values({ cardId: 1, tcgplayerMarket: 2000 })
  await assert.rejects(
    createBuy({
      staffId: 1, staffRole: 'staff',
      items: [{ cardId: 1, condition: 'NM', quantity: 1, payPrice: 2201 }],
      method: 'cash',
    }, dbc),
    domainCode('BUY_CAP_EXCEEDED'),
  )
})

// --- Condition-aware overpayment cap ---

test('staff cap tightens to 110% of the conditioned market (DMG 35%)', async () => {
  await seedMarket(1000)
  await updateSettings({ conditionSellPct: { M: 100, NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  // market 1000p; DMG conditioned = 350p; cap = floor(350×11/10) = 385p.
  // 400p would have passed the old raw-market cap (≤1100) — must now be rejected.
  await assert.rejects(
    () => createBuy({
      staffId: 1, staffRole: 'staff', method: 'cash',
      items: [{ cardId: 1, condition: 'DMG', quantity: 1, payPrice: 400 }],
    }, dbc),
    (e: unknown) => {
      assert.ok(e instanceof DomainError)
      assert.equal(e.code, 'BUY_CAP_EXCEEDED')
      assert.equal(e.meta?.maxPay, 385)
      assert.equal(e.meta?.market, 350) // the conditioned reference the cap used
      return true
    },
  )
  // At the conditioned cap exactly → accepted; marketAtBuy stays RAW market.
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'staff', method: 'cash',
    items: [{ cardId: 1, condition: 'DMG', quantity: 1, payPrice: 385 }],
  }, dbc)
  const items = await dbc.select().from(schema.buyItems).where(eq(schema.buyItems.buyId, buyId))
  assert.equal(items[0].marketAtBuy, 1000)
})

test('M is a first-class condition: accepted, and the cap conditions by its pct', async () => {
  await seedMarket(1000)
  await updateSettings({ conditionSellPct: { M: 90, NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  // market 1000p; M conditioned = 900p; cap = floor(900×11/10) = 990p.
  await assert.rejects(
    () => createBuy({
      staffId: 1, staffRole: 'staff', method: 'cash',
      items: [{ cardId: 1, condition: 'M', quantity: 1, payPrice: 991 }],
    }, dbc),
    (e: unknown) => {
      assert.ok(e instanceof DomainError)
      assert.equal(e.code, 'BUY_CAP_EXCEEDED')
      assert.equal(e.meta?.maxPay, 990)
      return true
    },
  )
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'staff', method: 'cash',
    items: [{ cardId: 1, condition: 'M', quantity: 1, payPrice: 990 }],
  }, dbc)
  assert.ok(buyId)
})

test('default all-100 ladder leaves the cap at 110% of raw market (no-op)', async () => {
  await seedMarket(1000)
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'staff', method: 'cash',
    items: [{ cardId: 1, condition: 'DMG', quantity: 1, payPrice: 1100 }],
  }, dbc)
  assert.ok(buyId)
})

test('admin bypasses the conditioned cap too', async () => {
  await seedMarket(1000)
  await updateSettings({ conditionSellPct: { M: 100, NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'admin', method: 'cash',
    items: [{ cardId: 1, condition: 'DMG', quantity: 1, payPrice: 900 }],
  }, dbc)
  assert.ok(buyId)
})

// --- Product buy path ---

test('product buy increments the product stock row with weighted cost', async () => {
  await dbc.insert(schema.products).values({ id: 1, name: 'Booster Box SV', category: 'sealed' })
  await dbc.insert(schema.inventoryItems).values({
    id: 50, productId: 1, condition: 'NA', quantity: 2, costPrice: 6000,
    sellPriceOverride: 9999, qrCode: 'qr-p1',
  })
  const { total } = await createBuy({
    staffId: 1, items: [{ productId: 1, quantity: 1, payPrice: 9000 }], method: 'cash',
  }, dbc)
  assert.equal(total, 9000)
  const [row] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, 50))
  assert.equal(row.quantity, 3)
  assert.equal(row.costPrice, 7000) // (6000×2 + 9000×1) / 3
  const [line] = await dbc.select().from(schema.buyItems)
  assert.equal(line.productId, 1)
  assert.equal(line.cardId, null)
  assert.equal(line.condition, 'NA')
  assert.equal(line.marketAtBuy, null) // no market price exists for products
})

test('mixed card + product buy in one transaction', async () => {
  await dbc.insert(schema.products).values({ id: 1, name: 'Sleeves 100ct', category: 'accessories' })
  await dbc.insert(schema.inventoryItems).values({
    id: 50, productId: 1, condition: 'NA', quantity: 0, costPrice: null,
    sellPriceOverride: 500, qrCode: 'qr-p1',
  })
  const { total } = await createBuy({
    staffId: 1,
    items: [
      { cardId: 1, condition: 'NM', quantity: 1, payPrice: 400 },
      { productId: 1, quantity: 2, payPrice: 100 },
    ],
    method: 'cash',
  }, dbc)
  assert.equal(total, 600)
  const lines = await dbc.select().from(schema.buyItems)
  assert.equal(lines.length, 2)
})

test('store-credit product buy writes the ledger', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  await dbc.insert(schema.products).values({ id: 1, name: 'ETB Paldea', category: 'sealed' })
  await dbc.insert(schema.inventoryItems).values({
    id: 50, productId: 1, condition: 'NA', quantity: 0, costPrice: null,
    sellPriceOverride: 4500, qrCode: 'qr-p1',
  })
  await createBuy({
    staffId: 1, items: [{ productId: 1, quantity: 1, payPrice: 3000 }],
    method: 'store_credit', customerId: 1,
  }, dbc)
  const [entry] = await dbc.select().from(schema.creditLedger)
  assert.equal(entry.delta, 3000)
  assert.equal(entry.reason, 'buylist')
})

test('rejects a line with both ids, neither id, or an unknown/inactive product', async () => {
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ cardId: 1, productId: 1, condition: 'NM', quantity: 1, payPrice: 100 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ quantity: 1, payPrice: 100 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ productId: 99, quantity: 1, payPrice: 100 }], method: 'cash' }, dbc),
    domainCode('NOT_FOUND'),
  )
  await dbc.insert(schema.products).values({ id: 1, name: 'Old Line', category: 'other' })
  await dbc.insert(schema.inventoryItems).values({
    id: 50, productId: 1, condition: 'NA', quantity: 0, costPrice: null,
    sellPriceOverride: 100, qrCode: 'qr-p1', isActive: false,
  })
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ productId: 1, quantity: 1, payPrice: 100 }], method: 'cash' }, dbc),
    domainCode('PRODUCT_INACTIVE'),
  )
})
