import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import type { Db } from '../db'
import type { AppSettings } from '../settings'
import {
  syncMarketPricesForCard, sweepTcgplayerCatalogue, syncInStockCardmarket, pruneOldHistory,
  syncStaleCardmarket, refreshStaleCardmarket,
} from './sync'

const SETTINGS: AppSettings = {
  shopName: 'Test', usdToGbp: 0.8, eurToGbp: 0.85, marginMultiplier: 0.85,
  highValueThreshold: 5000, buyCashPct: 0.5, buyCreditPct: 0.65,
  primaryPriceSource: 'cardmarket', vatScheme: 'none', marginNoCostHandling: 'exclude',
  enabledLanguages: ['EN'],
  enabledGames: ['pokemon'],
  conditionSellPct: { NM: 100, LP: 100, MP: 100, HP: 100, DMG: 100 },
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
// TCGdex entries: 'missing' → 404 (card unknown, a real "no data" answer);
// 'fail' or unstubbed → 500 (transient failure, the client throws).
function stubFetch(opts: {
  pages?: Record<number, { data: unknown[]; totalCount: number } | 'fail'>
  cardmarket?: Record<string, { trend?: number; low?: number; avg?: number } | 'fail' | 'missing'>
  tcgdexCards?: Record<string, { dexId?: number[]; pricing?: { cardmarket?: unknown; tcgplayer?: unknown } } | 'fail' | 'missing'>
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
      const tc = opts.tcgdexCards?.[id]
      if (tc === 'missing') return new Response('not found', { status: 404 })
      if (tc === 'fail') return new Response('boom', { status: 500 })
      if (tc) return Response.json(tc)
      const cm = opts.cardmarket?.[id]
      if (cm === 'missing') return new Response('not found', { status: 404 })
      if (!cm || cm === 'fail') return new Response('boom', { status: 500 })
      return Response.json({ pricing: { cardmarket: cm } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
}

async function insertJaCard(dbc: Db, aliasName: string | null = null): Promise<number> {
  const [c] = await dbc.insert(schema.cards).values({
    name: 'リザードン', aliasName, game: 'pokemon', language: 'JA',
    setName: 'テスト', setNumber: '006', externalId: 'tcgdex:ja:TEST-006',
  }).returning()
  return c.id
}

let db: Db
beforeEach(async () => {
  db = await createTestDb()
  await seedBase(db) // card id 1 'Pikachu', staff, settings
  await db.update(schema.cards).set({ externalId: 'base1-58' }).where(eq(schema.cards.id, 1))
})

test('syncMarketPricesForCard inserts the price_cache row when missing (no silent no-op)', async () => {
  stubFetch({ cardmarket: { 'base1-58': { trend: 10, low: 8, avg: 9 } } })
  await syncMarketPricesForCard(1, 'base1-58', null, { eur: 0.85, usd: 0.79 }, db)
  const [row] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  assert.ok(row, 'price_cache row was created')
  assert.equal(row.cardmarketTrend, 850) // €10 × 0.85 × 100
})

test('syncMarketPricesForCard: an all-zero TCGdex block is "no data" — keeps cached values, stamps the check', async () => {
  stubFetch({ cardmarket: { 'base1-58': { trend: 10, low: 8, avg: 9 } } })
  await syncMarketPricesForCard(1, 'base1-58', null, { eur: 0.85, usd: 0.79 }, db)

  // TCGdex "loses" the pricing (emits zeros): the real trend must survive, never become 0.
  stubFetch({ cardmarket: { 'base1-58': { trend: 0, low: 0, avg: 0 } } })
  await syncMarketPricesForCard(1, 'base1-58', null, { eur: 0.85, usd: 0.79 }, db)
  const [row] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  assert.equal(row.cardmarketTrend, 850, 'previously cached trend survives a zero-block answer')
})

test('syncMarketPricesForCard: zero trend with real low/avg stores null trend, not 0', async () => {
  stubFetch({ cardmarket: { 'base1-58': { trend: 0, low: 8, avg: 9 } } })
  await syncMarketPricesForCard(1, 'base1-58', null, { eur: 0.85, usd: 0.79 }, db)
  const [row] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  assert.equal(row.cardmarketTrend, null)
  assert.equal(row.cardmarketLow, 680)
  assert.equal(row.cardmarketAvg, 765)
})

test('cardmarket sync records history only for in-stock or high-value cards', async () => {
  stubFetch({ cardmarket: { 'base1-58': { trend: 10 } } })
  await syncMarketPricesForCard(1, 'base1-58', null, { eur: 0.85, usd: 0.79 }, db)
  let history = await db.select().from(schema.priceHistory)
  assert.equal(history.length, 0, 'no history for an unstocked, low-value card')

  await db.insert(schema.inventoryItems).values({
    cardId: 1, condition: 'NM', quantity: 1, costPrice: 100, qrCode: 'q1',
  })
  await syncMarketPricesForCard(1, 'base1-58', null, { eur: 0.85, usd: 0.79 }, db)
  history = await db.select().from(schema.priceHistory)
  assert.equal(history.length, 1)
  assert.equal(history[0].cardmarketTrend, 850)

  // Same-day re-sync updates rather than duplicating
  stubFetch({ cardmarket: { 'base1-58': { trend: 12 } } })
  await syncMarketPricesForCard(1, 'base1-58', null, { eur: 0.85, usd: 0.79 }, db)
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
  // A TCGdex 5xx/network error throws and is counted as failed; the good card
  // still lands and the failed one keeps no cardmarket_synced_at, so it is
  // retried on the next run rather than treated as checked.
  assert.equal(result.synced, 1)
  assert.equal(result.failed, 1)
  const [row] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  assert.equal(row.cardmarketTrend, 850)
  const failedRows = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 2))
  assert.equal(failedRows.length, 0, 'transient failure leaves no cache row / stamp behind')
})

test('syncMarketPricesForCard records a no-data check without clobbering cached values', async () => {
  await db.insert(schema.priceCache).values({ cardId: 1, tcgplayerMarket: 500, cardmarketTrend: 999 })
  stubFetch({ cardmarket: { 'base1-58': 'missing' } }) // TCGdex 404 — a real answer
  await syncMarketPricesForCard(1, 'base1-58', null, { eur: 0.85, usd: 0.79 }, db)
  const [row] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  assert.ok(row.cardmarketSyncedAt, 'check recorded so rotation/on-demand move on')
  assert.equal(row.cardmarketTrend, 999, 'previously cached trend preserved')
  assert.equal(row.tcgplayerMarket, 500)

  // No pre-existing row: the check still creates one, so the card leaves the
  // never-checked front of the rotation queue.
  await db.insert(schema.cards).values({ id: 2, name: 'Mew', setName: 'S', setNumber: '2', externalId: 'base1-99' })
  stubFetch({ cardmarket: { 'base1-99': 'missing' } })
  await syncMarketPricesForCard(2, 'base1-99', null, { eur: 0.85, usd: 0.79 }, db)
  const [row2] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 2))
  assert.ok(row2?.cardmarketSyncedAt)
  assert.equal(row2.cardmarketTrend, null)
})

