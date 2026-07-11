import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateSellPrice, calculateBuyPrice, usdToGbp, eurToGbp, formatGBP, parsePounds, computeSaleTotals, VAT_RATE, MARGIN_VAT_DIVISOR } from './pricing'

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
