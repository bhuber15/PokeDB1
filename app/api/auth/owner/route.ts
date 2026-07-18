import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { getSession, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { assertNotLocked, recordFailedAttempt, clearLockout } from '@/lib/domain/auth-lockout'
import { getTenantDb } from '@/lib/db'
import { getOwnerPasswordHash } from '@/lib/domain/staff'
import { DomainError } from '@/lib/domain/errors'
import { rateLimit } from '@/lib/platform/rate-limit'

const ownerLoginBody = z.object({ password: z.string().min(1) })

export const POST = guarded(async (req: NextRequest) => {
  // Per-IP endpoint limit (spec §3.9); the per-shop DB lockout below is the
  // real brute-force guard. Generous enough for a shop full of typos.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`owner-login:${ip}`, 20, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many login attempts — try again in a few minutes')
  }
  const db = await getTenantDb()
  await assertNotLocked('owner', db)
  const { password } = await parseBody(req, ownerLoginBody)
  const hash = (await getOwnerPasswordHash(db)) ?? process.env.OWNER_PASSWORD_HASH
  if (!hash) return NextResponse.json({ error: 'Server not configured' }, { status: 500 })
  const valid = await bcrypt.compare(password, hash)
  if (!valid) {
    await recordFailedAttempt('owner', db) // throws 429 on the locking failure
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }
  // Owner proved control of the device — unwind both lockouts so a staff
  // member locked out by typos can be let back in immediately.
  await clearLockout('owner', db)
  await clearLockout('staff-pin', db)
  const session = await getSession(await currentTenantId())
  session.isOwnerLoggedIn = true
  session.tenantId = await currentTenantId()
  await session.save()
  return NextResponse.json({ ok: true })
})

export async function DELETE() {
  const session = await getSession()
  session.destroy()
  return NextResponse.json({ ok: true })
}
