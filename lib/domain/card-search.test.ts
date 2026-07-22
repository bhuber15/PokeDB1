import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { searchCards } from './card-search'
import type { Db } from '../db'
import type { PokemonTCGCard } from '../apis/pokemon-tcg'

let dbc: Db

// Live-API stubs: searches should never hit the network from tests.
const liveNever = () => Promise.reject(new Error('live API should not be called'))
const liveEmpty = () => Promise.resolve([] as PokemonTCGCard[])
const syncNoop = () => Promise.resolve()
// Combined stub for tests that seed rows with an externalId (the JA printing
// below): without stubbing syncMarketPrices too, refreshStaleCardmarket would
// fire a real TCGdex fetch for that row's missing cache entry.
const noLiveDeps = { fetchLive: liveEmpty, syncMarketPrices: syncNoop }

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc) // seeds card id 1 "Pikachu"
  await dbc.insert(schema.cards).values([
    { id: 2, name: 'Pikachu VMAX', setName: 'Vivid Voltage', setNumber: '44/185' },
    { id: 3, name: 'Surfing Pikachu', setName: 'Evolutions', setNumber: '111/108' },
    { id: 4, name: 'Snorlax', setName: 'Base Set', setNumber: '27/130' },
    { id: 5, name: 'Snorlax', setName: 'Team Up', setNumber: '141/181' },
    { id: 6, name: 'Snorunt', setName: 'Crown Zenith', setNumber: '37/159' },
    { id: 7, name: 'Charizard', setName: 'Base Set', setNumber: '4/102' },
  ])
})

test('exact name match ranks before prefix and substring matches', async () => {
  const res = await searchCards('Pikachu', dbc, { fetchLive: liveNever })
  assert.equal(res.fuzzy, false)
  assert.deepEqual(res.cards.map(c => c.name), ['Pikachu', 'Pikachu VMAX', 'Surfing Pikachu'])
})

test('substring and set-number matches are found', async () => {
  const bySub = await searchCards('kachu', dbc, { fetchLive: liveNever })
  assert.equal(bySub.cards.length, 3)
  const byNumber = await searchCards('4/102', dbc, { fetchLive: liveNever })
  assert.deepEqual(byNumber.cards.map(c => c.name), ['Charizard'])
})

test('misspelling falls back to fuzzy suggestions covering every printing', async () => {
  const res = await searchCards('Snorlex', dbc, { fetchLive: liveNever })
  assert.equal(res.fuzzy, true)
  assert.equal(res.unavailable, false)
  // Every Snorlax printing first (best score, then set name), weaker
  // suggestions like Snorunt after, nothing unrelated.
  assert.deepEqual(res.cards.map(c => c.name), ['Snorlax', 'Snorlax', 'Snorunt'])
  assert.deepEqual(res.cards.map(c => c.id), [4, 5, 6])
})

test('search results include cached prices keyed by card id', async () => {
  await dbc.insert(schema.priceCache).values({ cardId: 4, tcgplayerMarket: 1234 })
  const res = await searchCards('Snorlax', dbc, { fetchLive: liveNever })
  assert.equal(res.prices[4]?.tcgplayerMarket, 1234)
  assert.equal(res.prices[5], undefined)
})

test('no local or fuzzy match and empty live result is a clean no-results, not unavailable', async () => {
  const res = await searchCards('Zzzqqqxxx', dbc, { fetchLive: liveEmpty })
  assert.deepEqual(res.cards, [])
  assert.equal(res.fuzzy, false)
  assert.equal(res.unavailable, false)
})

test('live-API failure (e.g. timeout) reports unavailable instead of hanging or throwing', async () => {
  const res = await searchCards('Zzzqqqxxx', dbc, {
    fetchLive: () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
  })
  assert.deepEqual(res.cards, [])
  assert.equal(res.unavailable, true)
})

test('live fallback inserts new cards with cached prices and returns them', async () => {
  const apiCard: PokemonTCGCard = {
    id: 'sv9-999',
    name: 'Zzzqqqxxx',
    number: '99',
    set: { name: 'Future Set', series: 'Scarlet & Violet', releaseDate: '2026/01/01' },
    subtypes: ['Basic'],
    images: { small: 'https://img/small.png', large: 'https://img/large.png' },
    tcgplayer: { prices: { normal: { market: 10 } } },
  }
  const res = await searchCards('Zzzqqqxxx', dbc, {
    fetchLive: () => Promise.resolve([apiCard]),
    syncMarketPrices: syncNoop,
  })
  assert.equal(res.cards.length, 1)
  assert.equal(res.cards[0].name, 'Zzzqqqxxx')
  assert.equal(res.cards[0].externalId, 'sv9-999')
  assert.equal(res.unavailable, false)

  const [row] = await dbc.select().from(schema.cards).where(eq(schema.cards.externalId, 'sv9-999'))
  assert.ok(row, 'card lazily inserted into the catalogue')
  assert.ok(res.prices[row.id], 'price cache row returned with the result')
})

