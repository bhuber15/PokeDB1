import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createBuy } from './buys'
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
})

test('buy creates a new stock row with QR code and records buy items', async () => {
  const { buyId, total } = await createBuy({
    staffId: 1,
    items: [{ cardId: 1, condition: 'NM', quantity: 2, payPrice: 4 }],
    method: 'cash',
  }, dbc)
  assert.equal(total, 8)
  const [inv] = await dbc.select().from(schema.inventoryItems)
    .where(and(eq(schema.inventoryItems.cardId, 1), eq(schema.inventoryItems.condition, 'NM')))
  assert.equal(inv.quantity, 2)
  assert.equal(inv.costPrice, 4)
  assert.ok(inv.qrCode.length > 0)
  const items = await dbc.select().from(schema.buyItems).where(eq(schema.buyItems.buyId, buyId))
  assert.equal(items.length, 1)
  assert.equal(items[0].inventoryItemId, inv.id)
})

test('merge on intake: existing active row gets quantity added and cost blended', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 2, costPrice: 3, qrCode: 'qr-1',
  })
  await createBuy({
    staffId: 1,
    items: [{ cardId: 1, condition: 'NM', quantity: 2, payPrice: 5 }],
    method: 'cash',
  }, dbc)
  const [inv] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, 1))
  assert.equal(inv.quantity, 4)
  assert.equal(inv.costPrice, 4) // (3×2 + 5×2) / 4
  const all = await dbc.select().from(schema.inventoryItems)
  assert.equal(all.length, 1) // no duplicate row
})

test('store credit buy writes a positive ledger row', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  const { buyId, total } = await createBuy({
    staffId: 1,
    items: [{ cardId: 1, condition: 'LP', quantity: 1, payPrice: 6.5 }],
    method: 'store_credit',
    customerId: 1,
  }, dbc)
  assert.equal(total, 6.5)
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].delta, 6.5)
  assert.equal(ledger[0].reason, 'buylist')
  assert.equal(ledger[0].refId, buyId)
  assert.equal(ledger[0].refType, 'buy')
})

test('validation and not-found errors', async () => {
  const good = { cardId: 1, condition: 'NM', quantity: 1, payPrice: 1 }
  await assert.rejects(
    createBuy({ staffId: 1, items: [], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, condition: 'MINT' }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, quantity: 0 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, payPrice: -1 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [good], method: 'store_credit' }, dbc), // no customer
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [good], method: 'store_credit', customerId: 99 }, dbc),
    domainCode('NOT_FOUND'),
  )
})
