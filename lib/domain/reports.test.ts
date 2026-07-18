import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import {
  getCashUpSummary, getSalesByStaff, getMarginStockBook,
  getInventoryValuation, getAgedStock, getLowStock, getMarginByStaff, getBuyExportRows,
} from './reports'
import type { Db } from '../db'

let dbc: Db

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
  // Second staff member used by several tests
  await dbc.insert(schema.staff).values({ id: 2, name: 'Alex', pinHash: 'x', role: 'staff' })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a bare-minimum sale row; returns the inserted id. */
async function insertSale(opts: {
  staffId?: number | null
  paymentMethod: string
  total: number
  createdAt: string
}): Promise<number> {
  const [row] = await dbc
    .insert(schema.sales)
    .values({
      staffId: opts.staffId ?? null,
      subtotal: opts.total,
      total: opts.total,
      paymentMethod: opts.paymentMethod,
      createdAt: opts.createdAt,
    })
    .returning({ id: schema.sales.id })
  return row.id
}

async function insertRefund(opts: {
  saleId: number
  method: string
  amount: number
  createdAt: string
}): Promise<void> {
  await dbc.insert(schema.refunds).values({
    saleId: opts.saleId,
    method: opts.method,
    amount: opts.amount,
    createdAt: opts.createdAt,
  })
}

async function insertBuy(opts: {
  method: string
  total: number
  createdAt: string
}): Promise<void> {
  await dbc.insert(schema.buyTransactions).values({
    method: opts.method,
    total: opts.total,
    createdAt: opts.createdAt,
  })
}

// ---------------------------------------------------------------------------
// getCashUpSummary — only 'cash' rows are counted
// ---------------------------------------------------------------------------

test('cash-up sums only cash rows, ignores card/store_credit', async () => {
  const DAY = '2026-07-06'

  // Sales: one cash (500p), one card (300p)
  await insertSale({ paymentMethod: 'cash', total: 500, createdAt: `${DAY} 10:00:00` })
  await insertSale({ paymentMethod: 'card', total: 300, createdAt: `${DAY} 10:01:00` })

  // Refunds need a parent sale first; use a cash sale
  const refundSaleId = await insertSale({ paymentMethod: 'cash', total: 1000, createdAt: `${DAY} 11:00:00` })
  await insertRefund({ saleId: refundSaleId, method: 'cash', amount: 200, createdAt: `${DAY} 11:30:00` })
  await insertRefund({ saleId: refundSaleId, method: 'store_credit', amount: 50, createdAt: `${DAY} 11:31:00` })

  // Buy payouts: one cash (150p), one store_credit (80p)
  await insertBuy({ method: 'cash', total: 150, createdAt: `${DAY} 14:00:00` })
  await insertBuy({ method: 'store_credit', total: 80, createdAt: `${DAY} 14:01:00` })

  const summary = await getCashUpSummary(DAY, dbc)

  // cashSales = 500 + 1000 (the two cash sales)
  assert.equal(summary.cashSales, 1500)
  // cashRefunds = 200 only (store_credit refund excluded)
  assert.equal(summary.cashRefunds, 200)
  // cashBuyPayouts = 150 only (store_credit buy excluded)
  assert.equal(summary.cashBuyPayouts, 150)
})

// ---------------------------------------------------------------------------
// getCashUpSummary — date boundary behaviour
// ---------------------------------------------------------------------------

test('cash-up includes rows at day 00:00:00 and 23:59:59, excludes day-1 and day+1 00:00:00', async () => {
  const DAY = '2026-07-06'

  // Included: exactly midnight start of day
  await insertSale({ paymentMethod: 'cash', total: 100, createdAt: `${DAY} 00:00:00` })
  // Included: one second before midnight (still same day)
  await insertSale({ paymentMethod: 'cash', total: 200, createdAt: `${DAY} 23:59:59` })
  // Excluded: previous day 23:59:59
  await insertSale({ paymentMethod: 'cash', total: 999, createdAt: '2026-07-05 23:59:59' })
  // Excluded: next day 00:00:00 (toExcl boundary)
  await insertSale({ paymentMethod: 'cash', total: 888, createdAt: '2026-07-07 00:00:00' })

  const summary = await getCashUpSummary(DAY, dbc)
  assert.equal(summary.cashSales, 300) // 100 + 200 only
})

