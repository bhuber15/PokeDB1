import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb } from '@/lib/db/test-helpers'
import type { Db } from '@/lib/db'
import { DomainError } from './errors'
import {
  assertNotLocked, recordFailedAttempt, clearLockout,
  MAX_FAILURES, WINDOW_SECONDS, LOCKOUT_SECONDS,
} from './auth-lockout'

const rateLimited = (e: unknown) => e instanceof DomainError && e.code === 'RATE_LIMITED'

const T0 = 1_750_000_000 // arbitrary fixed epoch seconds

let dbc: Db
beforeEach(async () => {
  dbc = await createTestDb()
})

async function fail(times: number, at: number, scope: 'staff-pin' | 'owner' = 'staff-pin') {
  for (let i = 0; i < times; i++) await recordFailedAttempt(scope, dbc, at)
}

test('stays unlocked below the failure threshold', async () => {
  await fail(MAX_FAILURES - 1, T0)
  await assertNotLocked('staff-pin', dbc, T0)
})

test('locks on the threshold failure and rejects while locked', async () => {
  await fail(MAX_FAILURES - 1, T0)
  // The triggering failure itself throws so the caller returns 429, not 401.
  await assert.rejects(recordFailedAttempt('staff-pin', dbc, T0), rateLimited)
  await assert.rejects(assertNotLocked('staff-pin', dbc, T0), rateLimited)
  await assert.rejects(assertNotLocked('staff-pin', dbc, T0 + LOCKOUT_SECONDS - 1), rateLimited)
})

test('reports remaining lock time in meta', async () => {
  await assert.rejects(fail(MAX_FAILURES, T0), (e: unknown) => {
    assert.ok(e instanceof DomainError)
    assert.equal(e.meta?.retryAfterSeconds, LOCKOUT_SECONDS)
    return true
  })
  await assert.rejects(assertNotLocked('staff-pin', dbc, T0 + 100), (e: unknown) => {
    assert.ok(e instanceof DomainError)
    assert.equal(e.meta?.retryAfterSeconds, LOCKOUT_SECONDS - 100)
    return true
  })
})

test('lock expires after LOCKOUT_SECONDS and the count restarts', async () => {
  await assert.rejects(fail(MAX_FAILURES, T0), rateLimited)
  const after = T0 + LOCKOUT_SECONDS
  await assertNotLocked('staff-pin', dbc, after)
  // Post-expiry failures start a fresh window rather than instantly re-locking.
  await fail(MAX_FAILURES - 1, after)
  await assertNotLocked('staff-pin', dbc, after)
})

test('failures outside the window reset the count', async () => {
  await fail(MAX_FAILURES - 1, T0)
  await fail(MAX_FAILURES - 1, T0 + WINDOW_SECONDS)
  await assertNotLocked('staff-pin', dbc, T0 + WINDOW_SECONDS)
})

test('clearLockout removes both the lock and the running count', async () => {
  await assert.rejects(fail(MAX_FAILURES, T0), rateLimited)
  await clearLockout('staff-pin', dbc)
  await assertNotLocked('staff-pin', dbc, T0)
  await fail(MAX_FAILURES - 1, T0)
  await assertNotLocked('staff-pin', dbc, T0)
})

test('scopes are independent', async () => {
  await assert.rejects(fail(MAX_FAILURES, T0, 'staff-pin'), rateLimited)
  await assertNotLocked('owner', dbc, T0)
  await fail(1, T0, 'owner')
  await clearLockout('staff-pin', dbc)
  // Owner count untouched by clearing the pin scope.
  await assert.rejects(fail(MAX_FAILURES - 1, T0, 'owner'), rateLimited)
})
