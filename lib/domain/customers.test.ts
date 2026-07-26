import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { getCustomerPurchases } from './customers'
import type { Db } from '../db'

let dbc: Db

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 200, qrCode: 'cust-1',
  })
})

async function insertSale(opts: { customerId?: number; voidedAt?: string; total?: number }): Promise<number> {
  const total = opts.total ?? 1000
  const [sale] = await dbc.insert(schema.sales).values({
    staffId: 1,
    customerId: opts.customerId ?? null,
    subtotal: total,
    total,
    paymentMethod: 'cash',
    voidedAt: opts.voidedAt ?? null,
  }).returning()
  await dbc.insert(schema.saleItems).values({
    saleId: sale.id, inventoryItemId: 1, quantity: 2, priceAtSale: total / 2, costAtSale: 200,
  })
  return sale.id
}

test('purchase history returns the customer\'s sales with grouped items', async () => {
  const saleId = await insertSale({ customerId: 1, total: 600 })

  const purchases = await getCustomerPurchases(1, dbc)
  assert.equal(purchases.length, 1)
  assert.equal(purchases[0].id, saleId)
  assert.equal(purchases[0].total, 600)
  assert.equal(purchases[0].items.length, 1)
  assert.equal(purchases[0].items[0].cardName, 'Pikachu')
  assert.equal(purchases[0].items[0].quantity, 2)
})

test('purchase history excludes voided sales', async () => {
  const kept = await insertSale({ customerId: 1, total: 600 })
  await insertSale({ customerId: 1, total: 1000, voidedAt: '2026-07-06 12:00:00' })

  const purchases = await getCustomerPurchases(1, dbc)
  assert.equal(purchases.length, 1)
  assert.equal(purchases[0].id, kept)
})

test('purchase history excludes other customers\' and walk-in sales', async () => {
  await dbc.insert(schema.customers).values({ id: 2, name: 'Eve' })
  await insertSale({ customerId: 2 })
  await insertSale({})

  assert.deepEqual(await getCustomerPurchases(1, dbc), [])
})
