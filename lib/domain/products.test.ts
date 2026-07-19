import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import type { Db } from '@/lib/db'
import * as schema from '@/lib/db/schema'
import { createProduct, updateProduct } from './products'
import { DomainError } from './errors'

let dbc: Db
beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
})

const base = { name: 'SV Booster Pack', category: 'sealed' as const, ean: '5060000000017', sellPrice: 450, costPrice: 250, quantity: 12 }

test('createProduct creates identity + single stock row', async () => {
  const { product, item } = await createProduct(base, dbc)
  assert.equal(product.name, 'SV Booster Pack')
  assert.equal(product.ean, '5060000000017')
  assert.equal(item.productId, product.id)
  assert.equal(item.cardId, null)              // mutual exclusivity
  assert.equal(item.condition, 'NA')
  assert.equal(item.quantity, 12)
  assert.equal(item.sellPriceOverride, 450)    // price is required, lands as override
  assert.equal(item.costPrice, 250)
  assert.ok(item.qrCode)
})

test('active duplicate EAN is rejected', async () => {
  await createProduct(base, dbc)
  await assert.rejects(createProduct({ ...base, name: 'Other' }, dbc),
    (e: DomainError) => e.code === 'DUPLICATE_EAN')
})

test('re-adding a discontinued EAN reuses the product and reactivates its stock row', async () => {
  const first = await createProduct(base, dbc)
  await dbc.update(schema.inventoryItems).set({ isActive: false })
    .where(eq(schema.inventoryItems.id, first.item.id))
  const again = await createProduct({ ...base, name: 'SV Booster Pack (2026)', sellPrice: 500, quantity: 6 }, dbc)
  assert.equal(again.product.id, first.product.id)      // same identity row
  assert.equal(again.item.id, first.item.id)            // same stock row
  assert.equal(again.item.isActive, true)
  assert.equal(again.item.quantity, 6)
  assert.equal(again.item.sellPriceOverride, 500)
  assert.equal(again.product.name, 'SV Booster Pack (2026)')
})

test('validation: bad category, bad EAN, non-positive price, negative quantity', async () => {
  for (const bad of [
    { ...base, category: 'weapons' as never },
    { ...base, ean: 'abc123' },
    { ...base, sellPrice: 0 },
    { ...base, quantity: -1 },
  ]) {
    await assert.rejects(createProduct(bad, dbc), (e: DomainError) => e.code === 'INVALID_INPUT')
  }
})

test('EAN is optional', async () => {
  const { product } = await createProduct({ ...base, ean: null }, dbc)
  assert.equal(product.ean, null)
})

test('updateProduct renames; unknown id NOT_FOUND; EAN collision DUPLICATE_EAN', async () => {
  const { product } = await createProduct(base, dbc)
  const renamed = await updateProduct(product.id, { name: 'Renamed' }, dbc)
  assert.equal(renamed.name, 'Renamed')
  await assert.rejects(updateProduct(9999, { name: 'x' }, dbc), (e: DomainError) => e.code === 'NOT_FOUND')
  await createProduct({ ...base, name: 'Second', ean: '5060000000024' }, dbc)
  await assert.rejects(updateProduct(product.id, { ean: '5060000000024' }, dbc),
    (e: DomainError) => e.code === 'DUPLICATE_EAN')
})
