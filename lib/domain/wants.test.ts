import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/test-helpers'
import * as schema from '../db/schema'
import {
  listOpenWants,
  countInStockWants,
  setWantNotify,
  sendWantInStockNotification,
} from './wants'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db
let qrSeq = 0

const isNotFound = (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND'

async function seedCustomer(name: string, phone?: string, email?: string) {
  const [c] = await dbc.insert(schema.customers).values({ name, phone, email }).returning()
  return c
}

async function seedCard(name: string) {
  const [c] = await dbc.insert(schema.cards).values({
    name, setName: 'Base Set', setNumber: '1/1',
  }).returning()
  return c
}

async function stock(cardId: number, isActive = true) {
  qrSeq += 1
  await dbc.insert(schema.inventoryItems).values({
    cardId, quantity: 1, condition: 'NM', costPrice: 100, qrCode: `qr-${qrSeq}`, isActive,
  })
}

beforeEach(async () => {
  dbc = await createTestDb()
})

test('listOpenWants marks a want in stock when an active inventory item exists', async () => {
  const cust = await seedCustomer('Ash', '07700 900111', 'ash@example.com')
  const card = await seedCard('Pikachu')
  await stock(card.id, true)
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: card.id })

  const [w] = await listOpenWants(dbc)
  assert.equal(w.inStock, true)
  assert.equal(w.customerPhone, '07700 900111')
  assert.equal(w.customerEmail, 'ash@example.com')
  assert.equal(w.cardName, 'Pikachu')
})

test('a want is not in stock when the only inventory row is inactive', async () => {
  const cust = await seedCustomer('Misty')
  const card = await seedCard('Staryu')
  await stock(card.id, false)
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: card.id })

  const [w] = await listOpenWants(dbc)
  assert.equal(w.inStock, false)
})

test('free-text wants are never in stock', async () => {
  const cust = await seedCustomer('Brock')
  await dbc.insert(schema.wantList).values({ customerId: cust.id, freeText: 'Onix promo' })

  const [w] = await listOpenWants(dbc)
  assert.equal(w.inStock, false)
})

test('fulfilled wants are excluded from listOpenWants and the count', async () => {
  const cust = await seedCustomer('Gary')
  const card = await seedCard('Eevee')
  await stock(card.id, true)
  await dbc.insert(schema.wantList).values({
    customerId: cust.id, cardId: card.id, fulfilledAt: '2026-07-10T00:00:00Z',
  })

  assert.equal((await listOpenWants(dbc)).length, 0)
  assert.equal(await countInStockWants(dbc), 0)
})

test('countInStockWants counts only in-stock open wants', async () => {
  const cust = await seedCustomer('Jessie')
  const inStockCard = await seedCard('Meowth')
  const outCard = await seedCard('Wobbuffet')
  await stock(inStockCard.id, true)
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: inStockCard.id })
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: outCard.id })

  assert.equal(await countInStockWants(dbc), 1)
})

test('setWantNotify flips the flag', async () => {
  const cust = await seedCustomer('James')
  const [want] = await dbc.insert(schema.wantList)
    .values({ customerId: cust.id, freeText: 'Arbok', notify: true }).returning()

  await setWantNotify(want.id, false, dbc)

  const [row] = await dbc.select().from(schema.wantList)
    .where(eq(schema.wantList.id, want.id))
  assert.equal(row.notify, false)
})

test('setWantNotify throws NOT_FOUND for a missing want', async () => {
  await assert.rejects(() => setWantNotify(9999, false, dbc), isNotFound)
})

test('sendWantInStockNotification reports the provider is not configured', async () => {
  const cust = await seedCustomer('Nurse Joy')
  const card = await seedCard('Chansey')
  await stock(card.id, true)
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: card.id })
  const [w] = await listOpenWants(dbc)

  const result = await sendWantInStockNotification(w, dbc)
  assert.deepEqual(result, { sent: false, reason: 'provider_not_configured', wantId: w.id })
})
