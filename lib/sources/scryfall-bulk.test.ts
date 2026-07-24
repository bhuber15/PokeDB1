import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { importScryfallBulk } from '@/lib/sources/scryfall-bulk'
import type { ScryfallCard } from '@/lib/apis/scryfall'

const objs: ScryfallCard[] = [
  { id: 'x', name: 'X', lang: 'en', set: 's', set_name: 'S', collector_number: '1', finishes: ['nonfoil'], games: ['paper'], prices: { usd: '1', eur: '1' } },
  { id: 'y', name: 'Y', lang: 'en', set: 's', set_name: 'S', collector_number: '2', finishes: ['nonfoil', 'foil'], games: ['paper'], prices: { usd: '1', usd_foil: '2', eur: '1', eur_foil: '2' } },
]
const settings = { ...DEFAULT_SETTINGS, enabledGames: ['pokemon' as const, 'mtg' as const] }

test('streams bulk objects into rows (foil printing splits into two)', async () => {
  const db = await createTestDb()
  const r = await importScryfallBulk(settings, db, { stream: async function* () { yield* objs } })
  assert.equal(r.newCards, 3) // x + y(nonfoil) + y(foil)
  assert.equal((await db.select().from(cards).where(eq(cards.game, 'mtg'))).length, 3)
})

test('no-op when mtg is not enabled', async () => {
  const db = await createTestDb()
  const r = await importScryfallBulk({ ...settings, enabledGames: ['pokemon'] }, db, { stream: async function* () { yield* objs } })
  assert.equal(r.cardsSeen, 0)
})
