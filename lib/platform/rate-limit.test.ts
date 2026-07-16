import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { rateLimit, resetRateLimits } from './rate-limit'

beforeEach(() => resetRateLimits())

test('allows up to the limit inside a window, then blocks', () => {
  const t0 = 1_000_000
  assert.ok(rateLimit('ip:1', 3, 60_000, t0))
  assert.ok(rateLimit('ip:1', 3, 60_000, t0 + 1))
  assert.ok(rateLimit('ip:1', 3, 60_000, t0 + 2))
  assert.ok(!rateLimit('ip:1', 3, 60_000, t0 + 3))
})

test('window expiry resets the count; keys are independent', () => {
  const t0 = 1_000_000
  assert.ok(rateLimit('ip:2', 1, 60_000, t0))
  assert.ok(!rateLimit('ip:2', 1, 60_000, t0 + 59_999))
  assert.ok(rateLimit('ip:2', 1, 60_000, t0 + 60_000))
  assert.ok(rateLimit('ip:other', 1, 60_000, t0))
})
