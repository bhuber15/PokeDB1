import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { searchSales } from './sales-search'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db
let charizardSaleId: number
let pikachuSaleId: number

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc) // card 1 = Pikachu, staff 1 = Tess
  await dbc.insert(schema.cards).values({ id: 2, name: 'Charizard', setName: 'Base', setNumber: '4/102' })
  await dbc.insert(schema.customers).values({ id: 1, name: 'Ash Ketchum' })
  await dbc.insert(schema.inventoryItems).values([
    { id: 1, cardId: 1, condition: 'NM', quantity: 5, qrCode: 's1' },
    { id: 2, cardId: 2, condition: 'LP', quantity: 5, qrCode: 's2' },
  ])

  // Sale 1: Charizard to Ash (customer-linked), 2026-07-01
  const [s1] = await dbc.insert(schema.sales).values({
    staffId: 1, customerId: 1, subtotal: 5000, total: 5000, paymentMethod: 'card',
    createdAt: '2026-07-01 10:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({ saleId: s1.id, inventoryItemId: 2, quantity: 1, priceAtSale: 5000 })
  charizardSaleId = s1.id

  // Sale 2: Pikachu, walk-in, 2026-07-10
  const [s2] = await dbc.insert(schema.sales).values({
    staffId: 1, subtotal: 500, total: 500, paymentMethod: 'cash',
    createdAt: '2026-07-10 12:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({ saleId: s2.id, inventoryItemId: 1, quantity: 2, priceAtSale: 250 })
  pikachuSaleId = s2.id
})

test('searchSales by receipt number returns exactly that sale', async () => {
  const rows = await searchSales({ q: String(charizardSaleId) }, dbc)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sale.id, charizardSaleId)
  assert.equal(rows[0].customerName, 'Ash Ketchum')
  assert.equal(rows[0].staffName, 'Tess')
  assert.match(rows[0].itemsSummary, /Charizard/)
})

test('searchSales by card name matches sales containing that card', async () => {
  const rows = await searchSales({ q: 'chariz' }, dbc)
  assert.deepEqual(rows.map(r => r.sale.id), [charizardSaleId])
})

test('searchSales by customer name matches their sales', async () => {
  const rows = await searchSales({ q: 'ketchum' }, dbc)
  assert.deepEqual(rows.map(r => r.sale.id), [charizardSaleId])
})

test('searchSales by date range, newest first', async () => {
  const all = await searchSales({ from: '2026-07-01', to: '2026-07-10' }, dbc)
  assert.deepEqual(all.map(r => r.sale.id), [pikachuSaleId, charizardSaleId])

  const julyFirst = await searchSales({ from: '2026-07-01', to: '2026-07-01' }, dbc)
  assert.deepEqual(julyFirst.map(r => r.sale.id), [charizardSaleId])
})

test('searchSales combines q with a date range', async () => {
  const rows = await searchSales({ q: 'pikachu', from: '2026-07-01', to: '2026-07-01' }, dbc)
  assert.equal(rows.length, 0) // Pikachu sale is outside the range
})

test('searchSales includes voided sales (flagged via sale.voidedAt)', async () => {
  await dbc.update(schema.sales)
    .set({ voidedAt: '2026-07-10 13:00:00' })
    .where(undefined)
  const rows = await searchSales({ q: 'pikachu' }, dbc)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].sale.voidedAt)
})

test('searchSales validates input: empty filters and bad dates rejected', async () => {
  const bad = (filters: Record<string, unknown>) =>
    assert.rejects(
      searchSales(filters as never, dbc),
      (e: unknown) => e instanceof DomainError && e.code === 'INVALID_INPUT',
    )
  await bad({})
  await bad({ q: '   ' })
  await bad({ from: '01/07/2026' })
  await bad({ to: 'nope' })
})
