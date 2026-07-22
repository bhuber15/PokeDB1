import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTcgdexPricing } from '@/lib/apis/tcgdex'

test('null pricing blocks (JP-exclusive sets) → dexId kept, no prices', () => {
  const r = extractTcgdexPricing({ dexId: [930], pricing: { cardmarket: null, tcgplayer: null } }, null)
  assert.deepEqual(r, { dexId: [930], cardmarket: null, tcgplayer: null })
})

test('cardmarket block: zeros are no-data; holo variant prefers -holo keys', () => {
  const data = {
    pricing: { cardmarket: { trend: 0, low: 2.5, avg: 3, 'trend-holo': 9, 'low-holo': 8, 'avg-holo': 8.5 } },
  }
  const base = extractTcgdexPricing(data, null)
  assert.deepEqual(base.cardmarket, { trend: null, low: 2.5, avg: 3 })
  const holo = extractTcgdexPricing(data, 'Holofoil')
  assert.deepEqual(holo.cardmarket, { trend: 9, low: 8, avg: 8.5 })
})

test('tcgplayer block: variant-keyed, holofoil preferred, USD fields mapped', () => {
  const r = extractTcgdexPricing({
    pricing: {
      tcgplayer: {
        unit: 'USD',
        normal: { marketPrice: 1, lowPrice: 0.5, midPrice: 1.2, highPrice: 3 },
        holofoil: { marketPrice: 28.62, lowPrice: 25.08, midPrice: 32.91, highPrice: 59.99 },
      },
    },
  }, null)
  assert.deepEqual(r.tcgplayer, { market: 28.62, low: 25.08, mid: 32.91, high: 59.99 })
})

test('missing pricing key entirely → both blocks null', () => {
  assert.deepEqual(extractTcgdexPricing({}, null), { dexId: null, cardmarket: null, tcgplayer: null })
})