test('tcgdex ids fetch per-language, write both column families, and backfill alias', async () => {
  const id = await insertJaCard(db)
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: {
    cardmarket: { trend: 4, low: 3, avg: 3.5 },
    tcgplayer: { holofoil: { marketPrice: 5, lowPrice: 4, midPrice: 4.5, highPrice: 9 } },
  } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db)

  const [pc] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, id))
  assert.equal(pc.cardmarketTrend, Math.round(4 * 0.85 * 100))
  assert.equal(pc.tcgplayerMarket, Math.round(5 * 0.8 * 100))
  assert.ok(pc.cardmarketSyncedAt)
  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.id, id))
  assert.equal(card.aliasName, 'Charizard')
})

test('tcgdex sync records price history with both trend and tcgplayerMarket when interesting', async () => {
  const id = await insertJaCard(db)
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: {
    cardmarket: { trend: 4, low: 3, avg: 3.5 },
    tcgplayer: { holofoil: { marketPrice: 5, lowPrice: 4, midPrice: 4.5, highPrice: 9 } },
  } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db, { interesting: true })
  const history = await db.select().from(schema.priceHistory).where(eq(schema.priceHistory.cardId, id))
  assert.equal(history.length, 1)
  assert.equal(history[0].cardmarketTrend, Math.round(4 * 0.85 * 100))
  assert.equal(history[0].tcgplayerMarket, Math.round(5 * 0.8 * 100))
})

