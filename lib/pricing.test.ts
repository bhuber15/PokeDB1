import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateSellPrice, calculateBuyPrice, usdToGbp, eurToGbp, formatGBP, parsePounds, computeSaleTotals, VAT_RATE, MARGIN_VAT_DIVISOR, computeMarginVat, pickMarketPrice, pickMarketSource, marketPriceSyncedAt } from './pricing'

test('pickMarketPrice: picks the primary source when present', () => {
  assert.equal(pickMarketPrice({ cardmarketTrend: 850, tcgplayerMarket: 900 }, 'cardmarket'), 850)
  assert.equal(pickMarketPrice({ cardmarketTrend: 850, tcgplayerMarket: 900 }, 'tcgplayer'), 900)
})

test('pickMarketPrice: falls back to the other source when primary is missing', () => {
  assert.equal(pickMarketPrice({ cardmarketTrend: null, tcgplayerMarket: 900 }, 'cardmarket'), 900)
  assert.equal(pickMarketPrice({ cardmarketTrend: 850, tcgplayerMarket: null }, 'tcgplayer'), 850)
})

test('pickMarketPrice: a cached 0 is "no data", not a price — falls back', () => {
  assert.equal(pickMarketPrice({ cardmarketTrend: 0, tcgplayerMarket: 6019 }, 'cardmarket'), 6019)
  assert.equal(pickMarketPrice({ cardmarketTrend: 850, tcgplayerMarket: 0 }, 'tcgplayer'), 850)
})

test('pickMarketPrice: null when both sources are missing or zero', () => {
  assert.equal(pickMarketPrice({ cardmarketTrend: 0, tcgplayerMarket: null }, 'cardmarket'), null)
  assert.equal(pickMarketPrice(null, 'cardmarket'), null)
})

test('calculateSellPrice: override wins over market price', () => {
  assert.equal(calculateSellPrice(10000, 4200, 0.85), 4200)
})

test('calculateSellPrice: applies multiplier and rounds up to the penny', () => {
  assert.equal(calculateSellPrice(1000, null, 0.85), 850)
  assert.equal(calculateSellPrice(1000.1, null, 0.85), 851) // ceil, never round down
})

test('calculateSellPrice: null market with no override is null', () => {
  assert.equal(calculateSellPrice(null, null, 0.85), null)
})

test('calculateBuyPrice: floors to the penny (shop never overpays)', () => {
  assert.equal(calculateBuyPrice(1000, 0.5), 500)
  assert.equal(calculateBuyPrice(999.9, 0.5), 499)
})

test('calculateBuyPrice: null market is null', () => {
  assert.equal(calculateBuyPrice(null, 0.5), null)
})

test('usdToGbp: converts USD pounds-equivalent to GBP pence, rounds to nearest', () => {
  assert.equal(usdToGbp(10, 0.79), 790)
})

test('usdToGbp: null is null', () => {
  assert.equal(usdToGbp(null, 0.79), null)
})

test('eurToGbp: converts EUR pounds-equivalent to GBP pence', () => {
  assert.equal(eurToGbp(10, 0.86), 860)
})

test('formatGBP: formats pence as GBP currency', () => {
  assert.equal(formatGBP(790), '£7.90')
})

test('formatGBP: null/undefined renders an em dash placeholder', () => {
  assert.equal(formatGBP(null), '—')
  assert.equal(formatGBP(undefined), '—')
})

test('parsePounds: converts a pounds string to integer pence', () => {
  assert.equal(parsePounds('7.90'), 790)
  assert.equal(parsePounds('7.9'), 790)
  assert.equal(parsePounds('7'), 700)
})

test('parsePounds: converts a pounds number to integer pence', () => {
  assert.equal(parsePounds(7.9), 790)
})

test('parsePounds: non-numeric input is 0', () => {
  assert.equal(parsePounds(''), 0)
  assert.equal(parsePounds('abc'), 0)
})

