import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLorcastCard, type LorcastCard } from '@/lib/apis/lorcast'

// Trimmed from a live /cards/search response (2026-07-27): numeric prices,
// both finishes present.
const fabledElsa: LorcastCard = {
  id: 'crd_096f0a6be34a4134aaa682c768cceeec',
  name: 'Elsa', version: 'Spirit of Winter', rarity: 'Legendary',
  collector_number: '43', lang: 'en',
  set: { code: '9', name: 'Fabled' },
  image_uris: { digital: { small: 'elsa-s.avif', normal: 'elsa-n.avif', large: 'elsa-l.avif' } },
  prices: { usd: 1.89, usd_foil: 9.79 },
}

test('a both-finishes card becomes two rows with per-finish prices', () => {
  const rows = normalizeLorcastCard(fabledElsa)
  assert.equal(rows.length, 2)
  const base = rows.find(r => r.variant === '')!
  assert.equal(base.game, 'lorcana')
  assert.equal(base.language, 'EN')
  assert.equal(base.name, 'Elsa - Spirit of Winter')
  assert.equal(base.setName, 'Fabled')
  assert.equal(base.setNumber, '43')
  assert.equal(base.series, '9')
  assert.equal(base.externalId, 'lorcast:crd_096f0a6be34a4134aaa682c768cceeec')
  assert.equal(base.prices.tcgplayerUsd, 1.89)
  assert.equal(base.prices.cardmarketEur, null) // no honest EUR source
  assert.equal(base.imageUrl, 'elsa-s.avif')
  assert.equal(base.imageUrlLarge, 'elsa-l.avif')
  const foil = rows.find(r => r.variant === 'Foil')!
  assert.equal(foil.externalId, 'lorcast:crd_096f0a6be34a4134aaa682c768cceeec:foil')
  assert.equal(foil.prices.tcgplayerUsd, 9.79)
})

test('string prices (the /sets/:code/cards shape) parse like numbers', () => {
  const rows = normalizeLorcastCard({ ...fabledElsa, prices: { usd: '1.89', usd_foil: '262.76' } })
  assert.equal(rows.find(r => r.variant === '')!.prices.tcgplayerUsd, 1.89)
  assert.equal(rows.find(r => r.variant === 'Foil')!.prices.tcgplayerUsd, 262.76)
})

test('an Enchanted with only usd_foil is a single Foil row (foil-only printing)', () => {
  const rows = normalizeLorcastCard({ ...fabledElsa, rarity: 'Enchanted', collector_number: '207', prices: { usd_foil: 917.34 } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].variant, 'Foil')
  assert.equal(rows[0].prices.tcgplayerUsd, 917.34)
})

test('no price keys at all: special tiers fall back to Foil-only, others to both rows', () => {
  const enchanted = normalizeLorcastCard({ ...fabledElsa, rarity: 'Epic', prices: {} })
  assert.deepEqual(enchanted.map(r => r.variant), ['Foil'])
  const promo = normalizeLorcastCard({ ...fabledElsa, rarity: 'Promo', prices: {} })
  assert.deepEqual(promo.map(r => r.variant).sort(), ['', 'Foil'])
  assert.equal(promo[0].prices.tcgplayerUsd, null) // no-price workflow, not 0
})

test('a present key with a null/zero value keeps the row but prices it null', () => {
  const rows = normalizeLorcastCard({ ...fabledElsa, prices: { usd: '0.00', usd_foil: null } })
  assert.equal(rows.length, 2)
  assert.equal(rows.find(r => r.variant === '')!.prices.tcgplayerUsd, null)
  assert.equal(rows.find(r => r.variant === 'Foil')!.prices.tcgplayerUsd, null)
})

test('non-EN rows are dropped (defensive: EN-only phase)', () => {
  assert.deepEqual(normalizeLorcastCard({ ...fabledElsa, lang: 'fr' }), [])
})

test('version-less cards (actions/songs/items) keep the bare name', () => {
  const rows = normalizeLorcastCard({ ...fabledElsa, name: 'Let It Go', version: null })
  assert.equal(rows[0].name, 'Let It Go')
})
