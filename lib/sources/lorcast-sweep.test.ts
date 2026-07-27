import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { sweepLorcast } from '@/lib/sources/lorcast-sweep'
import type { LorcastCard, LorcastSet } from '@/lib/apis/lorcast'

const sets: LorcastSet[] = [
  { id: 'set_a', code: '9', name: 'Fabled' },
  { id: 'set_b', code: 'P1', name: 'Promo Set 1' },
]
const bySet: Record<string, LorcastCard[]> = {
  '9': [{
    id: 'crd_elsa', name: 'Elsa', version: 'Spirit of Winter', rarity: 'Legendary',
    collector_number: '43', lang: 'en', set: { code: '9', name: 'Fabled' },
    prices: { usd: '1.89', usd_foil: '9.79' }, // per-set endpoint quotes strings
  }],
  P1: [{
    id: 'crd_dalmatian', name: 'Pongo', version: 'Determined Father', rarity: 'Promo',
    collector_number: '2', lang: 'en', set: { code: 'P1', name: 'Promo Set 1' },
    prices: { usd_foil: '12.00' },
  }],
}
const settings = { ...DEFAULT_SETTINGS, enabledGames: ['pokemon' as const, 'lorcana' as const] }
const deps = { fetchSets: async () => sets, fetchSetCards: async (code: string) => bySet[code] ?? [], gateMs: 0 }

test('sweeps every set: per-finish rows land with the game tag', async () => {
  const db = await createTestDb()
  const r = await sweepLorcast(settings, db, deps)
  assert.equal(r.newCards, 3) // Elsa base + foil, promo foil-only
  assert.equal(r.failed, 0)
  const rows = await db.select().from(cards).where(eq(cards.game, 'lorcana'))
  assert.deepEqual(rows.map(c => c.externalId).sort(),
    ['lorcast:crd_dalmatian:foil', 'lorcast:crd_elsa', 'lorcast:crd_elsa:foil'])
})

test('does nothing when lorcana is not enabled', async () => {
  const db = await createTestDb()
  const r = await sweepLorcast({ ...settings, enabledGames: ['pokemon'] }, db, deps)
  assert.equal(r.cardsSeen, 0)
})

test('one failing set is isolated: the rest still land', async () => {
  const db = await createTestDb()
  const r = await sweepLorcast(settings, db, {
    ...deps,
    fetchSetCards: async (code: string) => {
      if (code === '9') throw new Error('boom')
      return bySet[code] ?? []
    },
  })
  assert.equal(r.failed, 1)
  assert.equal(r.newCards, 1) // the promo set still imported
})