test('a tcgdex response carrying only one column family leaves the other cached family alone', async () => {
  const id = await insertJaCard(db)
  // First sync: both blocks present, seeds both column families.
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: {
    cardmarket: { trend: 4, low: 3, avg: 3.5 },
    tcgplayer: { holofoil: { marketPrice: 5, lowPrice: 4, midPrice: 4.5, highPrice: 9 } },
  } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db)

  // Second sync: only cardmarket comes back this time — tcgplayer must survive untouched.
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: {
    cardmarket: { trend: 6, low: 5, avg: 5.5 }, tcgplayer: null,
  } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db)
  let [pc] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, id))
  assert.equal(pc.cardmarketTrend, Math.round(6 * 0.85 * 100), 'cardmarket updated to the new value')
  assert.equal(pc.tcgplayerMarket, Math.round(5 * 0.8 * 100), 'tcgplayer untouched by a cardmarket-only response')

  // Third sync: only tcgplayer comes back — cardmarket must survive untouched this time.
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: {
    cardmarket: null, tcgplayer: { holofoil: { marketPrice: 7, lowPrice: 6, midPrice: 6.5, highPrice: 11 } },
  } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db)
  ;[pc] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, id))
  assert.equal(pc.tcgplayerMarket, Math.round(7 * 0.8 * 100), 'tcgplayer updated to the new value')
  assert.equal(pc.cardmarketTrend, Math.round(6 * 0.85 * 100), 'cardmarket untouched by a tcgplayer-only response')
})

test('tcgdex card with null pricing blocks stamps the check and still backfills alias', async () => {
  const id = await insertJaCard(db)
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [25], pricing: { cardmarket: null, tcgplayer: null } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db)

  const [pc] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, id))
  assert.ok(pc.cardmarketSyncedAt)   // checked — rotation moves on
  assert.equal(pc.cardmarketTrend, null)
  assert.equal(pc.tcgplayerMarket, null)
  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.id, id))
  assert.equal(card.aliasName, 'Pikachu')
})

test('alias backfill never overwrites an existing aliasName', async () => {
  const id = await insertJaCard(db, 'Custom')
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: { cardmarket: null, tcgplayer: null } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db)
  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.id, id))
  assert.equal(card.aliasName, 'Custom')
})

test('syncStaleCardmarket walks the catalogue stalest-first within its limit', async () => {
  await db.insert(schema.cards).values([
    { id: 2, name: 'Mew', setName: 'S', setNumber: '2', externalId: 'base1-99' },
    { id: 3, name: 'Mewtwo', setName: 'S', setNumber: '3', externalId: 'base1-77' },
    { id: 4, name: 'Hand-entered', setName: 'S', setNumber: '4' }, // no externalId → never a candidate
  ])
  const staleAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const freshAt = new Date(Date.now() - 3600 * 1000).toISOString() // within the 20h re-check guard
  await db.insert(schema.priceCache).values([
    { cardId: 2, cardmarketTrend: 100, cardmarketSyncedAt: staleAt },
    { cardId: 3, cardmarketTrend: 200, cardmarketSyncedAt: freshAt },
  ])
  // Card 1 has no cache row (never checked) → sorts before the stale card 2.
  stubFetch({ cardmarket: { 'base1-58': { trend: 10 }, 'base1-99': { trend: 20 } } })

  let res = await syncStaleCardmarket(SETTINGS, { limit: 1 }, db)
  assert.deepEqual(res, { synced: 1, failed: 0, remaining: 0 })
  const trendOf = async (cardId: number) =>
    (await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, cardId)))[0]?.cardmarketTrend
  assert.equal(await trendOf(1), 850, 'never-checked card synced first')
  assert.equal(await trendOf(2), 100, 'stale card waits for the next slice')

  res = await syncStaleCardmarket(SETTINGS, { limit: 1 }, db)
  assert.equal(res.synced, 1)
  assert.equal(await trendOf(2), 1700, 'stale card picked up on the next run')
  assert.equal(await trendOf(3), 200, 'fresh card never re-fetched')

  // Everything now checked within 20h → nothing left to rotate.
  res = await syncStaleCardmarket(SETTINGS, {}, db)
  assert.deepEqual(res, { synced: 0, failed: 0, remaining: 0 })
})

test('syncStaleCardmarket advances past cards TCGdex has no data for', async () => {
  await db.insert(schema.cards).values({ id: 2, name: 'Mew', setName: 'S', setNumber: '2', externalId: 'base1-99' })
  stubFetch({ cardmarket: { 'base1-58': 'missing', 'base1-99': { trend: 20 } } })
  const res = await syncStaleCardmarket(SETTINGS, {}, db)
  assert.equal(res.synced, 2, 'a no-data answer still counts as a completed check')
  assert.equal(res.failed, 0)
  const rows = await db.select().from(schema.priceCache)
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.cardmarketSyncedAt), 'both cards stamped — the rotation queue advances')
})