// ---------------------------------------------------------------------------
// getCashUpSummary — empty day returns zeros
// ---------------------------------------------------------------------------

test('cash-up for a day with no transactions returns all zeros', async () => {
  const summary = await getCashUpSummary('2026-01-01', dbc)
  assert.equal(summary.cashSales, 0)
  assert.equal(summary.cashRefunds, 0)
  assert.equal(summary.cashBuyPayouts, 0)
})

// ---------------------------------------------------------------------------
// getSalesByStaff
// ---------------------------------------------------------------------------

test('getSalesByStaff groups correctly, orders by revenue desc', async () => {
  const DAY = '2026-07-06'

  // Staff 1 (Tess): two sales totalling 700p
  await insertSale({ staffId: 1, paymentMethod: 'cash', total: 300, createdAt: `${DAY} 09:00:00` })
  await insertSale({ staffId: 1, paymentMethod: 'card', total: 400, createdAt: `${DAY} 10:00:00` })

  // Staff 2 (Alex): one sale of 900p (higher revenue → first)
  await insertSale({ staffId: 2, paymentMethod: 'cash', total: 900, createdAt: `${DAY} 11:00:00` })

  const rows = await getSalesByStaff(DAY, DAY, dbc)

  assert.equal(rows.length, 2)

  // Ordered by revenue desc → Alex first
  assert.equal(rows[0].staffId, 2)
  assert.equal(rows[0].staffName, 'Alex')
  assert.equal(rows[0].saleCount, 1)
  assert.equal(rows[0].revenue, 900)

  assert.equal(rows[1].staffId, 1)
  assert.equal(rows[1].staffName, 'Tess')
  assert.equal(rows[1].saleCount, 2)
  assert.equal(rows[1].revenue, 700)
})

test('getSalesByStaff: sale with NULL staffId appears as its own row with staffName null', async () => {
  const DAY = '2026-07-06'

  await insertSale({ staffId: null, paymentMethod: 'cash', total: 500, createdAt: `${DAY} 12:00:00` })
  await insertSale({ staffId: 1, paymentMethod: 'card', total: 100, createdAt: `${DAY} 12:01:00` })

  const rows = await getSalesByStaff(DAY, DAY, dbc)

  const nullRow = rows.find(r => r.staffId === null)
  assert.ok(nullRow, 'expected a row for null staffId')
  assert.equal(nullRow.staffName, null)
  assert.equal(nullRow.revenue, 500)
  assert.equal(nullRow.saleCount, 1)
})

test('getSalesByStaff excludes sales outside the date range', async () => {
  // in range
  await insertSale({ staffId: 1, paymentMethod: 'cash', total: 400, createdAt: '2026-07-06 10:00:00' })
  await insertSale({ staffId: 1, paymentMethod: 'cash', total: 400, createdAt: '2026-07-07 10:00:00' })
  // out of range (before from)
  await insertSale({ staffId: 1, paymentMethod: 'cash', total: 999, createdAt: '2026-07-05 23:59:59' })
  // out of range (after to+1day boundary)
  await insertSale({ staffId: 1, paymentMethod: 'cash', total: 888, createdAt: '2026-07-08 00:00:00' })

  const rows = await getSalesByStaff('2026-07-06', '2026-07-07', dbc)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].staffId, 1)
  assert.equal(rows[0].revenue, 800) // 400 + 400
  assert.equal(rows[0].saleCount, 2)
})

