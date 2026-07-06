import { eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { authLockouts } from '@/lib/db/schema'
import { DomainError } from './errors'

export type LockoutScope = 'staff-pin' | 'owner'

export const MAX_FAILURES = 5
export const WINDOW_SECONDS = 15 * 60
export const LOCKOUT_SECONDS = 15 * 60

const nowSeconds = () => Math.floor(Date.now() / 1000)

function throwLocked(retryAfterSeconds: number): never {
  const minutes = Math.ceil(retryAfterSeconds / 60)
  throw new DomainError(
    'RATE_LIMITED',
    `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { retryAfterSeconds },
  )
}

// Call before verifying credentials: rejects while the scope is locked.
export async function assertNotLocked(scope: LockoutScope, dbc: Db = db, now = nowSeconds()): Promise<void> {
  const [row] = await dbc.select().from(authLockouts).where(eq(authLockouts.scope, scope)).limit(1)
  if (row?.lockedUntil && row.lockedUntil > now) throwLocked(row.lockedUntil - now)
}

// Call after a failed credential check. The failure that reaches MAX_FAILURES
// within the window starts the lock and itself throws RATE_LIMITED.
export async function recordFailedAttempt(scope: LockoutScope, dbc: Db = db, now = nowSeconds()): Promise<void> {
  const [row] = await dbc.select().from(authLockouts).where(eq(authLockouts.scope, scope)).limit(1)

  // A stale window or an expired lock starts a fresh count.
  const fresh = !row
    || now - row.windowStart >= WINDOW_SECONDS
    || (row.lockedUntil !== null && row.lockedUntil <= now)
  const failCount = fresh ? 1 : row!.failCount + 1
  const windowStart = fresh ? now : row!.windowStart
  const lockedUntil = failCount >= MAX_FAILURES ? now + LOCKOUT_SECONDS : null

  await dbc.insert(authLockouts)
    .values({ scope, failCount, windowStart, lockedUntil })
    .onConflictDoUpdate({
      target: authLockouts.scope,
      set: { failCount, windowStart, lockedUntil },
    })

  if (lockedUntil !== null) throwLocked(lockedUntil - now)
}

export async function clearLockout(scope: LockoutScope, dbc: Db = db): Promise<void> {
  await dbc.delete(authLockouts).where(eq(authLockouts.scope, scope))
}
