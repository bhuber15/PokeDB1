import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { closeCashUp, getCashUpForDay, listCashUps } from './cash-ups'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
})

const DAY = '2026-07-06'

/** Seed one cash sale, one cash refund, one cash buy payout on DAY. */
async function seedCashMovements(): Promise<void> {
  const [sale] = await dbc.insert(schema.sales).values({
    staffId: 1, subtotal: 5000, total: 5000, paymentMethod: 'cash',
    createdAt: `${DAY} 10:00:00`,
  }).returning()
  await dbc.insert(schema.refunds).values({
    saleId: sale.id, method: 'cash', amount: 700, createdAt: `${DAY} 11:00:00`,
  })
  await dbc.insert(schema.buyTransactions).values({
    method: 'cash', total: 1200, createdAt: `${DAY} 12:00:00`,
  })
  // Non-cash rows must not affect the drawer
  await dbc.insert(schema.sales).values({
    staffId: 1, subtotal: 9999, total: 9999, paymentMethod: 'card',
    createdAt: `${DAY} 13:00:00`,
  })
}

// ---------------------------------------------------------------------------
// closeCashUp
// ---------------------------------------------------------------------------

test('closeCashUp snapshots the day cash movements and computes expected + variance', async () => {
  await seedCashMovements()

  // expected = 2000 float + 5000 sales − 700 refunds − 1200 payouts = 5100
  // counted 5000 → variance −100 (short)
  const record = await closeCashUp({
    staffId: 1, day: DAY, openingFloat: 2000, countedCash: 5000, notes: 'till short',
  }, dbc)

  assert.equal(record.day, DAY)
  assert.equal(record.staffId, 1)
  assert.equal(record.openingFloat, 2000)
  assert.equal(record.cashSales, 5000)
  assert.equal(record.cashRefunds, 700)
  assert.equal(record.cashBuyPayouts, 1200)
  assert.equal(record.expectedCash, 5100)
  assert.equal(record.countedCash, 5000)
  assert.equal(record.variance, -100)
  assert.equal(record.notes, 'till short')
})

test('closeCashUp on a day with no transactions: expected = float alone', async () => {
  const record = await closeCashUp({
    staffId: 1, day: DAY, openingFloat: 3000, countedCash: 3050,
  }, dbc)

  assert.equal(record.expectedCash, 3000)
  assert.equal(record.variance, 50) // over
  assert.equal(record.notes, null)
})

test('closeCashUp rejects a second close for the same day with CASH_UP_EXISTS', async () => {
  await closeCashUp({ staffId: 1, day: DAY, openingFloat: 0, countedCash: 0 }, dbc)

  await assert.rejects(
    closeCashUp({ staffId: 1, day: DAY, openingFloat: 0, countedCash: 0 }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'CASH_UP_EXISTS',
  )
})

test('closeCashUp validates day format and money inputs', async () => {
  const bad = (patch: Record<string, unknown>) =>
    assert.rejects(
      closeCashUp({ staffId: 1, day: DAY, openingFloat: 0, countedCash: 0, ...patch } as never, dbc),
      (e: unknown) => e instanceof DomainError && e.code === 'INVALID_INPUT',
    )

  await bad({ day: '06/07/2026' })
  await bad({ day: '2026-7-6' })
  await bad({ openingFloat: -1 })
  await bad({ countedCash: -1 })
  await bad({ openingFloat: 10.5 })
  await bad({ countedCash: 10.5 })
})

// ---------------------------------------------------------------------------
// getCashUpForDay / listCashUps
// ---------------------------------------------------------------------------

test('getCashUpForDay returns null before close, the record (with staff name) after', async () => {
  assert.equal(await getCashUpForDay(DAY, dbc), null)

  await closeCashUp({ staffId: 1, day: DAY, openingFloat: 1000, countedCash: 1000 }, dbc)

  const found = await getCashUpForDay(DAY, dbc)
  assert.ok(found)
  assert.equal(found.day, DAY)
  assert.equal(found.staffName, 'Tess')
  assert.equal(found.variance, 0)
})

test('listCashUps returns recent closes newest-day-first, capped by limit', async () => {
  await closeCashUp({ staffId: 1, day: '2026-07-04', openingFloat: 0, countedCash: 0 }, dbc)
  await closeCashUp({ staffId: 1, day: '2026-07-06', openingFloat: 0, countedCash: 0 }, dbc)
  await closeCashUp({ staffId: 1, day: '2026-07-05', openingFloat: 0, countedCash: 0 }, dbc)

  const all = await listCashUps(10, dbc)
  assert.deepEqual(all.map(c => c.day), ['2026-07-06', '2026-07-05', '2026-07-04'])

  const capped = await listCashUps(2, dbc)
  assert.deepEqual(capped.map(c => c.day), ['2026-07-06', '2026-07-05'])
})