test('search refreshes a missing Cardmarket entry before pricing results', async () => {
  // Catalogue card with only TCGplayer (USD-derived) data — the exact case
  // where a buy offer would silently price off the US market.
  await dbc.update(schema.cards).set({ externalId: 'base1-58' }).where(eq(schema.cards.id, 1))
  await dbc.insert(schema.priceCache).values({ cardId: 1, tcgplayerMarket: 1000 })

  const synced: number[] = []
  const res = await searchCards('Pikachu', dbc, {
    fetchLive: liveNever,
    syncMarketPrices: async (cardId) => {
      synced.push(cardId)
      await dbc.update(schema.priceCache)
        .set({ cardmarketTrend: 850, cardmarketSyncedAt: new Date().toISOString() })
        .where(eq(schema.priceCache.cardId, cardId))
    },
  })
  // Only card 1 has an externalId; the other Pikachu printings can't be fetched.
  assert.deepEqual(synced, [1])
  assert.equal(res.prices[1]?.cardmarketTrend, 850, 'response carries the refreshed price')
})

test('search leaves fresh Cardmarket entries alone', async () => {
  await dbc.update(schema.cards).set({ externalId: 'base1-58' }).where(eq(schema.cards.id, 1))
  await dbc.insert(schema.priceCache).values({
    cardId: 1, cardmarketTrend: 900, cardmarketSyncedAt: new Date().toISOString(),
  })
  let called = false
  const res = await searchCards('Pikachu', dbc, {
    fetchLive: liveNever,
    syncMarketPrices: async () => { called = true },
  })
  assert.equal(called, false, 'fresh cache → no TCGdex round-trip')
  assert.equal(res.prices[1]?.cardmarketTrend, 900)
})

test('a failing Cardmarket refresh never breaks search', async () => {
  await dbc.update(schema.cards).set({ externalId: 'base1-58' }).where(eq(schema.cards.id, 1))
  await dbc.insert(schema.priceCache).values({ cardId: 1, tcgplayerMarket: 1000 })
  const res = await searchCards('Pikachu', dbc, {
    fetchLive: liveNever,
    syncMarketPrices: () => Promise.reject(new Error('tcgdex down')),
  })
  assert.equal(res.cards.length, 3)
  assert.equal(res.prices[1]?.tcgplayerMarket, 1000, 'cached prices still served')
})

test('live fallback returns the existing row instead of duplicating it', async () => {
  await dbc.insert(schema.cards).values({
    id: 42, name: 'Zzzqqqxxx', setName: 'Future Set', setNumber: '99', externalId: 'sv9-999',
  })
  // Query misses locally, and the live API returns a card whose externalId
  // is already in the catalogue (race with another search or the cron).
  const apiCard: PokemonTCGCard = {
    id: 'sv9-999',
    name: 'Zzzqqqxxx',
    number: '99',
    set: { name: 'Future Set', series: 'Scarlet & Violet', releaseDate: '2026/01/01' },
    images: { small: 's', large: 'l' },
  }
  const res = await searchCards('Yyywwwvvv', dbc, {
    fetchLive: () => Promise.resolve([apiCard]),
    syncMarketPrices: syncNoop,
  })
  assert.equal(res.cards.length, 1)
  assert.equal(res.cards[0].id, 42)
})

// --- Alias matching + game/language filters ---
// The JA printing is seeded per-test (not in the shared beforeEach) so the
// assertions above, which pin exact result sets for the EN-only seed, stay
// byte-identical.
async function seedJaPikachu(): Promise<void> {
  await dbc.insert(schema.cards).values({
    id: 8, name: 'ピカチュウ', aliasName: 'Pikachu', game: 'pokemon', language: 'JA',
    setName: 'テスト', setNumber: '025', externalId: 'tcgdex:ja:TEST-025',
  })
}

test('alias matches: searching the EN species name finds the JA printing', async () => {
  await seedJaPikachu()
  const { cards: found } = await searchCards('Pikachu', dbc, noLiveDeps)
  const names = found.map(c => c.name)
  assert.ok(names.includes('ピカチュウ'))
})

test('set-number search finds CJK rows', async () => {
  await seedJaPikachu()
  const { cards: found } = await searchCards('025', dbc, noLiveDeps)
  assert.ok(found.some(c => c.language === 'JA'))
})

test('language filter narrows results', async () => {
  await seedJaPikachu()
  const ja = await searchCards('Pikachu', dbc, noLiveDeps, { language: 'JA' })
  assert.ok(ja.cards.length > 0)
  assert.ok(ja.cards.every(c => c.language === 'JA'))
  const en = await searchCards('Pikachu', dbc, noLiveDeps, { language: 'EN' })
  assert.ok(en.cards.every(c => c.language === 'EN'))
})

test('fuzzy suggestions score alias names too', async () => {
  await seedJaPikachu()
  const { cards: found, fuzzy } = await searchCards('Pikchu', dbc, noLiveDeps)
  assert.equal(fuzzy, true)
  assert.ok(found.some(c => c.name === 'ピカチュウ'))
})
