import { NextRequest, NextResponse } from 'next/server'
import { guarded } from '@/lib/api'
import { isMultiTenant } from '@/lib/db'
import { getSession, currentTenantId } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { getTenantById } from '@/lib/platform/tenants'
import { getStripe } from '@/lib/platform/stripe'

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const session = await getSession(await currentTenantId())
  if (!session.isOwnerLoggedIn && session.staffRole !== 'admin') {
    throw new DomainError('UNAUTHORIZED', 'Login required')
  }
  const tenantId = await currentTenantId()
  const tenant = tenantId ? await getTenantById(Number(tenantId)) : null
  if (!tenant?.stripeCustomerId) throw new DomainError('NOT_FOUND', 'No billing account for this shop')
  const portal = await getStripe().billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: `${req.nextUrl.origin}/settings`,
  })
  return NextResponse.json({ url: portal.url })
})
