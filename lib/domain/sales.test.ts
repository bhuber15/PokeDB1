import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createSale, type CreateSaleInput } from './sales'
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
  // card 1 priced at CM trend 1000p (£10) → sell = ceil(1000 × 0.85) = 850p (£8.50)
  await dbc.insert(schema.priceCache).values({ cardId: 1, cardmarketTrend: 1000 })
  // 5 in stock, cost 300p (£3), no override
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
})

const base: CreateSaleInput = {
  staffId: 1,
  items: [{ inventoryItemId: 1, quantity: 2 }],
  paymentMethod: 'cash',
  discount: 0,
  expectedTotal: 1700, // 2 × 850
}

async function stockOf(id: number) {
  const [row] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, id))
  return row.quantity
}

test('happy path: server computes price from market, decrements stock, snapshots cost', async () => {
  const { saleId, total } = await createSale(base, dbc)
  assert.equal(total, 1700)
  assert.equal(await stockOf(1), 3)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.subtotal, 1700)
  assert.equal(sale.vatScheme, 'none')
  assert.equal(sale.vatAmount, 0)
  const items = await dbc.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId))
  assert.equal(items.length, 1)
  assert.equal(items[0].priceAtSale, 850)
  assert.equal(items[0].costAtSale, 300)
})

test('persists an optional customerId on a non-store-credit sale', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  const { saleId } = await createSale({ ...base, paymentMethod: 'card', customerId: 1 }, dbc)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.customerId, 1)
  // No store-credit ledger side effects for a card sale
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 0)
})

test('customerId is null when no customer is supplied', async () => {
  const { saleId } = await createSale(base, dbc)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.customerId, null)
})

test('sell_price_override beats market price', async () => {
  await dbc.update(schema.inventoryItems).set({ sellPriceOverride: 1200 }).where(eq(schema.inventoryItems.id, 1))
  const { total } = await createSale({ ...base, expectedTotal: 2400 }, dbc)
  assert.equal(total, 2400)
})

test('NO_PRICE when neither override nor cached market price exists', async () => {
  await dbc.delete(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  await assert.rejects(
    createSale(base, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'NO_PRICE' && e.meta?.inventoryItemId === 1,
  )
  assert.equal(await stockOf(1), 5) // nothing written
})

test('PRICE_CHANGED when the till total is stale', async () => {
  await assert.rejects(
    createSale({ ...base, expectedTotal: 1500 }, dbc),
    domainCode('PRICE_CHANGED'),
  )
  assert.equal(await stockOf(1), 5)
})

test('discount is clamped to the subtotal, never negative total', async () => {
  const { total } = await createSale({ ...base, discount: 99900, expectedTotal: 0 }, dbc)
  assert.equal(total, 0)
})

test('INSUFFICIENT_STOCK rolls the whole sale back', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 2, cardId: 1, condition: 'LP', quantity: 1, costPrice: 100, qrCode: 'qr-2',
  })
  await assert.rejects(
    createSale({
      ...base,
      items: [
        { inventoryItemId: 1, quantity: 2 }, // fine
        { inventoryItemId: 2, quantity: 5 }, // only 1 in stock
      ],
      expectedTotal: 5950, // 7 × 850 — must match, or PRICE_CHANGED fires before the stock check
    }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'INSUFFICIENT_STOCK' && e.meta?.inventoryItemId === 2,
  )
  assert.equal(await stockOf(1), 5) // line 1's decrement rolled back
  assert.equal(await stockOf(2), 1)
  assert.deepEqual(await dbc.select().from(schema.sales), [])
})

test('store credit: balance checked inside the transaction, ledger debited', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  await dbc.insert(schema.creditLedger).values({ customerId: 1, delta: 2000, reason: 'adjustment' })
  const { saleId, total } = await createSale({ ...base, paymentMethod: 'store_credit', customerId: 1 }, dbc)
  assert.equal(total, 1700)
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 2)
  assert.equal(ledger[1].delta, -1700)
  assert.equal(ledger[1].refId, saleId)
})

test('INSUFFICIENT_CREDIT rolls back and restores stock', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  await dbc.insert(schema.creditLedger).values({ customerId: 1, delta: 500, reason: 'adjustment' })
  await assert.rejects(
    createSale({ ...base, paymentMethod: 'store_credit', customerId: 1 }, dbc),
    domainCode('INSUFFICIENT_CREDIT'),
  )
  assert.equal(await stockOf(1), 5)
  assert.deepEqual(await dbc.select().from(schema.sales), [])
})

