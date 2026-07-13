import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { getTenantDb, isMultiTenant } from '@/lib/db'
import { getSession, currentTenantId } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { rateLimit } from '@/lib/platform/rate-limit'
import { completeSetup } from '@/lib/platform/setup'

const setupBody = z.object({
  token: z.string().min(20),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  staffName: z.string().trim().min(1, 'Your name is required'),
  pin: z.string().regex(/^\d{4}$/, '4-digit PIN required'),
})

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const tenantId = await currentTenantId()
  if (!tenantId) throw new DomainError('UNAUTHORIZED', 'No tenant context')
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`setup:${ip}`, 10, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many attempts — please try again shortly')
  }
  const input = await parseBody(req, setupBody)
  const db = await getTenantDb()
  const result = await completeSetup({ tenantId: Number(tenantId), ...input }, db)

  // The owner just proved control via the emailed token: mint the full
  // owner + admin session so they land straight in the app.
  const session = await getSession(tenantId)
  session.isOwnerLoggedIn = true
  session.tenantId = tenantId
  session.staffId = result.staffId
  session.staffRole = 'admin'
  session.staffName = result.staffName
  await session.save()
  return NextResponse.json({ ok: true })
})
