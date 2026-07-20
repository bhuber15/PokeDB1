import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { buildReceiptData, emailReceipt } from './receipts'
import { createSale } from './sales'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db
let saleId: number

beforeEach(async () => {
  delete process.env.RESEND_API_KEY
  dbc = await createTestDb()
  await seedBase(dbc) // card 1 = Pikachu, settings shopName default 'PokeDB'
  await dbc.insert(schema.customers).values({ id: 1, name: 'Ash', email: 'ash@example.com' })
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, qrCode: 'r1',
  })
  const [sale] = await dbc.insert(schema.sales).values({
    staffId: 1, customerId: 1, subtotal: 2000, discountAmount: 200, vatAmount: 0,
    vatScheme: 'none', total: 1800, paymentMethod: 'split', createdAt: '2026-07-10 12:00:00',
  }).returning()
  saleId = sale.id
  await dbc.insert(schema.saleItems).values({
    saleId, inventoryItemId: 1, quantity: 2, priceAtSale: 1000, costAtSale: 300,
  })
  await dbc.insert(schema.salePayments).values([
    { saleId, method: 'cash', amount: 1000 },
    { saleId, method: 'card', amount: 800 },
  ])
})

// ---------------------------------------------------------------------------
// buildReceiptData
// ---------------------------------------------------------------------------

test('buildReceiptData reconstructs the receipt from the DB', async () => {
  const { receipt, customerEmail } = await buildReceiptData(saleId, dbc)

  assert.equal(receipt.saleId, saleId)
  assert.equal(receipt.shopName, 'PokeDB')
  assert.deepEqual(receipt.lines, [{ name: 'Pikachu', condition: 'NM', quantity: 2, price: 1000 }])
  assert.equal(receipt.subtotal, 2000)
  assert.equal(receipt.discount, 200)
  assert.equal(receipt.total, 1800)
  assert.equal(receipt.vatScheme, 'none')
  assert.equal(receipt.paymentMethod, 'split')
  assert.deepEqual(receipt.payments, [
    { method: 'cash', amount: 1000 },
    { method: 'card', amount: 800 },
  ])
  assert.equal(customerEmail, 'ash@example.com')
})

test('buildReceiptData: unknown sale NOT_FOUND, voided sale SALE_VOIDED', async () => {
  await assert.rejects(
    buildReceiptData(999, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND',
  )
  await dbc.update(schema.sales).set({ voidedAt: '2026-07-10 13:00:00' }).where(eq(schema.sales.id, saleId))
  await assert.rejects(
    buildReceiptData(saleId, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'SALE_VOIDED',
  )
})

// ---------------------------------------------------------------------------
// emailReceipt
// ---------------------------------------------------------------------------

test('emailReceipt falls back to the customer email and reports the skip without a provider', async () => {
  const result = await emailReceipt({ saleId }, dbc)
  assert.equal(result.to, 'ash@example.com')
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
})

test('emailReceipt sends via the provider when configured', async () => {
  process.env.RESEND_API_KEY = 're_test_key'
  try {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const fetchStub: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 })
    }

    const result = await emailReceipt({ saleId, email: 'other@example.com' }, dbc, fetchStub)

    assert.equal(result.ok, true)
    assert.equal(result.to, 'other@example.com')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body.to, ['other@example.com'])
    assert.match(String(calls[0].body.subject), /Receipt #\d+/)
    assert.match(String(calls[0].body.html), /Pikachu/)
    assert.match(String(calls[0].body.html), /Paid — cash/)
  } finally {
    delete process.env.RESEND_API_KEY
  }
})

test('emailReceipt with no address anywhere is INVALID_INPUT', async () => {
  await dbc.update(schema.customers).set({ email: null }).where(eq(schema.customers.id, 1))
  await assert.rejects(
    emailReceipt({ saleId }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'INVALID_INPUT',
  )
})

test('emailReceipt rejects an invalid explicit address', async () => {
  await assert.rejects(
    emailReceipt({ saleId, email: 'not-an-email' }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'INVALID_INPUT',
  )
})

// ---------------------------------------------------------------------------
// Product lines (non-card SKUs)
// ---------------------------------------------------------------------------

// Self-contained high ids so it cannot collide with this file's beforeEach
// seeding. Add imports if missing: createSale from './sales'.
test('receipt lines name products and blank the NA condition', async () => {
  await dbc.insert(schema.products).values({ id: 71, name: 'SV Booster', category: 'sealed' })
  await dbc.insert(schema.inventoryItems).values({
    id: 71, productId: 71, condition: 'NA', quantity: 5, sellPriceOverride: 450, qrCode: 'qr-t71',
  })
  const { saleId } = await createSale({
    staffId: 1, items: [{ inventoryItemId: 71, quantity: 1 }],
    paymentMethod: 'cash', discount: 0, expectedTotal: 450,
  }, dbc)
  const { receipt } = await buildReceiptData(saleId, dbc)
  assert.equal(receipt.lines[0].name, 'SV Booster')
  assert.equal(receipt.lines[0].condition, '')
})