// ---------------------------------------------------------------------------
// getMarginStockBook
// ---------------------------------------------------------------------------

test('getMarginStockBook: one row per margin sale-line with margin + VAT', async () => {
  // A margin-scheme sale: sell 1000, cost 400, qty 1 → margin 600 → VAT round(600/6)=100
  // seedBase already inserted card id:1 and staff id:1; use id:2 to avoid conflict
  await dbc.insert(schema.cards).values({ id: 2, name: 'Charizard', setName: 'Base', setNumber: '4/102' })
  await dbc.insert(schema.inventoryItems).values({ id: 1, cardId: 2, condition: 'NM', quantity: 0, costPrice: 400, qrCode: 'qr-sb-1' })
  const [sale] = await dbc.insert(schema.sales).values({
    subtotal: 1000, discountAmount: 0, vatAmount: 100, vatScheme: 'margin', total: 1000, paymentMethod: 'cash',
    createdAt: '2026-07-11 10:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({
    saleId: sale.id, inventoryItemId: 1, quantity: 1, priceAtSale: 1000, costAtSale: 400,
  })

  const rows = await getMarginStockBook('2026-07-11', '2026-07-11', dbc)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].cardName, 'Charizard')
  assert.equal(rows[0].salePence, 1000)
  assert.equal(rows[0].costPence, 400)
  assert.equal(rows[0].marginPence, 600)
  assert.equal(rows[0].vatPence, 100)
  assert.equal(rows[0].noCostBasis, false)
})

