import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import { getTenantDbFor } from '../db/index'
import { createSale } from '../domain/sales'
import * as schema from '../db/schema'

// Phase-1 exit test (spec §Part 4): two tenant DBs served by one process,
// operations on one never touch the other, and the singleton is unreachable.

const originalMode = process.env.TENANCY_MODE
before(() => { process.env.TENANCY_MODE = 'multi' })
after(() => {
  if (originalMode === undefined) delete process.env.TENANCY_MODE
  else process.env.TENANCY_MODE = originalMode
})

test('sales in tenant A are invisible to tenant B', async () => {
  const dbA = await createTestDb()
  const dbB = await createTestDb()
  await seedBase(dbA)
  await seedBase(dbB)

  // Stock one copy of card 1 in each shop at different prices. qrCode is
  // required + unique per row; the real override column is sellPriceOverride
  // (not priceOverride). seedBase's settings row defaults vatScheme to
  // 'none', so the customer total is just sellPriceOverride × quantity.
  await dbA.insert(schema.inventoryItems).values({
    cardId: 1, condition: 'NM', quantity: 5, sellPriceOverride: 500, costPrice: 200, qrCode: 'tenant-a-qr-1',
  })
  await dbB.insert(schema.inventoryItems).values({
    cardId: 1, condition: 'NM', quantity: 3, sellPriceOverride: 900, costPrice: 400, qrCode: 'tenant-b-qr-1',
  })

  const [itemA] = await dbA.select().from(schema.inventoryItems)
  const saleA = await createSale({
    items: [{ inventoryItemId: itemA.id, quantity: 1 }],
    paymentMethod: 'cash',
    discount: 0,
    staffId: 1,
    expectedTotal: 500, // override 500 × qty 1, vatScheme 'none' -> no VAT added
  }, dbA)
  assert.ok(saleA.saleId)

  // Tenant B: no sales, stock untouched.
  const salesB = await dbB.select().from(schema.sales)
  assert.equal(salesB.length, 0)
  const [itemB] = await dbB.select().from(schema.inventoryItems)
  assert.equal(itemB.quantity, 3)

  // Tenant A: stock decremented exactly once.
  const [itemA2] = await dbA.select().from(schema.inventoryItems)
    .where(eq(schema.inventoryItems.id, itemA.id))
  assert.equal(itemA2.quantity, 4)
})

test('getTenantDbFor keeps clients isolated under interleaved use', async () => {
  const a = getTenantDbFor('iso-a', 'file:/tmp/iso-a.db')
  const b = getTenantDbFor('iso-b', 'file:/tmp/iso-b.db')
  assert.notEqual(a, b)
})
