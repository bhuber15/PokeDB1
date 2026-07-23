import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { applyInventoryPatch, searchSellables } from './inventory'
import { createProduct } from './products'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db

const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
})

test('quantity change writes an append-only adjustment row', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
  const updated = await applyInventoryPatch(1, 1, { quantity: 3 }, 'damage', dbc)
  assert.equal(updated.quantity, 3)
  const rows = await dbc.select().from(schema.stockAdjustments)
    .where(eq(schema.stockAdjustments.inventoryItemId, 1))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].delta, -2)
  assert.equal(rows[0].reason, 'damage')
  assert.equal(rows[0].staffId, 1)
})

test('quantity increase records a positive delta', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
  await applyInventoryPatch(1, 1, { quantity: 9 }, 'recount', dbc)
  const [row] = await dbc.select().from(schema.stockAdjustments)
  assert.equal(row.delta, 4)
  assert.equal(row.reason, 'recount')
})

test('quantity change without a reason is rejected and nothing is written', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
  await assert.rejects(
    applyInventoryPatch(1, 1, { quantity: 3 }, undefined, dbc),
    domainCode('INVALID_INPUT'),
  )
  const [item] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, 1))
  assert.equal(item.quantity, 5)
  const rows = await dbc.select().from(schema.stockAdjustments)
  assert.equal(rows.length, 0)
})

test('non-quantity edits need no reason and write no adjustment', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
  const updated = await applyInventoryPatch(1, 1, { location: 'Binder 3', costPrice: 250 }, undefined, dbc)
  assert.equal(updated.location, 'Binder 3')
  assert.equal(updated.costPrice, 250)
  const rows = await dbc.select().from(schema.stockAdjustments)
  assert.equal(rows.length, 0)
})

test('same-quantity patch writes no adjustment row', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
  await applyInventoryPatch(1, 1, { quantity: 5 }, 'recount', dbc)
  const rows = await dbc.select().from(schema.stockAdjustments)
  assert.equal(rows.length, 0)
})

test('empty patch and missing item map to the right errors', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
  await assert.rejects(applyInventoryPatch(1, 1, {}, undefined, dbc), domainCode('INVALID_INPUT'))
  await assert.rejects(applyInventoryPatch(99, 1, { quantity: 1 }, 'recount', dbc), domainCode('NOT_FOUND'))
})

// ---------------------------------------------------------------------------
// redactInventoryCosts (F8: cost is admin-only)
// ---------------------------------------------------------------------------

test('redactInventoryCosts nulls costPrice for non-admins, passes through for admins', async () => {
  const { redactInventoryCosts } = await import('./inventory')
  const rows = [
    { item: { id: 1, costPrice: 400, quantity: 2 }, card: { name: 'Pikachu' } },
    { item: { id: 2, costPrice: null, quantity: 1 }, card: null },
  ]

  const staffView = redactInventoryCosts(rows, 'staff')
  assert.equal(staffView[0].item.costPrice, null)
  assert.equal(staffView[1].item.costPrice, null)
  assert.equal(staffView[0].item.quantity, 2) // everything else untouched
  assert.equal(rows[0].item.costPrice, 400)   // input not mutated

  const adminView = redactInventoryCosts(rows, 'admin')
  assert.equal(adminView[0].item.costPrice, 400)
})

// ---------------------------------------------------------------------------
// searchSellables (POS search: card name + product name + EAN fast-path)
// ---------------------------------------------------------------------------

test('EAN query returns exactly the matching product row', async () => {
  await createProduct({ name: 'SV Booster', category: 'sealed', ean: '5060000000017', sellPrice: 450, quantity: 5 }, dbc)
  await dbc.insert(schema.inventoryItems).values({ cardId: 1, condition: 'NM', quantity: 3, qrCode: 'qr-c1' })
  const rows = await searchSellables('5060000000017', dbc)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].product?.ean, '5060000000017')
  assert.equal(rows[0].card, null)
})

test('name query merges card and product matches', async () => {
  // seedBase card 1 is "Pikachu"
  await dbc.insert(schema.inventoryItems).values({ cardId: 1, condition: 'NM', quantity: 3, qrCode: 'qr-c2' })
  await createProduct({ name: 'Pikachu Plush Sleeves', category: 'accessories', sellPrice: 799, quantity: 2 }, dbc)
  const rows = await searchSellables('Pikachu', dbc)
  assert.equal(rows.length, 2)
  assert.ok(rows.some(r => r.card?.name === 'Pikachu'))
  assert.ok(rows.some(r => r.product?.name === 'Pikachu Plush Sleeves'))
})

test('all-digits query with no EAN hit falls through to name search', async () => {
  await dbc.insert(schema.inventoryItems).values({ cardId: 1, condition: 'NM', quantity: 3, qrCode: 'qr-c3' })
  const rows = await searchSellables('99999999', dbc)
  assert.equal(rows.length, 0) // no product with that EAN, no name containing it
})

test('inactive rows are excluded from search', async () => {
  const { item } = await createProduct({ name: 'Old Line', category: 'other', ean: '5060000000024', sellPrice: 100, quantity: 0 }, dbc)
  await dbc.update(schema.inventoryItems).set({ isActive: false }).where(eq(schema.inventoryItems.id, item.id))
  assert.equal((await searchSellables('5060000000024', dbc)).length, 0)
  assert.equal((await searchSellables('Old Line', dbc)).length, 0)
})

test('in-stock search matches the EN species alias of CJK cards', async () => {
  // Seed a CJK card with an EN species alias
  await dbc.insert(schema.cards).values({
    id: 2,
    name: 'ピカチュウ',
    aliasName: 'Pikachu',
    game: 'pokemon',
    language: 'JA',
    setName: 'テスト',
    setNumber: '099',
  })
  // Create an active inventory item for it
  await dbc.insert(schema.inventoryItems).values({
    id: 2,
    cardId: 2,
    condition: 'NM',
    quantity: 1,
    qrCode: 'qr-ja-pikachu',
  })
  // Search by the EN alias should find the JA card
  const rows = await searchSellables('Pikachu', dbc)
  assert.ok(rows.some(r => r.card?.name === 'ピカチュウ'), 'JA card should be found via EN alias')
})
