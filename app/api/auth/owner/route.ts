import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { getSession, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { assertNotLocked, recordFailedAttempt, clearLockout } from '@/lib/domain/auth-lockout'
import { db } from '@/lib/db'
import { getOwnerPasswordHash } from '@/lib/domain/staff'

const ownerLoginBody = z.object({ password: z.string().min(1) })

export const POST = guarded(async (req: NextRequest) => {
  await assertNotLocked('owner')
  const { password } = await parseBody(req, ownerLoginBody)
  const hash = (await getOwnerPasswordHash(db)) ?? process.env.OWNER_PASSWORD_HASH
  if (!hash) return NextResponse.json({ error: 'Server not configured' }, { status: 500 })
  const valid = await bcrypt.compare(password, hash)
  if (!valid) {
    await recordFailedAttempt('owner') // throws 429 on the locking failure
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }
  // Owner proved control of the device — unwind both lockouts so a staff
  // member locked out by typos can be let back in immediately.
  await clearLockout('owner')
  await clearLockout('staff-pin')
  const session = await getSession()
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
