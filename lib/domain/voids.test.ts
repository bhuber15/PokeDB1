import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { voidSale } from './voids'
import { getCashUpSummary, getSalesByStaff } from './reports'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db

const todayUTC = () => new Date().toISOString().slice(0, 10)
const yesterdayUTC = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 200, qrCode: 'void-1',
  })
})

/** Insert a sale with one line of 2 units from inventory item 1. */
async function insertSale(opts: {
  paymentMethod?: string
  createdAt?: string
  customerId?: number
  total?: number
}): Promise<number> {
  const total = opts.total ?? 1000
  const [sale] = await dbc.insert(schema.sales).values({
    staffId: 1,
    customerId: opts.customerId ?? null,
    subtotal: total,
    total,
    paymentMethod: opts.paymentMethod ?? 'cash',
    createdAt: opts.createdAt ?? `${todayUTC()} 10:00:00`,
  }).returning()
  await dbc.insert(schema.saleItems).values({
    saleId: sale.id, inventoryItemId: 1, quantity: 2, priceAtSale: total / 2, costAtSale: 200,
  })
  return sale.id
}

async function getItemQty(): Promise<number> {
  const [item] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, 1))
  return item.quantity
}

// ---------------------------------------------------------------------------
// voidSale — happy paths
// ---------------------------------------------------------------------------

test('voidSale restores stock and marks the sale voided with staff + reason', async () => {
  const saleId = await insertSale({})
  assert.equal(await getItemQty(), 5)

  const result = await voidSale({ staffId: 1, saleId, reason: 'mis-ring' }, dbc)
  assert.equal(result.saleId, saleId)
  assert.equal(result.total, 1000)

  assert.equal(await getItemQty(), 7) // 5 + 2 restored

  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.ok(sale.voidedAt, 'voidedAt set')
  assert.equal(sale.voidedByStaffId, 1)
  assert.equal(sale.voidReason, 'mis-ring')
})

test('voidSale on a store-credit sale returns the credit via the ledger', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Casey' })
  const saleId = await insertSale({ paymentMethod: 'store_credit', customerId: 1 })
  // The original sale would have debited the ledger at creation time
  await dbc.insert(schema.creditLedger).values({
    customerId: 1, delta: -1000, reason: 'sale', refType: 'sale', refId: saleId, staffId: 1,
  })

  await voidSale({ staffId: 1, saleId }, dbc)

  const entries = await dbc.select().from(schema.creditLedger)
    .where(eq(schema.creditLedger.customerId, 1))
  const voidEntry = entries.find(e => e.reason === 'void')
  assert.ok(voidEntry, 'void ledger entry written')
  assert.equal(voidEntry.delta, 1000)
  assert.equal(voidEntry.refType, 'sale')
  assert.equal(voidEntry.refId, saleId)
  // Net balance back to zero
  assert.equal(entries.reduce((s, e) => s + e.delta, 0), 0)
})

// ---------------------------------------------------------------------------
// voidSale — guards
// ---------------------------------------------------------------------------

test('voidSale rejects a second void with SALE_VOIDED', async () => {
  const saleId = await insertSale({})
  await voidSale({ staffId: 1, saleId }, dbc)

  await assert.rejects(
    voidSale({ staffId: 1, saleId }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'SALE_VOIDED',
  )
  assert.equal(await getItemQty(), 7) // stock restored exactly once
})

test('voidSale rejects a sale that already has a refund', async () => {
  const saleId = await insertSale({})
  await dbc.insert(schema.refunds).values({ saleId, method: 'cash', amount: 100 })

  await assert.rejects(
    voidSale({ staffId: 1, saleId }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'VOID_NOT_ALLOWED',
  )
})

test('voidSale rejects a sale from a previous day', async () => {
  const saleId = await insertSale({ createdAt: `${yesterdayUTC()} 23:59:59` })

  await assert.rejects(
    voidSale({ staffId: 1, saleId }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'VOID_NOT_ALLOWED',
  )
})

test('voidSale rejects an unknown sale with NOT_FOUND', async () => {
  await assert.rejects(
    voidSale({ staffId: 1, saleId: 999 }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND',
  )
})

// ---------------------------------------------------------------------------
// Reports exclude voided sales
// ---------------------------------------------------------------------------

test('voided sales disappear from cash-up and by-staff aggregates', async () => {
  const day = todayUTC()
  const keptId = await insertSale({ total: 600 })
  const voidedId = await insertSale({ total: 1000 })
  await voidSale({ staffId: 1, saleId: voidedId }, dbc)

  const summary = await getCashUpSummary(day, dbc)
  assert.equal(summary.cashSales, 600) // only the kept sale

  const byStaff = await getSalesByStaff(day, day, dbc)
  assert.equal(byStaff.length, 1)
  assert.equal(byStaff[0].saleCount, 1)
  assert.equal(byStaff[0].revenue, 600)
  assert.ok(keptId !== voidedId)
})
