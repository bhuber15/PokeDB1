import { test } from 'node:test'
import assert from 'node:assert/strict'
import { londonDayOfUtc, isSameLondonDay } from './trading-day'

test('londonDayOfUtc rolls a late BST evening into the next London day', () => {
  // 23:30 UTC in July = 00:30 BST the following day
  assert.equal(londonDayOfUtc('2026-06-30 23:30:00'), '2026-07-01')
})

test('londonDayOfUtc matches the UTC day in winter (GMT)', () => {
  assert.equal(londonDayOfUtc('2026-01-15 23:30:00'), '2026-01-15')
})

test('isSameLondonDay: BST sale rung 00:30 local is same-day for the rest of that day', () => {
  // Sale at 2026-06-30 23:30 UTC = 2026-07-01 00:30 London; "now" is noon that London day
  assert.equal(isSameLondonDay('2026-06-30 23:30:00', new Date('2026-07-01T11:00:00Z')), true)
})

test('isSameLondonDay: previous London day rejected even when UTC days match', () => {
  // Sale at 22:30 UTC = 23:30 London 30 Jun; "now" 23:30 UTC = 00:30 London 1 Jul
  assert.equal(isSameLondonDay('2026-06-30 22:30:00', new Date('2026-06-30T23:30:00Z')), false)
})
