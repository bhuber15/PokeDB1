import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { rateLimit, resetRateLimits, RATE_LIMIT_MAX_KEYS } from './rate-limit'

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

test('at the key cap: new keys are refused (fail closed), expired ones swept', () => {
  const t0 = 1_000_000
  for (let i = 0; i < RATE_LIMIT_MAX_KEYS; i++) rateLimit(`flood:${i}`, 3, 60_000, t0)
  // Map full and every window still live → an unseen key is refused…
  assert.ok(!rateLimit('victim', 3, 60_000, t0 + 1))
  // …while already-tracked keys keep working normally.
  assert.ok(rateLimit('flood:0', 3, 60_000, t0 + 2))
  // Once the windows expire, the sweep frees space and new keys get in again.
  assert.ok(rateLimit('victim', 3, 60_000, t0 + 60_000))
  assert.ok(rateLimit('late-arrival', 3, 60_000, t0 + 60_001))
})

test('the sweep honours each entry\'s own window length', () => {
  const t0 = 2_000_000
  // Long-window keys fill half the map, short-window keys the rest.
  for (let i = 0; i < RATE_LIMIT_MAX_KEYS / 2; i++) rateLimit(`long:${i}`, 1, 600_000, t0)
  for (let i = 0; i < RATE_LIMIT_MAX_KEYS / 2; i++) rateLimit(`short:${i}`, 1, 60_000, t0)
  // Only the short windows have lapsed — the sweep must free just those,
  // which is still enough room to admit a new key.
  assert.ok(rateLimit('newcomer', 1, 60_000, t0 + 60_000))
  // The long-window keys survived the sweep: still tracked, still limited.
  assert.ok(!rateLimit('long:0', 1, 600_000, t0 + 60_001))
})