test('pickMarketSource: prefers the configured source', () => {
  const prices = { cardmarketTrend: 900, tcgplayerMarket: 1000 }
  assert.equal(pickMarketSource(prices, 'cardmarket'), 'cardmarket')
  assert.equal(pickMarketSource(prices, 'tcgplayer'), 'tcgplayer')
})

test('pickMarketSource: falls back to the other source when the preferred one is missing', () => {
  assert.equal(pickMarketSource({ cardmarketTrend: null, tcgplayerMarket: 1000 }, 'cardmarket'), 'tcgplayer')
  assert.equal(pickMarketSource({ cardmarketTrend: 900, tcgplayerMarket: null }, 'tcgplayer'), 'cardmarket')
})

test('pickMarketSource: null when no source has a price or the row is missing', () => {
  assert.equal(pickMarketSource({ cardmarketTrend: null, tcgplayerMarket: null }, 'cardmarket'), null)
  assert.equal(pickMarketSource(null, 'cardmarket'), null)
  assert.equal(pickMarketSource(undefined, 'tcgplayer'), null)
})

test('pickMarketSource: a cached 0 is "no data" — falls back like a missing price', () => {
  assert.equal(pickMarketSource({ cardmarketTrend: 0, tcgplayerMarket: 6019 }, 'cardmarket'), 'tcgplayer')
  assert.equal(pickMarketSource({ cardmarketTrend: 850, tcgplayerMarket: 0 }, 'tcgplayer'), 'cardmarket')
  assert.equal(pickMarketSource({ cardmarketTrend: 0, tcgplayerMarket: 0 }, 'cardmarket'), null)
})

test('marketPriceSyncedAt: a zeroed CM trend ages by the TCG sweep stamp it fell back to', () => {
  const prices = {
    cardmarketTrend: 0, tcgplayerMarket: 1000,
    cardmarketSyncedAt: '2026-07-22T09:00:00.000Z', lastSyncedAt: '2026-07-05T00:00:00.000Z',
  }
  assert.equal(marketPriceSyncedAt(prices, 'cardmarket'), '2026-07-05T00:00:00.000Z')
})

test('pickMarketPrice: quotes the picked source, with cross-source fallback', () => {
  const prices = { cardmarketTrend: 900, tcgplayerMarket: 1000 }
  assert.equal(pickMarketPrice(prices, 'cardmarket'), 900)
  assert.equal(pickMarketPrice(prices, 'tcgplayer'), 1000)
  assert.equal(pickMarketPrice({ cardmarketTrend: null, tcgplayerMarket: 1000 }, 'cardmarket'), 1000)
  assert.equal(pickMarketPrice({ cardmarketTrend: null, tcgplayerMarket: null }, 'cardmarket'), null)
  assert.equal(pickMarketPrice(null, 'cardmarket'), null)
})

// The POS staleness badge derives its age from marketPriceSyncedAt — it must
// follow the source the sell price is quoted from, so an on-demand Cardmarket
// refresh (which bumps only cardmarketSyncedAt) clears the badge for a
// CM-quoted price, and leaves it for a TCG-quoted one.
test('marketPriceSyncedAt: CM-quoted price reads cardmarketSyncedAt', () => {
  const prices = {
    cardmarketTrend: 900, tcgplayerMarket: 1000,
    cardmarketSyncedAt: '2026-07-22T09:00:00.000Z', lastSyncedAt: '2026-07-05T00:00:00.000Z',
  }
  assert.equal(marketPriceSyncedAt(prices, 'cardmarket'), '2026-07-22T09:00:00.000Z')
})

test('marketPriceSyncedAt: TCG-quoted price reads lastSyncedAt even when the CM stamp is fresher', () => {
  const prices = {
    cardmarketTrend: 900, tcgplayerMarket: 1000,
    cardmarketSyncedAt: '2026-07-22T09:00:00.000Z', lastSyncedAt: '2026-07-05T00:00:00.000Z',
  }
  assert.equal(marketPriceSyncedAt(prices, 'tcgplayer'), '2026-07-05T00:00:00.000Z')
})

