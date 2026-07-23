import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { sweepTcgdexCatalogue } from '@/lib/prices/tcgdex-sweep'
import type { TcgdexSetBrief, TcgdexSetDetail } from '@/lib/apis/tcgdex'

const jaSets: TcgdexSetBrief[] = [{ id: 'SV4a', name: 'レイジングサーフ', cardCount: { total: 2, official: 2 } }]
const jaSetDetail: TcgdexSetDetail = {
  id: 'SV4a', name: 'レイジングサーフ', serie: { id: 'SV', name: 'スカーレット&バイオレット' },
  cards: [
    { id: 'SV4a-006', localId: '006', name: 'ポポッコ', image: 'https://assets.tcgdex.net/ja/SV/SV4a/006' },
    { id: 'SV4a-205', localId: '205', name: 'オリーヴァ' },
  ],
}
const deps = {
  fetchSets: async (lang: string) => (lang === 'ja' ? jaSets : []),
  fetchSet: async (_lang: string, id: string) => (id === 'SV4a' ? jaSetDetail : null),
}
const settings = { ...DEFAULT_SETTINGS, enabledLanguages: ['EN' as const, 'JA' as const] }

test('imports enabled CJK languages only, with qualified ids and localized fields', async () => {
  const db = await createTestDb()
  const r = await sweepTcgdexCatalogue(settings, db, deps)
  assert.equal(r.setsImported, 1)
  assert.equal(r.newCards, 2)

  const [row] = await db.select().from(cards).where(eq(cards.externalId, 'tcgdex:ja:SV4a-006'))
  assert.equal(row.name, 'ポポッコ')
  assert.equal(row.game, 'pokemon')
  assert.equal(row.language, 'JA')
  assert.equal(row.setName, 'レイジングサーフ')
  assert.equal(row.setNumber, '006')
  assert.equal(row.series, 'スカーレット&バイオレット')
  assert.equal(row.imageUrl, 'https://assets.tcgdex.net/ja/SV/SV4a/006/low.webp')
  assert.equal(row.imageUrlLarge, 'https://assets.tcgdex.net/ja/SV/SV4a/006/high.webp')
  assert.equal(row.aliasName, null) // filled later by the per-card price fetch
})

test('idempotent: complete sets are skipped on the second run', async () => {
  const db = await createTestDb()
  await sweepTcgdexCatalogue(settings, db, deps)
  const again = await sweepTcgdexCatalogue(settings, db, deps)
  assert.equal(again.setsImported, 0)
  assert.equal(again.newCards, 0)
  const all = await db.select().from(cards)
  assert.equal(all.filter(c => c.language === 'JA').length, 2)
})

test('EN-only settings sweep nothing', async () => {
  const db = await createTestDb()
  const r = await sweepTcgdexCatalogue({ ...settings, enabledLanguages: ['EN'] }, db, deps)
  assert.equal(r.setsChecked, 0)
})

test('a failing set is counted and does not abort the sweep', async () => {
  const db = await createTestDb()
  const r = await sweepTcgdexCatalogue(settings, db, {
    ...deps,
    fetchSet: async () => { throw new Error('boom') },
  })
  assert.equal(r.setsFailed, 1)
  assert.equal(r.newCards, 0)
})