test('VAT scheme "standard" adds 20% VAT on the post-discount subtotal', async () => {
  await dbc.update(schema.settings).set({ vatScheme: 'standard' }).where(eq(schema.settings.id, 1))
  // subtotal 1700 (no discount), VAT = round(1700 × 0.2) = 340, total = 2040
  const { saleId, total } = await createSale({ ...base, expectedTotal: 2040 }, dbc)
  assert.equal(total, 2040)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.subtotal, 1700)
  assert.equal(sale.vatScheme, 'standard')
  assert.equal(sale.vatAmount, 340)
  assert.equal(sale.total, 2040)
})

test('input validation', async () => {
  await assert.rejects(createSale({ ...base, items: [] }, dbc), domainCode('INVALID_INPUT'))
  await assert.rejects(
    createSale({ ...base, items: [{ inventoryItemId: 1, quantity: 0 }] }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, paymentMethod: 'iou' as never }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, paymentMethod: 'store_credit' }, dbc), // no customerId
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, items: [{ inventoryItemId: 99, quantity: 1 }] }, dbc),
    domainCode('NOT_FOUND'),
  )
})

test('idempotent replay: same clientUuid returns the original sale, stock decremented once', async () => {
  const withUuid = { ...base, clientUuid: '11111111-1111-4111-8111-111111111111' }
  const first = await createSale(withUuid, dbc)
  assert.equal(await stockOf(1), 3)

  const replay = await createSale(withUuid, dbc)
  assert.deepEqual(replay, first)
  assert.equal(await stockOf(1), 3) // no second decrement

  const allSales = await dbc.select().from(schema.sales)
  assert.equal(allSales.length, 1)
})

test('different clientUuid creates a separate sale', async () => {
  await createSale({ ...base, clientUuid: '11111111-1111-4111-8111-111111111111' }, dbc)
  await createSale({ ...base, clientUuid: '22222222-2222-4222-8222-222222222222' }, dbc)
  assert.equal(await stockOf(1), 1)
  const allSales = await dbc.select().from(schema.sales)
  assert.equal(allSales.length, 2)
})

test('replay works even after stock has run out', async () => {
  const withUuid = { ...base, items: [{ inventoryItemId: 1, quantity: 5 }], expectedTotal: 4250, clientUuid: '33333333-3333-4333-8333-333333333333' }
  const first = await createSale(withUuid, dbc)
  assert.equal(await stockOf(1), 0)
  // A naive re-execution would throw INSUFFICIENT_STOCK; replay must not
  const replay = await createSale(withUuid, dbc)
  assert.deepEqual(replay, first)
})

test('VAT scheme "margin": total unchanged, vat_amount is the per-line margin VAT', async () => {
  await dbc.update(schema.settings).set({ vatScheme: 'margin' }).where(eq(schema.settings.id, 1))
  // 2 × (sell 850 - cost 300) = margin 1100 → round(1100/6) = 183. Total stays 1700.
  const { saleId, total, marginNoCostCount } = await createSale({ ...base, expectedTotal: 1700 }, dbc)
  assert.equal(total, 1700)
  assert.equal(marginNoCostCount, 0)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.vatScheme, 'margin')
  assert.equal(sale.subtotal, 1700)
  assert.equal(sale.total, 1700)
  assert.equal(sale.vatAmount, 183)
})

test('VAT scheme "margin": no-cost line excluded by default, counted in the result', async () => {
  await dbc.update(schema.settings).set({ vatScheme: 'margin' }).where(eq(schema.settings.id, 1))
  await dbc.update(schema.inventoryItems).set({ costPrice: null }).where(eq(schema.inventoryItems.id, 1))
  const { total, marginNoCostCount } = await createSale({ ...base, expectedTotal: 1700 }, dbc)
  assert.equal(total, 1700)
  assert.equal(marginNoCostCount, 1)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, 1))
  assert.equal(sale.vatAmount, 0) // no cost basis → no margin VAT
})

test('VAT scheme "margin" with block: no-cost line rejects the sale, nothing written', async () => {
  await dbc.update(schema.settings)
    .set({ vatScheme: 'margin', marginNoCostHandling: 'block' })
    .where(eq(schema.settings.id, 1))
  await dbc.update(schema.inventoryItems).set({ costPrice: null }).where(eq(schema.inventoryItems.id, 1))
  await assert.rejects(
    createSale({ ...base, expectedTotal: 1700 }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'MARGIN_NO_COST',
  )
  assert.equal(await stockOf(1), 5) // untouched
  assert.deepEqual(await dbc.select().from(schema.sales), [])
})

// ---------------------------------------------------------------------------
// Split tender (F6)
// ---------------------------------------------------------------------------

async function paymentsOf(saleId: number) {
  return dbc.select().from(schema.salePayments).where(eq(schema.salePayments.saleId, saleId))
}

test('single-method sale writes one sale_payments row and keeps its method', async () => {
  const { saleId } = await createSale(base, dbc)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.paymentMethod, 'cash')
  const rows = await paymentsOf(saleId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].method, 'cash')
  assert.equal(rows[0].amount, 1700)
})

