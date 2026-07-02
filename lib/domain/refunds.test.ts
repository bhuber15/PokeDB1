import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createSale } from './sales'
import { createRefund } from './refunds'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db
let saleId: number
let saleItemId: number

// Predicates for assert.rejects take `unknown` — narrow via instanceof
// (a `(e: DomainError) => …` param would violate strictFunctionTypes).
const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
  await dbc.insert(schema.priceCache).values({ cardId: 1, cardmarketTrend: 1000 }) // sell 850p
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
  // A sale of 3 units with a 550p discount: subtotal 2550, total 2000. Ratio 2000/2550.
  const sale = await createSale({
    staffId: 1,
    items: [{ inventoryItemId: 1, quantity: 3 }],
    paymentMethod: 'cash',
    discount: 550,
    expectedTotal: 2000,
  }, dbc)
  saleId = sale.saleId
  const items = await dbc.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId))
  saleItemId = items[0].id
})

async function stockOf(id: number) {
  const [row] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, id))
  return row.quantity
}

test('partial refund restocks and reverses the discount proportionally', async () => {
  const { amount } = await createRefund({
    staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 1 }],
  }, dbc)
  // net 850 × (2000 / 2550) = 666.67… → 667
  assert.equal(amount, 667)
  assert.equal(await stockOf(1), 3) // 5 − 3 sold + 1 back
})

test('cannot refund more than remains, across successive refunds', async () => {
  await createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 2 }] }, dbc)
  await assert.rejects(
    createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 2 }] }, dbc),
    domainCode('BAD_LINE'),
  )
  // the one remaining unit still refundable
  const { amount } = await createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 1 }] }, dbc)
  assert.equal(amount, 667)
})

test('two lines referencing the same sale item are counted together', async () => {
  await assert.rejects(
    createRefund({
      staffId: 1, saleId, method: 'cash',
      items: [{ saleItemId, quantity: 2 }, { saleItemId, quantity: 2 }], // 4 > 3 sold
    }, dbc),
    domainCode('BAD_LINE'),
  )
  assert.equal(await stockOf(1), 2) // rollback — no restock happened
})

test('store credit refund writes a positive ledger row', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  const { amount } = await createRefund({
    staffId: 1, saleId, method: 'store_credit', customerId: 1,
    items: [{ saleItemId, quantity: 3 }],
  }, dbc)
  assert.equal(amount, 2000) // full refund = full charged total
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].delta, 2000)
  assert.equal(ledger[0].reason, 'refund')
})

test('cumulative refunds never exceed the amount charged', async () => {
  // Sale: 3 units × 850p = subtotal 2550p, total 2000p (550p discount)
  // Ratio = 2000/2550 ≈ 0.7843. Per-unit uncapped = round(850 × 0.7843) = 667.
  // Without a residual cap, 3 × 667 = 2001 — 1p over the charged amount.
  // With the cap the third refund is trimmed to 666 so the running total stays at 2000.
  const r1 = await createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 1 }] }, dbc)
  assert.equal(r1.amount, 667)
  const r2 = await createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 1 }] }, dbc)
  assert.equal(r2.amount, 667)
  const r3 = await createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 1 }] }, dbc)
  // residual cap: 2000 − (667 + 667) = 666, not the uncapped 667
  assert.equal(r3.amount, 666)
})

test('validation and not-found errors', async () => {
  await assert.rejects(
    createRefund({ staffId: 1, saleId: 999, method: 'cash', items: [{ saleItemId, quantity: 1 }] }, dbc),
    domainCode('NOT_FOUND'),
  )
  await assert.rejects(
    createRefund({ staffId: 1, saleId, method: 'cheque' as never, items: [{ saleItemId, quantity: 1 }] }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createRefund({ staffId: 1, saleId, method: 'store_credit', items: [{ saleItemId, quantity: 1 }] }, dbc), // customerId missing
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createRefund({ staffId: 1, saleId, method: 'cash', items: [] }, dbc),
    domainCode('INVALID_INPUT'),
  )
})