test('marketPriceSyncedAt: follows the fallback source when the preferred one has no price', () => {
  const prices = {
    cardmarketTrend: null, tcgplayerMarket: 1000,
    cardmarketSyncedAt: '2026-07-22T09:00:00.000Z', lastSyncedAt: '2026-07-05T00:00:00.000Z',
  }
  // CM-primary shop quoting the TCG fallback: the TCG sweep stamp is the honest age
  assert.equal(marketPriceSyncedAt(prices, 'cardmarket'), '2026-07-05T00:00:00.000Z')
})

test('marketPriceSyncedAt: CM row without its own stamp falls back to lastSyncedAt', () => {
  const prices = {
    cardmarketTrend: 900, tcgplayerMarket: null,
    cardmarketSyncedAt: null, lastSyncedAt: '2026-07-05T00:00:00.000Z',
  }
  assert.equal(marketPriceSyncedAt(prices, 'cardmarket'), '2026-07-05T00:00:00.000Z')
})

test('marketPriceSyncedAt: null when nothing is quotable', () => {
  assert.equal(marketPriceSyncedAt({ cardmarketTrend: null, tcgplayerMarket: null }, 'cardmarket'), null)
  assert.equal(marketPriceSyncedAt(null, 'cardmarket'), null)
})

test('computeSaleTotals: no VAT scheme passes amounts through', () => {
  assert.deepEqual(computeSaleTotals(1700, 0, 'none'), { discount: 0, vatAmount: 0, total: 1700 })
  assert.deepEqual(computeSaleTotals(1700, 200, 'none'), { discount: 200, vatAmount: 0, total: 1500 })
})

test('computeSaleTotals: standard VAT is 20% of the discounted amount', () => {
  assert.deepEqual(computeSaleTotals(1000, 0, 'standard'), { discount: 0, vatAmount: 200, total: 1200 })
  assert.deepEqual(computeSaleTotals(1000, 100, 'standard'), { discount: 100, vatAmount: 180, total: 1080 })
  // odd pence rounds to nearest
  assert.deepEqual(computeSaleTotals(999, 0, 'standard'), { discount: 0, vatAmount: 200, total: 1199 })
})

test('computeSaleTotals: discount clamps to [0, subtotal]', () => {
  assert.deepEqual(computeSaleTotals(500, 900, 'none'), { discount: 500, vatAmount: 0, total: 0 })
  assert.deepEqual(computeSaleTotals(500, -100, 'none'), { discount: 0, vatAmount: 0, total: 500 })
})

test('computeSaleTotals: margin scheme behaves like none for the customer total (VAT-inclusive)', () => {
  assert.deepEqual(computeSaleTotals(1700, 0, 'margin'), { discount: 0, vatAmount: 0, total: 1700 })
  assert.deepEqual(computeSaleTotals(1700, 200, 'margin'), { discount: 200, vatAmount: 0, total: 1500 })
})

test('VAT_RATE and MARGIN_VAT_DIVISOR are the single source of the rate', () => {
  assert.equal(VAT_RATE, 0.2)
  assert.equal(MARGIN_VAT_DIVISOR, 6)
})

test('computeMarginVat: single line, VAT is round(margin / 6)', () => {
  // sell 1000, cost 400 → margin 600 → round(600/6) = 100
  assert.deepEqual(
    computeMarginVat([{ unitPrice: 1000, quantity: 1, costAtSale: 400 }], 0),
    { vatAmount: 100, noCostLineCount: 0 },
  )
})

test('computeMarginVat: quantity multiplies the line, margin floored at 0 per line', () => {
  // 2 × sell 500 = 1000, cost 2 × 300 = 600 → margin 400 → round(400/6) = 67
  assert.deepEqual(
    computeMarginVat([{ unitPrice: 500, quantity: 2, costAtSale: 300 }], 0),
    { vatAmount: 67, noCostLineCount: 0 },
  )
  // sold at a loss → margin max(0, 500-800) = 0 → no VAT
  assert.deepEqual(
    computeMarginVat([{ unitPrice: 500, quantity: 1, costAtSale: 800 }], 0),
    { vatAmount: 0, noCostLineCount: 0 },
  )
})

