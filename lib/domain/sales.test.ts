import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createSale, type CreateSaleInput } from './sales'
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
  // card 1 priced at CM trend £10 → sell = ceil(10 × 0.85) = £8.50
  await dbc.insert(schema.priceCache).values({ cardId: 1, cardmarketTrend: 10 })
  // 5 in stock, cost £3, no override
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 3, qrCode: 'qr-1',
  })
})

const base: CreateSaleInput = {
  staffId: 1,
  items: [{ inventoryItemId: 1, quantity: 2 }],
  paymentMethod: 'cash',
  discount: 0,
  expectedTotal: 17, // 2 × 8.50
}

async function stockOf(id: number) {
  const [row] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, id))
  return row.quantity
}

test('happy path: server computes price from market, decrements stock, snapshots cost', async () => {
  const { saleId, total } = await createSale(base, dbc)
  assert.equal(total, 17)
  assert.equal(await stockOf(1), 3)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.subtotal, 17)
  assert.equal(sale.vatScheme, 'none')
  assert.equal(sale.vatAmount, 0)
  const items = await dbc.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId))
  assert.equal(items.length, 1)
  assert.equal(items[0].priceAtSale, 8.5)
  assert.equal(items[0].costAtSale, 3)
})

test('sell_price_override beats market price', async () => {
  await dbc.update(schema.inventoryItems).set({ sellPriceOverride: 12 }).where(eq(schema.inventoryItems.id, 1))
  const { total } = await createSale({ ...base, expectedTotal: 24 }, dbc)
  assert.equal(total, 24)
})

test('NO_PRICE when neither override nor cached market price exists', async () => {
  await dbc.delete(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  await assert.rejects(
    createSale(base, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'NO_PRICE' && e.meta?.inventoryItemId === 1,
  )
  assert.equal(await stockOf(1), 5) // nothing written
})

test('PRICE_CHANGED when the till total is stale', async () => {
  await assert.rejects(
    createSale({ ...base, expectedTotal: 15 }, dbc),
    domainCode('PRICE_CHANGED'),
  )
  assert.equal(await stockOf(1), 5)
})

test('discount is clamped to the subtotal, never negative total', async () => {
  const { total } = await createSale({ ...base, discount: 999, expectedTotal: 0 }, dbc)
  assert.equal(total, 0)
})

test('INSUFFICIENT_STOCK rolls the whole sale back', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 2, cardId: 1, condition: 'LP', quantity: 1, costPrice: 1, qrCode: 'qr-2',
  })
  await assert.rejects(
    createSale({
      ...base,
      items: [
        { inventoryItemId: 1, quantity: 2 }, // fine
        { inventoryItemId: 2, quantity: 5 }, // only 1 in stock
      ],
      expectedTotal: 59.5, // 7 × 8.50 — must match, or PRICE_CHANGED fires before the stock check
    }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'INSUFFICIENT_STOCK' && e.meta?.inventoryItemId === 2,
  )
  assert.equal(await stockOf(1), 5) // line 1's decrement rolled back
  assert.equal(await stockOf(2), 1)
  assert.deepEqual(await dbc.select().from(schema.sales), [])
})

test('store credit: balance checked inside the transaction, ledger debited', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  await dbc.insert(schema.creditLedger).values({ customerId: 1, delta: 20, reason: 'adjustment' })
  const { saleId, total } = await createSale({ ...base, paymentMethod: 'store_credit', customerId: 1 }, dbc)
  assert.equal(total, 17)
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 2)
  assert.equal(ledger[1].delta, -17)
  assert.equal(ledger[1].refId, saleId)
})

test('INSUFFICIENT_CREDIT rolls back and restores stock', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  await dbc.insert(schema.creditLedger).values({ customerId: 1, delta: 5, reason: 'adjustment' })
  await assert.rejects(
    createSale({ ...base, paymentMethod: 'store_credit', customerId: 1 }, dbc),
    domainCode('INSUFFICIENT_CREDIT'),
  )
  assert.equal(await stockOf(1), 5)
  assert.deepEqual(await dbc.select().from(schema.sales), [])
})

test('input validation', async () => {
  await assert.rejects(createSale({ ...base, items: [] }, dbc), domainCode('INVALID_INPUT'))
  await assert.rejects(
    createSale({ ...base, items: [{ inventoryItemId: 1, quantity: 0 }] }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, paymentMethod: 'iou' as never }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, paymentMethod: 'store_credit' }, dbc), // no customerId
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, items: [{ inventoryItemId: 99, quantity: 1 }] }, dbc),
    domainCode('NOT_FOUND'),
  )
})
