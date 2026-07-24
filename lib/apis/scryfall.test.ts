import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeScryfallCard, type ScryfallCard } from '@/lib/apis/scryfall'

const bolt: ScryfallCard = {
  id: 'bolt-uuid', name: 'Lightning Bolt', lang: 'en', set: '2x2', set_name: 'Double Masters 2022',
  collector_number: '117', rarity: 'uncommon', finishes: ['nonfoil', 'foil'], games: ['paper', 'mtgo'],
  image_uris: { small: 'small.jpg', normal: 'normal.jpg', large: 'large.jpg' },
  prices: { usd: '2.49', usd_foil: '2.13', usd_etched: null, eur: '1.83', eur_foil: '2.04', tix: '1.61' },
}

test('a both-finishes printing yields two rows with per-finish prices and ids', () => {
  const rows = normalizeScryfallCard(bolt)
  assert.equal(rows.length, 2)
  const nonfoil = rows.find(r => r.variant === '')!
  const foil = rows.find(r => r.variant === 'Foil')!
  assert.equal(nonfoil.externalId, 'scryfall:bolt-uuid')
  assert.equal(nonfoil.prices.tcgplayerUsd, 2.49)
  assert.equal(nonfoil.prices.cardmarketEur, 1.83)
  assert.equal(foil.externalId, 'scryfall:bolt-uuid:foil')
  assert.equal(foil.prices.tcgplayerUsd, 2.13)
  assert.equal(foil.prices.cardmarketEur, 2.04)
  assert.equal(nonfoil.game, 'mtg')
  assert.equal(nonfoil.language, 'EN')
  assert.equal(nonfoil.setName, 'Double Masters 2022')
  assert.equal(nonfoil.setNumber, '117')
  assert.equal(nonfoil.series, '2x2')
  assert.equal(nonfoil.imageUrl, 'small.jpg')
  assert.equal(nonfoil.imageUrlLarge, 'large.jpg')
})

test('digital-only cards (no paper) are dropped', () => {
  assert.deepEqual(normalizeScryfallCard({ ...bolt, games: ['mtgo', 'arena'] }), [])
})

test('non-English printings are dropped — the bulk file includes them; phase 2 is EN-only', () => {
  assert.deepEqual(normalizeScryfallCard({ ...bolt, lang: 'ja' }), [])
})

test('null/zero prices become null, not 0', () => {
  const rows = normalizeScryfallCard({ ...bolt, finishes: ['nonfoil'], prices: { usd: null, eur: '0.00' } as ScryfallCard['prices'] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].prices.tcgplayerUsd, null)
  assert.equal(rows[0].prices.cardmarketEur, null)
})

test('etched finish maps usd_etched and leaves cardmarket null (no eur_etched upstream)', () => {
  const rows = normalizeScryfallCard({ ...bolt, finishes: ['etched'], prices: { usd_etched: '9.99' } as ScryfallCard['prices'] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].variant, 'Etched')
  assert.equal(rows[0].externalId, 'scryfall:bolt-uuid:etched')
  assert.equal(rows[0].prices.tcgplayerUsd, 9.99)
  assert.equal(rows[0].prices.cardmarketEur, null)
})

test('card_faces image is used when top-level image_uris is absent (DFCs)', () => {
  const dfc = { ...bolt, image_uris: undefined, finishes: ['nonfoil'] as const,
    card_faces: [{ image_uris: { small: 'face-small.jpg', large: 'face-large.jpg' } }] }
  const [row] = normalizeScryfallCard(dfc as unknown as ScryfallCard)
  assert.equal(row.imageUrl, 'face-small.jpg')
})