test('getMarginStockBook: only includes margin-scheme sales, flags no-cost lines', async () => {
  // seedBase already inserted card id:1; use id:2 for new card
  await dbc.insert(schema.cards).values({ id: 2, name: 'Pikachu Alt', setName: 'Base', setNumber: '58/102' })
  await dbc.insert(schema.inventoryItems).values({ id: 1, cardId: 2, condition: 'NM', quantity: 0, costPrice: null, qrCode: 'qr-sb-2' })
  // standard-scheme sale — must be excluded
  const [std] = await dbc.insert(schema.sales).values({
    subtotal: 500, discountAmount: 0, vatAmount: 100, vatScheme: 'standard', total: 600, paymentMethod: 'cash',
    createdAt: '2026-07-11 11:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({ saleId: std.id, inventoryItemId: 1, quantity: 1, priceAtSale: 500, costAtSale: 200 })
  // margin sale with a no-cost line
  const [mrg] = await dbc.insert(schema.sales).values({
    subtotal: 900, discountAmount: 0, vatAmount: 0, vatScheme: 'margin', total: 900, paymentMethod: 'cash',
    createdAt: '2026-07-11 12:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({ saleId: mrg.id, inventoryItemId: 1, quantity: 1, priceAtSale: 900, costAtSale: null })

  const rows = await getMarginStockBook('2026-07-11', '2026-07-11', dbc)
  assert.equal(rows.length, 1) // only the margin sale
  assert.equal(rows[0].noCostBasis, true)
  assert.equal(rows[0].costPence, null)
  assert.equal(rows[0].marginPence, 0)
  assert.equal(rows[0].vatPence, 0)
})

test('getMarginStockBook: qty>1 line — all money columns are line totals and reconcile', async () => {
  // qty 3, unit sale 1000p, unit cost 400p
  //   salePence  = 1000 × 3 = 3000
  //   costPence  =  400 × 3 = 1200
  //   marginPence = 3000 − 1200 = 1800
  //   vatPence  = round(1800 / 6) = 300
  await dbc.insert(schema.cards).values({ id: 3, name: 'Blastoise', setName: 'Base', setNumber: '2/102' })
  await dbc.insert(schema.inventoryItems).values({ id: 2, cardId: 3, condition: 'LP', quantity: 0, costPrice: 400, qrCode: 'qr-sb-3' })
  const [sale] = await dbc.insert(schema.sales).values({
    subtotal: 3000, discountAmount: 0, vatAmount: 300, vatScheme: 'margin', total: 3000, paymentMethod: 'cash',
    createdAt: '2026-07-11 14:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({
    saleId: sale.id, inventoryItemId: 2, quantity: 3, priceAtSale: 1000, costAtSale: 400,
  })

  const rows = await getMarginStockBook('2026-07-11', '2026-07-11', dbc)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].quantity, 3)
  assert.equal(rows[0].salePence, 3000)    // line total
  assert.equal(rows[0].costPence, 1200)    // line total
  assert.equal(rows[0].marginPence, 1800)  // salePence − costPence
  assert.equal(rows[0].vatPence, 300)      // round(1800 / 6)
  assert.equal(rows[0].noCostBasis, false)
  // Full reconciliation check: Sale − Cost === Margin
  assert.equal(rows[0].salePence - (rows[0].costPence as number), rows[0].marginPence)
})

// ---------------------------------------------------------------------------
// getInventoryValuation
// ---------------------------------------------------------------------------

test('getInventoryValuation sums units, cost and market over in-stock active items', async () => {
  await dbc.insert(schema.cards).values([
    { id: 10, name: 'Mew', setName: 'Fossil', setNumber: '8/62' },
    { id: 11, name: 'Ditto', setName: 'Fossil', setNumber: '3/62' },
    { id: 12, name: 'Eevee', setName: 'Jungle', setNumber: '51/64' },
  ])
  // cardmarketTrend preferred (settings default source), tcgplayer fallback
  await dbc.insert(schema.priceCache).values([
    { cardId: 10, cardmarketTrend: 1000, tcgplayerMarket: 900 },
    { cardId: 11, cardmarketTrend: null, tcgplayerMarket: 500 },
    // card 12 has no price row at all
  ])
  await dbc.insert(schema.inventoryItems).values([
    // 3 × cost 400, market 1000
    { id: 30, cardId: 10, condition: 'NM', quantity: 3, costPrice: 400, qrCode: 'v1' },
    // 2 × no cost, market 500 (tcgplayer fallback)
    { id: 31, cardId: 11, condition: 'LP', quantity: 2, costPrice: null, qrCode: 'v2' },
    // 4 × cost 100, no market price
    { id: 32, cardId: 12, condition: 'NM', quantity: 4, costPrice: 100, qrCode: 'v3' },
    // zero stock — ignored entirely
    { id: 33, cardId: 10, condition: 'HP', quantity: 0, costPrice: 999, qrCode: 'v4' },
    // inactive — ignored entirely
    { id: 34, cardId: 10, condition: 'DMG', quantity: 5, costPrice: 999, qrCode: 'v5', isActive: false },
  ])

  const v = await getInventoryValuation(dbc)
  assert.equal(v.totalUnits, 9)        // 3 + 2 + 4
  assert.equal(v.distinctItems, 3)
  assert.equal(v.costValue, 3 * 400 + 4 * 100)          // 1600
  assert.equal(v.unitsWithoutCost, 2)
  assert.equal(v.marketValue, 3 * 1000 + 2 * 500)       // 4000
  assert.equal(v.unitsWithoutMarket, 4)
})

test('getInventoryValuation returns zeros on an empty inventory', async () => {
  const v = await getInventoryValuation(dbc)
  assert.deepEqual(v, {
    totalUnits: 0, distinctItems: 0, costValue: 0,
    unitsWithoutCost: 0, marketValue: 0, unitsWithoutMarket: 0,
  })
})

// ---------------------------------------------------------------------------
// getAgedStock
// ---------------------------------------------------------------------------

test('getAgedStock returns old unsold stock, excludes recently sold or new items', async () => {
  await dbc.insert(schema.cards).values([
    { id: 20, name: 'Old Never Sold', setName: 'Base', setNumber: '1' },
    { id: 21, name: 'Old Sold Long Ago', setName: 'Base', setNumber: '2' },
    { id: 22, name: 'Old Sold Recently', setName: 'Base', setNumber: '3' },
    { id: 23, name: 'New Item', setName: 'Base', setNumber: '4' },
  ])
  await dbc.insert(schema.inventoryItems).values([
    { id: 40, cardId: 20, condition: 'NM', quantity: 1, qrCode: 'a1', createdAt: '2025-01-01 10:00:00' },
    { id: 41, cardId: 21, condition: 'NM', quantity: 2, qrCode: 'a2', createdAt: '2025-01-01 10:00:00' },
    { id: 42, cardId: 22, condition: 'NM', quantity: 3, qrCode: 'a3', createdAt: '2025-01-01 10:00:00' },
    { id: 43, cardId: 23, condition: 'NM', quantity: 4, qrCode: 'a4' }, // createdAt now
    { id: 44, cardId: 20, condition: 'LP', quantity: 0, qrCode: 'a5', createdAt: '2025-01-01 10:00:00' }, // no stock
  ])
  // Sale long ago for item 41; recent sale for item 42
  const [oldSale] = await dbc.insert(schema.sales).values({
    subtotal: 100, total: 100, paymentMethod: 'cash', createdAt: '2025-02-01 10:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({ saleId: oldSale.id, inventoryItemId: 41, quantity: 1, priceAtSale: 100 })
  const recentTs = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const [newSale] = await dbc.insert(schema.sales).values({
    subtotal: 100, total: 100, paymentMethod: 'cash', createdAt: recentTs,
  }).returning()
  await dbc.insert(schema.saleItems).values({ saleId: newSale.id, inventoryItemId: 42, quantity: 1, priceAtSale: 100 })

  const rows = await getAgedStock(90, dbc)
  const ids = rows.map(r => r.inventoryItemId)
  assert.ok(ids.includes(40), 'old never-sold item included')
  assert.ok(ids.includes(41), 'old item last sold long ago included')
  assert.ok(!ids.includes(42), 'recently sold item excluded')
  assert.ok(!ids.includes(43), 'recently created item excluded')
  assert.ok(!ids.includes(44), 'zero-stock item excluded')

  const row41 = rows.find(r => r.inventoryItemId === 41)!
  assert.equal(row41.cardName, 'Old Sold Long Ago')
  assert.equal(row41.lastSoldAt, '2025-02-01 10:00:00')
  const row40 = rows.find(r => r.inventoryItemId === 40)!
  assert.equal(row40.lastSoldAt, null)
})

test('getAgedStock validates olderThanDays', async () => {
  const { DomainError } = await import('./errors')
  for (const bad of [0, -1, 1.5, NaN]) {
    await assert.rejects(
      getAgedStock(bad, dbc),
      (e: unknown) => e instanceof DomainError && e.code === 'INVALID_INPUT',
    )
  }
})

// ---------------------------------------------------------------------------
// getLowStock
// ---------------------------------------------------------------------------

test('getLowStock lists active items at or below their threshold, lowest first', async () => {
  await dbc.insert(schema.cards).values([
    { id: 25, name: 'Snorlax', setName: 'Jungle', setNumber: '11/64' },
  ])
  await dbc.insert(schema.inventoryItems).values([
    { id: 50, cardId: 25, condition: 'NM', quantity: 0, lowStockThreshold: 1, qrCode: 'l1', location: 'Binder A' },
    { id: 51, cardId: 25, condition: 'LP', quantity: 2, lowStockThreshold: 2, qrCode: 'l2' },
    { id: 52, cardId: 25, condition: 'MP', quantity: 5, lowStockThreshold: 2, qrCode: 'l3' }, // above threshold
    { id: 53, cardId: 25, condition: 'HP', quantity: 0, lowStockThreshold: 1, qrCode: 'l4', isActive: false }, // inactive
  ])

  const rows = await getLowStock(dbc)
  assert.deepEqual(rows.map(r => r.inventoryItemId), [50, 51])
  assert.equal(rows[0].cardName, 'Snorlax')
  assert.equal(rows[0].location, 'Binder A')
  assert.equal(rows[0].lowStockThreshold, 1)
})

// ---------------------------------------------------------------------------
// getMarginByStaff
// ---------------------------------------------------------------------------

test('getMarginByStaff sums line margins from cost snapshots, counts no-cost lines', async () => {
  const DAY = '2026-07-06'
  // Tess (staff 1): sale with two lines — (1000−400)×2 = 1200 margin, one no-cost line
  const [s1] = await dbc.insert(schema.sales).values({
    staffId: 1, subtotal: 2500, total: 2500, paymentMethod: 'cash', createdAt: `${DAY} 10:00:00`,
  }).returning()
  await dbc.insert(schema.saleItems).values([
    { saleId: s1.id, quantity: 2, priceAtSale: 1000, costAtSale: 400 },
    { saleId: s1.id, quantity: 1, priceAtSale: 500, costAtSale: null },
  ])
  // Alex (staff 2): (300−100)×1 = 200 margin
  const [s2] = await dbc.insert(schema.sales).values({
    staffId: 2, subtotal: 300, total: 300, paymentMethod: 'card', createdAt: `${DAY} 11:00:00`,
  }).returning()
  await dbc.insert(schema.saleItems).values([
    { saleId: s2.id, quantity: 1, priceAtSale: 300, costAtSale: 100 },
  ])
  // Out of range — ignored
  const [s3] = await dbc.insert(schema.sales).values({
    staffId: 1, subtotal: 9000, total: 9000, paymentMethod: 'cash', createdAt: '2026-07-01 10:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values([
    { saleId: s3.id, quantity: 1, priceAtSale: 9000, costAtSale: 1 },
  ])

  const rows = await getMarginByStaff(DAY, DAY, dbc)
  const tess = rows.find(r => r.staffId === 1)!
  assert.equal(tess.margin, 1200)
  assert.equal(tess.noCostLines, 1)
  const alex = rows.find(r => r.staffId === 2)!
  assert.equal(alex.margin, 200)
  assert.equal(alex.noCostLines, 0)
})

// ---------------------------------------------------------------------------
// getBuyExportRows
// ---------------------------------------------------------------------------

test('getBuyExportRows flattens buys to one row per item with parent txn columns', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Sam Seller' })
  await dbc.insert(schema.cards).values({ id: 26, name: 'Lapras', setName: 'Fossil', setNumber: '10/62' })
  const [buy] = await dbc.insert(schema.buyTransactions).values({
    staffId: 1, customerId: 1, method: 'cash', total: 700, createdAt: '2026-07-06 15:00:00',
  }).returning()
  await dbc.insert(schema.buyItems).values([
    { buyId: buy.id, cardId: 26, condition: 'NM', quantity: 2, payPrice: 250, marketAtBuy: 500 },
    { buyId: buy.id, cardId: null, condition: 'LP', quantity: 1, payPrice: 200, marketAtBuy: null },
  ])

  const rows = await getBuyExportRows(dbc)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].buyId, buy.id)
  assert.equal(rows[0].createdAt, '2026-07-06 15:00:00')
  assert.equal(rows[0].staffName, 'Tess')
  assert.equal(rows[0].customerName, 'Sam Seller')
  assert.equal(rows[0].method, 'cash')
  assert.equal(rows[0].txnTotal, 700)
  assert.equal(rows[0].cardName, 'Lapras')
  assert.equal(rows[0].condition, 'NM')
  assert.equal(rows[0].quantity, 2)
  assert.equal(rows[0].payPrice, 250)
  assert.equal(rows[0].marketAtBuy, 500)
  assert.equal(rows[1].cardName, null)
})