test('computeMarginVat: no-cost line contributes 0 and is counted', () => {
  assert.deepEqual(
    computeMarginVat([
      { unitPrice: 1000, quantity: 1, costAtSale: 400 }, // margin 600 → 100
      { unitPrice: 900, quantity: 1, costAtSale: null },  // excluded, counted
    ], 0),
    { vatAmount: 100, noCostLineCount: 1 },
  )
})

test('computeMarginVat: discount is spread across lines by value, reducing the margin', () => {
  // Lines value 1000 and 500 (subtotal 1500), discount 300 →
  // alloc 200 and 100 → effective 800 and 400.
  // costs 400 and 200 → margins 400 and 200 → round(400/6)=67, round(200/6)=33 → 100
  assert.deepEqual(
    computeMarginVat([
      { unitPrice: 1000, quantity: 1, costAtSale: 400 },
      { unitPrice: 500, quantity: 1, costAtSale: 200 },
    ], 300),
    { vatAmount: 100, noCostLineCount: 0 },
  )
})

test('computeMarginVat: discount allocation sums exactly (largest-remainder)', () => {
  // Three equal lines value 100 each (subtotal 300), discount 100.
  // Allocations must sum to 100 exactly. costs 0 → margins are (100 - alloc_i).
  // Total effective margin = 300 - 100 = 200 spread as 66/67/67 across lines,
  // each VAT = round(m/6). Assert the total is stable regardless of tie-order.
  const { vatAmount, noCostLineCount } = computeMarginVat([
    { unitPrice: 100, quantity: 1, costAtSale: 0 },
    { unitPrice: 100, quantity: 1, costAtSale: 0 },
    { unitPrice: 100, quantity: 1, costAtSale: 0 },
  ], 100)
  // effective margins 66,67,67 → round(66/6)=11, round(67/6)=11, round(67/6)=11 → 33
  assert.equal(vatAmount, 33)
  assert.equal(noCostLineCount, 0)
})

test('computeMarginVat: discount clamped to [0, subtotal]', () => {
  // Over-large discount wipes the margin to 0.
  assert.deepEqual(
    computeMarginVat([{ unitPrice: 1000, quantity: 1, costAtSale: 400 }], 99999),
    { vatAmount: 0, noCostLineCount: 0 },
  )
})

test('computeMarginVat: standardRated line owes inclusive VAT on full effective value', () => {
  // product £6.00 (cost irrelevant), no discount → VAT = round(600/6) = 100
  const { vatAmount, noCostLineCount } = computeMarginVat(
    [{ unitPrice: 600, quantity: 1, costAtSale: 250, standardRated: true }], 0)
  assert.equal(vatAmount, 100)
  assert.equal(noCostLineCount, 0)
})

test('computeMarginVat: standardRated line with null cost is NOT a no-cost line', () => {
  const { vatAmount, noCostLineCount } = computeMarginVat(
    [{ unitPrice: 600, quantity: 1, costAtSale: null, standardRated: true }], 0)
  assert.equal(vatAmount, 100)
  assert.equal(noCostLineCount, 0)
})

test('computeMarginVat: mixed margin + standardRated lines share the discount allocation', () => {
  // card 850 (cost 300) + product 600, discount 145 → allocations 85/60
  // card: margin (850-85) - 300 = 465 → VAT 78 ; product: (600-60)/6 = 90
  const { vatAmount } = computeMarginVat([
    { unitPrice: 850, quantity: 1, costAtSale: 300 },
    { unitPrice: 600, quantity: 1, costAtSale: 250, standardRated: true },
  ], 145)
  assert.equal(vatAmount, 78 + 90)
})
