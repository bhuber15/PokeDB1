import test from 'node:test'
import assert from 'node:assert/strict'
import { extractGbpRates, FrankfurterError } from '@/lib/apis/frankfurter'

// Recorded live response shape, 2026-08 (https://api.frankfurter.dev/v1/latest?base=GBP&symbols=USD,EUR)
const RECORDED = { amount: 1, base: 'GBP', date: '2026-08-26', rates: { EUR: 1.1552, USD: 1.2704 } }

test('inverts the GBP-based quote to pounds-per-unit at 4 dp', () => {
  const { usd, eur } = extractGbpRates(RECORDED)
  assert.equal(usd, 0.7872) // 1 / 1.2704
  assert.equal(eur, 0.8657) // 1 / 1.1552
})

test('a missing, zero or non-numeric rate is an error, never a rate', () => {
  assert.throws(() => extractGbpRates({ rates: { EUR: 1.15 } }), FrankfurterError) // USD absent
  assert.throws(() => extractGbpRates({ rates: { EUR: 0, USD: 1.27 } }), FrankfurterError)
  assert.throws(() => extractGbpRates({ rates: { EUR: '1.15' as unknown as number, USD: 1.27 } }), FrankfurterError)
  assert.throws(() => extractGbpRates(null), FrankfurterError)
})

test('an implausible inverted rate is rejected — an un-inverted quote must never become the rate', () => {
  // If the feed ever quoted pounds-per-dollar directly (0.79), inverting it
  // would yield 1.27 £/$ — outside the band, so it is refused rather than
  // silently repricing the whole catalogue ~60% high.
  assert.throws(() => extractGbpRates({ rates: { EUR: 0.87, USD: 0.79 } }), FrankfurterError)
})
