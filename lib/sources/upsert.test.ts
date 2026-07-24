import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards, priceCache } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { upsertNormalizedCards, writePriceForExternalId, type SweepResult } from '@/lib/sources/upsert'
import type { NormalizedCard } from '@/lib/sources/types'

const settings = { ...DEFAULT_SETTINGS, usdToGbp: 0.8, eurToGbp: 0.85, highValueThreshold: 5000 }
const row: NormalizedCard = {
  game: 'mtg', language: 'EN', name: 'Lightning Bolt', setName: 'Double Masters 2022', setNumber: '117',
  variant: 'Foil', series: '2x2', externalId: 'scryfall:bolt:foil', imageUrl: 's.jpg', imageUrlLarge: 'l.jpg',
  prices: { tcgplayerUsd: 2.13, cardmarketEur: 2.04 },
}
const fresh = (): SweepResult => ({ cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 })

test('inserts a card row and its prices converted to GBP pence', async () => {
  const db = await createTestDb()
  const result = fresh()
  await upsertNormalizedCards(db, [row], settings, result)
  assert.equal(result.newCards, 1)
  const [c] = await db.select().from(cards).where(eq(cards.externalId, 'scryfall:bolt:foil'))
  assert.equal(c.game, 'mtg'); assert.equal(c.variant, 'Foil'); assert.equal(c.setNumber, '117')
  const [p] = await db.select().from(priceCache).where(eq(priceCache.cardId, c.id))
  assert.equal(p.tcgplayerMarket, Math.round(2.13 * 0.8 * 100))
  assert.equal(p.cardmarketTrend, Math.round(2.04 * 0.85 * 100))
})

test('re-upsert heals identity + refreshes price without duplicating rows', async () => {
  const db = await createTestDb()
  await upsertNormalizedCards(db, [row], settings, fresh())
  const second = fresh()
  await upsertNormalizedCards(db, [{ ...row, name: 'Lightning Bolt (errata)', prices: { tcgplayerUsd: 9, cardmarketEur: null } }], settings, second)
  assert.equal(second.newCards, 0)
  const all = await db.select().from(cards).where(eq(cards.externalId, 'scryfall:bolt:foil'))
  assert.equal(all.length, 1)
  assert.equal(all[0].name, 'Lightning Bolt (errata)')
  const [p] = await db.select().from(priceCache).where(eq(priceCache.cardId, all[0].id))
  assert.equal(p.tcgplayerMarket, Math.round(9 * 0.8 * 100))
})

test('deduplicates rows sharing an external id within one batch (SQLite conflict guard)', async () => {
  const db = await createTestDb()
  const result = fresh()
  // two rows, same externalId — the real YGOPRODeck duplicate-printing case
  await upsertNormalizedCards(db, [row, { ...row, name: 'dupe' }], settings, result)
  const all = await db.select().from(cards).where(eq(cards.externalId, 'scryfall:bolt:foil'))
  assert.equal(all.length, 1) // did not throw; single row, last wins
  assert.equal(all[0].name, 'dupe')
  assert.equal(result.newCards, 1)
})

test('writePriceForExternalId updates only prices + freshness, not identity', async () => {
  const db = await createTestDb()
  await upsertNormalizedCards(db, [row], settings, fresh()) // creates scryfall:bolt:foil
  await writePriceForExternalId(db, 'scryfall:bolt:foil', { tcgplayerUsd: 5, cardmarketEur: null }, { usd: 0.8, eur: 0.85 })
  const [c] = await db.select().from(cards).where(eq(cards.externalId, 'scryfall:bolt:foil'))
  assert.equal(c.name, 'Lightning Bolt') // identity untouched
  const [p] = await db.select().from(priceCache).where(eq(priceCache.cardId, c.id))
  assert.equal(p.tcgplayerMarket, Math.round(5 * 0.8 * 100))
  assert.ok(p.cardmarketSyncedAt) // stamped
})