test('split cash+card: payment rows written, summary method is split', async () => {
  const { saleId, total } = await createSale({
    ...base,
    paymentMethod: undefined,
    payments: [{ method: 'cash', amount: 1000 }, { method: 'card', amount: 700 }],
  }, dbc)
  assert.equal(total, 1700)

  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.paymentMethod, 'split')

  const rows = await paymentsOf(saleId)
  assert.deepEqual(
    rows.map(r => ({ method: r.method, amount: r.amount })).sort((a, b) => a.method.localeCompare(b.method)),
    [{ method: 'card', amount: 700 }, { method: 'cash', amount: 1000 }],
  )
})

test('a single payments[] line keeps its own method as the summary', async () => {
  const { saleId } = await createSale({
    ...base,
    paymentMethod: undefined,
    payments: [{ method: 'card', amount: 1700 }],
  }, dbc)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.paymentMethod, 'card')
})

test('payments that do not sum to the total are rejected', async () => {
  await assert.rejects(
    createSale({
      ...base,
      paymentMethod: undefined,
      payments: [{ method: 'cash', amount: 1000 }, { method: 'card', amount: 600 }],
    }, dbc),
    domainCode('INVALID_INPUT'),
  )
  assert.equal(await stockOf(1), 5) // nothing decremented
})

test('providing both or neither of paymentMethod/payments is rejected', async () => {
  await assert.rejects(
    createSale({
      ...base,
      payments: [{ method: 'cash', amount: 1700 }],
    }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, paymentMethod: undefined }, dbc),
    domainCode('INVALID_INPUT'),
  )
})

test('split with store credit debits only the credit portion from the ledger', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Casey' })
  await dbc.insert(schema.creditLedger).values({ customerId: 1, delta: 500, reason: 'adjustment' })

  // balance (500) < total (1700) but covers the credit portion
  const { saleId } = await createSale({
    ...base,
    paymentMethod: undefined,
    payments: [{ method: 'store_credit', amount: 500 }, { method: 'cash', amount: 1200 }],
    customerId: 1,
  }, dbc)

  const entries = await dbc.select().from(schema.creditLedger)
    .where(eq(schema.creditLedger.customerId, 1))
  const debit = entries.find(e => e.reason === 'sale')
  assert.ok(debit, 'sale debit written')
  assert.equal(debit.delta, -500)
  assert.equal(debit.refId, saleId)
})

test('split store-credit portion above the balance is rejected', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Casey' })
  await dbc.insert(schema.creditLedger).values({ customerId: 1, delta: 400, reason: 'adjustment' })

  await assert.rejects(
    createSale({
      ...base,
      paymentMethod: undefined,
      payments: [{ method: 'store_credit', amount: 500 }, { method: 'cash', amount: 1200 }],
      customerId: 1,
    }, dbc),
    domainCode('INSUFFICIENT_CREDIT'),
  )
  assert.equal(await stockOf(1), 5) // transaction rolled back
})

test('split payment validation: bad amounts, too many lines, dup store credit, missing customer', async () => {
  const bad = (payments: { method: string; amount: number }[], customerId?: number) =>
    assert.rejects(
      createSale({ ...base, paymentMethod: undefined, payments: payments as never, customerId }, dbc),
      domainCode('INVALID_INPUT'),
    )

  await bad([{ method: 'cash', amount: 0 }, { method: 'card', amount: 1700 }])
  await bad([{ method: 'cash', amount: -100 }, { method: 'card', amount: 1800 }])
  await bad([{ method: 'cash', amount: 850.5 }, { method: 'card', amount: 849.5 }])
  await bad([{ method: 'cheque', amount: 1700 }])
  await bad([
    { method: 'cash', amount: 400 }, { method: 'card', amount: 400 },
    { method: 'other', amount: 400 }, { method: 'cash', amount: 250 }, { method: 'card', amount: 250 },
  ])
  // two store-credit lines
  await bad([{ method: 'store_credit', amount: 800 }, { method: 'store_credit', amount: 900 }], 1)
  // store-credit line without a customer
  await bad([{ method: 'store_credit', amount: 500 }, { method: 'cash', amount: 1200 }])
})
