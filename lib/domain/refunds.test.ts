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
  await dbc.insert(schema.priceCache).values({ cardId: 1, cardmarketTrend: 10 }) // sell £8.50
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 3, qrCode: 'qr-1',
  })
  // A sale of 3 units with a £5.50 discount: subtotal 25.50, total 20. Ratio 20/25.50.
  const sale = await createSale({
    staffId: 1,
    items: [{ inventoryItemId: 1, quantity: 3 }],
    paymentMethod: 'cash',
    discount: 5.5,
    expectedTotal: 20,
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
  // net 8.50 × (20 / 25.50) = 6.666… → 6.67
  assert.equal(amount, 6.67)
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
  assert.equal(amount, 6.67)
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
  assert.equal(amount, 20) // full refund = full charged total
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].delta, 20)
  assert.equal(ledger[0].reason, 'refund')
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
