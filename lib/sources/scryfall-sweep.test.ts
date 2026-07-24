import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards, catalogueSyncState } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { sweepScryfall } from '@/lib/sources/scryfall-sweep'
import type { ScryfallCard } from '@/lib/apis/scryfall'

const card = (id: string): ScryfallCard => ({
  id, name: `Card ${id}`, lang: 'en', set: 'tst', set_name: 'Test', collector_number: id,
  rarity: 'common', finishes: ['nonfoil'], games: ['paper'], image_uris: { small: 's', large: 'l' },
  prices: { usd: '1.00', eur: '0.90' },
})
// three pages of one card each; page 4 empty
const pages: Record<number, { cards: ScryfallCard[]; hasMore: boolean }> = {
  1: { cards: [card('a')], hasMore: true },
  2: { cards: [card('b')], hasMore: true },
  3: { cards: [card('c')], hasMore: false },
}
const deps = { fetchPage: async (p: number) => pages[p] ?? { cards: [], hasMore: false } }
const settings = { ...DEFAULT_SETTINGS, enabledGames: ['pokemon' as const, 'mtg' as const] }

test('a budgeted run imports up to `maxPages` and persists the next-page cursor', async () => {
  const db = await createTestDb()
  const r = await sweepScryfall(settings, db, { maxPages: 2 }, deps)
  assert.equal(r.newCards, 2) // pages 1-2
  const [state] = await db.select().from(catalogueSyncState).where(eq(catalogueSyncState.game, 'mtg'))
  assert.equal(state.cursor, '3') // resume here next run
})

test('resuming from the cursor finishes the catalogue and wraps to page 1', async () => {
  const db = await createTestDb()
  await sweepScryfall(settings, db, { maxPages: 2 }, deps) // cursor → 3
  const r = await sweepScryfall(settings, db, { maxPages: 2 }, deps) // page 3, then end
  assert.equal(r.newCards, 1) // page 3 (a,b already known)
  const [state] = await db.select().from(catalogueSyncState).where(eq(catalogueSyncState.game, 'mtg'))
  assert.equal(state.cursor, '1') // wrapped for the next cycle
  assert.equal((await db.select().from(cards).where(eq(cards.game, 'mtg'))).length, 3)
})

test('does nothing when mtg is not enabled', async () => {
  const db = await createTestDb()
  const r = await sweepScryfall({ ...settings, enabledGames: ['pokemon'] }, db, { maxPages: 5 }, deps)
  assert.equal(r.cardsSeen, 0)
})
