import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateSellPrice, calculateBuyPrice, usdToGbp, eurToGbp, formatGBP, parsePounds } from './pricing'

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
