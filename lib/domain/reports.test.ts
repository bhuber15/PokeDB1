import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { getCashUpSummary, getSalesByStaff, getMarginStockBook } from './reports'
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
