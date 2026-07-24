import test from 'node:test'
import assert from 'node:assert/strict'
import { getCatalogueSource } from '@/lib/sources/registry'

test('mtg and yugioh resolve to a catalogue source; pokemon is intentionally absent (own sync path)', () => {
  // Pokémon keeps its existing sweep/sync path (lib/prices/*) and is deliberately
  // NOT registered here — callers must fall back to the Pokémon-specific machinery.
  assert.equal(getCatalogueSource('pokemon'), undefined)
  assert.equal(getCatalogueSource('mtg')?.game, 'mtg')
  assert.equal(getCatalogueSource('yugioh')?.game, 'yugioh')
})

test('mtg and yugioh sources expose a per-card refresh; all expose a sweep', () => {
  assert.equal(typeof getCatalogueSource('mtg')?.sweep, 'function')
  assert.equal(typeof getCatalogueSource('mtg')?.refreshPrices, 'function')
  assert.equal(typeof getCatalogueSource('yugioh')?.refreshPrices, 'function')
})
