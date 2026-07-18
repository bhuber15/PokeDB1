import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { staff } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { getSession, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { assertNotLocked, recordFailedAttempt, clearLockout } from '@/lib/domain/auth-lockout'
import { DomainError } from '@/lib/domain/errors'
import { rateLimit } from '@/lib/platform/rate-limit'

const pinLoginBody = z.object({ pin: z.string().regex(/^\d{4}$/, 'Invalid PIN format') })

export const POST = guarded(async (req: NextRequest) => {
  // Per-IP endpoint limit (spec §3.9), sized for busy-shop PIN churn — the
  // per-shop DB lockout below is the real brute-force guard.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`staff-pin:${ip}`, 120, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many attempts — try again in a few minutes')
  }
  const db = await getTenantDb()
  await assertNotLocked('staff-pin', db)
  const { pin } = await parseBody(req, pinLoginBody)
  const activeStaff = await db.select().from(staff).where(eq(staff.isActive, true))
  for (const member of activeStaff) {
    if (await bcrypt.compare(pin, member.pinHash)) {
      await clearLockout('staff-pin', db)
      const session = await getSession(await currentTenantId())
      session.staffId = member.id
      session.staffRole = member.role as 'admin' | 'staff'
      session.staffName = member.name
      session.tenantId = await currentTenantId()
      await session.save()
      return NextResponse.json({ id: member.id, name: member.name, role: member.role })
    }
  }
  await recordFailedAttempt('staff-pin', db) // throws 429 on the locking failure
  return NextResponse.json({ error: 'PIN not recognised' }, { status: 401 })
})

export async function DELETE() {
  const session = await getSession()
  session.staffId = undefined
  session.staffRole = undefined
  session.staffName = undefined
  await session.save()
  return NextResponse.json({ ok: true })
}
