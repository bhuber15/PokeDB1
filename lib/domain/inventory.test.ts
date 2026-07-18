import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { applyInventoryPatch } from './inventory'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db

const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
})

test('quantity change writes an append-only adjustment row', async () => {
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
  await applyInventoryPatch(1, 1, { quantity: 9 }, 'recount', dbc)
  const [row] = await dbc.select().from(schema.stockAdjustments)
  assert.equal(row.delta, 4)
  assert.equal(row.reason, 'recount')
})

test('quantity change without a reason is rejected and nothing is written', async () => {
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
  const updated = await applyInventoryPatch(1, 1, { location: 'Binder 3', costPrice: 250 }, undefined, dbc)
  assert.equal(updated.location, 'Binder 3')
  assert.equal(updated.costPrice, 250)
  const rows = await dbc.select().from(schema.stockAdjustments)
  assert.equal(rows.length, 0)
})

test('same-quantity patch writes no adjustment row', async () => {
  await applyInventoryPatch(1, 1, { quantity: 5 }, 'recount', dbc)
  const rows = await dbc.select().from(schema.stockAdjustments)
  assert.equal(rows.length, 0)
})

test('empty patch and missing item map to the right errors', async () => {
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
