import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateSellPrice, calculateBuyPrice, usdToGbp, formatGBP } from './pricing'

test('calculateSellPrice: override wins over market price', () => {
  assert.equal(calculateSellPrice(100, 42, 0.85), 42)
})

test('calculateSellPrice: applies multiplier and rounds up to the penny', () => {
  assert.equal(calculateSellPrice(10, null, 0.85), 8.5)
  assert.equal(calculateSellPrice(10.001, null, 0.85), 8.51) // ceil, never round down (shop never undercharges)
})

test('calculateSellPrice: null market with no override is null', () => {
  assert.equal(calculateSellPrice(null, null, 0.85), null)
})

test('calculateBuyPrice: floors to the penny (shop never overpays)', () => {
  assert.equal(calculateBuyPrice(10, 0.5), 5)
  assert.equal(calculateBuyPrice(9.999, 0.5), 4.99)
})

test('calculateBuyPrice: null market is null', () => {
  assert.equal(calculateBuyPrice(null, 0.5), null)
})

test('usdToGbp: converts and rounds to the penny', () => {
  assert.equal(usdToGbp(10, 0.79), 7.9)
})

test('usdToGbp: null is null', () => {
  assert.equal(usdToGbp(null, 0.79), null)
})

test('formatGBP: formats as GBP currency', () => {
  assert.equal(formatGBP(7.9), '£7.90')
})

test('formatGBP: null/undefined renders an em dash placeholder', () => {
  assert.equal(formatGBP(null), '—')
  assert.equal(formatGBP(undefined), '—')
})
