import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import type { Db } from '../db'
import type { AppSettings } from '../settings'
import {
  syncCardmarketForCard, sweepTcgplayerCatalogue, syncInStockCardmarket, pruneOldHistory,
} from './sync'

const SETTINGS: AppSettings = {
  shopName: 'Test', usdToGbp: 0.8, eurToGbp: 0.85, marginMultiplier: 0.85,
  highValueThreshold: 5000, buyCashPct: 0.5, buyCreditPct: 0.65,
  primaryPriceSource: 'cardmarket', vatScheme: 'none',
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function apiCard(externalId: string, name: string, marketUsd: number | null) {
  return {
    id: externalId, name, number: '1',
    set: { name: 'Test Set', series: 'T', releaseDate: '2026/01/01' },
    images: { small: 's.png', large: 'l.png' },
    tcgplayer: marketUsd != null ? { prices: { normal: { market: marketUsd } } } : undefined,
  }
}

// Routes fetch calls by hostname: TCG API pages and TCGdex per-card pricing.
function stubFetch(opts: {
  pages?: Record<number, { data: unknown[]; totalCount: number } | 'fail'>
  cardmarket?: Record<string, { trend?: number; low?: number; avg?: number } | 'fail'>
}) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('api.pokemontcg.io')) {
      const page = Number(new URL(url).searchParams.get('page'))
      const body = opts.pages?.[page]
      if (!body || body === 'fail') return new Response('boom', { status: 500 })
      return Response.json(body)
    }
    if (url.includes('api.tcgdex.net')) {
      const id = url.split('/').pop()!
      const cm = opts.cardmarket?.[id]
      if (!cm || cm === 'fail') return new Response('boom', { status: 500 })
      return Response.json({ pricing: { cardmarket: cm } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
}

let db: Db
beforeEach(async () => {
  db = await createTestDb()
  await seedBase(db) // card id 1 'Pikachu', staff, settings
  await db.update(schema.cards).set({ externalId: 'base1-58' }).where(eq(schema.cards.id, 1))
})

test('syncCardmarketForCard inserts the price_cache row when missing (no silent no-op)', async () => {
  stubFetch({ cardmarket: { 'base1-58': { trend: 10, low: 8, avg: 9 } } })
  await syncCardmarketForCard(1, 'base1-58', null, 0.85, db)
  const [row] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  assert.ok(row, 'price_cache row was created')
  assert.equal(row.cardmarketTrend, 850) // €10 × 0.85 × 100
})

test('cardmarket sync records history only for in-stock or high-value cards', async () => {
  stubFetch({ cardmarket: { 'base1-58': { trend: 10 } } })
  await syncCardmarketForCard(1, 'base1-58', null, 0.85, db)
  let history = await db.select().from(schema.priceHistory)
  assert.equal(history.length, 0, 'no history for an unstocked, low-value card')

  await db.insert(schema.inventoryItems).values({
    cardId: 1, condition: 'NM', quantity: 1, costPrice: 100, qrCode: 'q1',
  })
  await syncCardmarketForCard(1, 'base1-58', null, 0.85, db)
  history = await db.select().from(schema.priceHistory)
  assert.equal(history.length, 1)
  assert.equal(history[0].cardmarketTrend, 850)

  // Same-day re-sync updates rather than duplicating
  stubFetch({ cardmarket: { 'base1-58': { trend: 12 } } })
  await syncCardmarketForCard(1, 'base1-58', null, 0.85, db)
  history = await db.select().from(schema.priceHistory)
  assert.equal(history.length, 1)
  assert.equal(history[0].cardmarketTrend, 1020)
})

test('sweep inserts unknown cards and refreshes prices for known ones', async () => {
  stubFetch({
    pages: {
      1: { data: [apiCard('base1-58', 'Pikachu', 5), apiCard('sv1-1', 'Sprigatito', 2)], totalCount: 2 },
    },
  })
  const result = await sweepTcgplayerCatalogue(SETTINGS, {}, db)
  assert.equal(result.pagesFetched, 1)
  assert.equal(result.cardsSeen, 2)
  assert.equal(result.newCards, 1) // Sprigatito; Pikachu already existed

  const allCards = await db.select().from(schema.cards)
  assert.equal(allCards.length, 2)
  assert.ok(allCards.every(c => c.series === 'T'), 'series captured from the API for every card')
  const [pikachuPrice] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  assert.equal(pikachuPrice.tcgplayerMarket, 400) // $5 × 0.8 × 100
})

test('sweep heals card identity fields from the API', async () => {
  await db.update(schema.cards).set({ name: 'Blastoise (mislabelled)', imageUrl: 'bad.png' })
    .where(eq(schema.cards.id, 1))
  stubFetch({ pages: { 1: { data: [apiCard('base1-58', 'Pikachu', 2)], totalCount: 1 } } })
  await sweepTcgplayerCatalogue(SETTINGS, {}, db)
  const [c] = await db.select().from(schema.cards).where(eq(schema.cards.id, 1))
  assert.equal(c.name, 'Pikachu')
  assert.equal(c.imageUrl, 's.png')
})

test('sweep records history for high-value cards and skips cheap unstocked ones', async () => {
  stubFetch({
    pages: {
      1: { data: [apiCard('base1-58', 'Pikachu', 2), apiCard('base1-4', 'Charizard', 400)], totalCount: 2 },
    },
  })
  await sweepTcgplayerCatalogue(SETTINGS, {}, db) // £320 Charizard ≥ £50 threshold
  const history = await db.select().from(schema.priceHistory)
  assert.equal(history.length, 1)
  const [charizard] = await db.select().from(schema.cards).where(eq(schema.cards.externalId, 'base1-4'))
  assert.equal(history[0].cardId, charizard.id)
})

test('sweep isolates page failures and stops after 3 consecutive', async () => {
  stubFetch({
    pages: {
      1: { data: [apiCard('sv1-1', 'Sprigatito', 2)], totalCount: 1500 },
      2: 'fail', 3: 'fail', 4: 'fail',
      5: { data: [apiCard('sv1-2', 'Floragato', 2)], totalCount: 1500 },
    },
  })
  const result = await sweepTcgplayerCatalogue(SETTINGS, { pageSize: 1 }, db)
  assert.equal(result.pagesFetched, 1)
  assert.equal(result.pagesFailed, 3) // gave up before page 5
  assert.equal(result.newCards, 1)
})

test('syncInStockCardmarket isolates per-card failures', async () => {
  await db.insert(schema.cards).values({ id: 2, name: 'Mew', setName: 'S', setNumber: '2', externalId: 'base1-99' })
  await db.insert(schema.inventoryItems).values([
    { cardId: 1, condition: 'NM', quantity: 1, costPrice: 100, qrCode: 'q1' },
    { cardId: 2, condition: 'NM', quantity: 1, costPrice: 100, qrCode: 'q2' },
  ])
  stubFetch({ cardmarket: { 'base1-58': { trend: 10 }, 'base1-99': 'fail' } })
  const result = await syncInStockCardmarket(SETTINGS, db)
  // TCGdex client swallows HTTP errors into null, so both "sync" (one updates,
  // one no-ops) — the failure counter covers thrown errors (network/DB)
  assert.equal(result.synced + result.failed, 2)
  const [row] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  assert.equal(row.cardmarketTrend, 850)
})

test('pruneOldHistory deletes rows older than 90 days only', async () => {
  const old = new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const recent = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  await db.insert(schema.priceHistory).values([
    { cardId: 1, tcgplayerMarket: 100, recordedOn: old },
    { cardId: 1, tcgplayerMarket: 200, recordedOn: recent },
  ])
  await pruneOldHistory(db)
  const rows = await db.select().from(schema.priceHistory)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].recordedOn, recent)
})
