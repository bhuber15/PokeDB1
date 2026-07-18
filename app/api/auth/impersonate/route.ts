import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { guarded } from '@/lib/api'
import { isMultiTenant } from '@/lib/db'
import { DomainError } from '@/lib/domain/errors'
import { SessionData, sessionOptions } from '@/lib/auth'
import { rateLimit } from '@/lib/platform/rate-limit'
import { consumeImpersonationGrant } from '@/lib/platform/impersonation'

// Lands here from the admin dashboard's "Open shop" button. The session is
// owner-level with a synthetic staff identity: staffId -1 references no
// staff row, so staff-attributed writes (sales, buys) fail their FK on
// purpose — impersonation is for looking and configuring, not transacting,
// and nothing ever gets attributed to the shop's real staff.
export const GET = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`impersonate:${ip}`, 10, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many attempts')
  }
  const token = req.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 })

  const tenant = await consumeImpersonationGrant(token)
  if (!tenant) {
    return NextResponse.json({ error: 'Link expired — mint a fresh one from the admin dashboard' }, { status: 404 })
  }

  // The proxy resolved this request's tenant from the Host header; a token
  // minted for shop A must not log anyone into shop B.
  if (req.headers.get('x-tenant-id') !== String(tenant.id)) {
    return NextResponse.json({ error: 'Wrong shop' }, { status: 404 })
  }

  const session = await getIronSession<SessionData>(await cookies(), {
    ...sessionOptions,
    cookieOptions: { ...sessionOptions.cookieOptions, maxAge: 60 * 60 * 4 },   // short leash
  })
  session.isOwnerLoggedIn = true
  session.tenantId = String(tenant.id)
  session.staffId = -1
  session.staffRole = 'admin'
  session.staffName = 'Platform support'
  session.impersonated = true
  await session.save()
  return NextResponse.redirect(new URL('/', req.url))
})