test('syncStaleCardmarket leaves transient failures unstamped for retry and stops at its time budget', async () => {
  stubFetch({ cardmarket: { 'base1-58': 'fail' } })
  const res = await syncStaleCardmarket(SETTINGS, {}, db)
  assert.deepEqual(res, { synced: 0, failed: 1, remaining: 0 })
  const rows = await db.select().from(schema.priceCache)
  assert.equal(rows.length, 0, 'failed fetch is not recorded as a check')

  const spent = await syncStaleCardmarket(SETTINGS, { timeBudgetMs: 0 }, db)
  assert.deepEqual(spent, { synced: 0, failed: 0, remaining: 1 }, 'exhausted budget syncs nothing')
})

test('refreshStaleCardmarket refreshes missing/stale entries, skips fresh ones, respects its bound', async () => {
  await db.insert(schema.cards).values([
    { id: 2, name: 'Mew', setName: 'S', setNumber: '2', externalId: 'base1-99' },
    { id: 3, name: 'Mewtwo', setName: 'S', setNumber: '3', externalId: 'base1-77' },
  ])
  await db.insert(schema.priceCache).values([
    // Stale: past the 7-day on-demand threshold.
    { cardId: 2, cardmarketTrend: 100, cardmarketSyncedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() },
    { cardId: 3, cardmarketTrend: 200, cardmarketSyncedAt: new Date().toISOString() },
  ])
  stubFetch({ cardmarket: { 'base1-58': { trend: 10 }, 'base1-99': { trend: 20 } } })
  const cardRows = await db.select().from(schema.cards).orderBy(schema.cards.id)

  // maxCards keeps the bound on the first rows passed (display order).
  const first = await refreshStaleCardmarket(cardRows, db, { maxCards: 1 })
  assert.equal(first, 1)
  const trendOf = async (cardId: number) =>
    (await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, cardId)))[0]?.cardmarketTrend
  // Settings row default eurToGbp (0.86) applies: €10 → 860p.
  assert.equal(await trendOf(1), 860)
  assert.equal(await trendOf(2), 100, 'beyond maxCards — untouched')

  const rest = await refreshStaleCardmarket(cardRows, db)
  assert.equal(rest, 1, 'card 1 now fresh; only the stale card 2 refreshed')
  assert.equal(await trendOf(2), 1720)
  assert.equal(await trendOf(3), 200, 'fresh entry never re-fetched')
})

test('refreshStaleCardmarket is best-effort: TCGdex failures are swallowed, not thrown', async () => {
  stubFetch({ cardmarket: { 'base1-58': 'fail' } })
  const cardRows = await db.select().from(schema.cards)
  const n = await refreshStaleCardmarket(cardRows, db)
  assert.equal(n, 0)
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

test('tcgdex priceHistory conflict-set is per-block conditional (same-day partial re-sync must not null a recorded family)', async () => {
  const id = await insertJaCard(db)
  // First sync: both blocks present, seeds both column families in history.
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: {
    cardmarket: { trend: 4, low: 3, avg: 3.5 },
    tcgplayer: { holofoil: { marketPrice: 5, lowPrice: 4, midPrice: 4.5, highPrice: 9 } },
  } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db, { interesting: true })
  let history = await db.select().from(schema.priceHistory).where(eq(schema.priceHistory.cardId, id))
  assert.equal(history.length, 1)
  const firstCardmarketTrend = Math.round(4 * 0.85 * 100)
  const firstTcgplayerMarket = Math.round(5 * 0.8 * 100)
  assert.equal(history[0].cardmarketTrend, firstCardmarketTrend)
  assert.equal(history[0].tcgplayerMarket, firstTcgplayerMarket)

  // Second sync same day: only cardmarket block — tcgplayer history must survive untouched.
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: {
    cardmarket: { trend: 6, low: 5, avg: 5.5 }, tcgplayer: null,
  } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db, { interesting: true })
  history = await db.select().from(schema.priceHistory).where(eq(schema.priceHistory.cardId, id))
  assert.equal(history.length, 1, 'same-day re-sync updates the row, not duplicates')
  const secondCardmarketTrend = Math.round(6 * 0.85 * 100)
  assert.equal(history[0].cardmarketTrend, secondCardmarketTrend, 'cardmarket updated to the new value')
  assert.equal(history[0].tcgplayerMarket, firstTcgplayerMarket, 'tcgplayer untouched by a cardmarket-only response')
})
