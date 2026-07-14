import { NextResponse } from 'next/server'
import { guarded } from '@/lib/api'
import { isMultiTenant } from '@/lib/db'
import { getSession, currentTenantId, requireOwnerOrAdmin } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { getTenantById } from '@/lib/platform/tenants'
import { getStripe } from '@/lib/platform/stripe'

// Billing facts for the settings card. Read-only; all changes happen in the
// Stripe customer portal (spec §3.5 — no billing UI of our own).
export const GET = guarded(async () => {
  if (!isMultiTenant()) return NextResponse.json({ managed: false })
  requireOwnerOrAdmin(await getSession(await currentTenantId()))
  const tenantId = await currentTenantId()
  const tenant = tenantId ? await getTenantById(Number(tenantId)) : null
  if (!tenant) throw new DomainError('NOT_FOUND', 'Tenant not found')

  let trialEndsAt: number | null = null
  let cancelAtPeriodEnd = false
  if (tenant.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY) {
    try {
      const sub = await getStripe().subscriptions.retrieve(tenant.stripeSubscriptionId)
      trialEndsAt = sub.trial_end ?? null
      cancelAtPeriodEnd = sub.cancel_at_period_end ?? false
    } catch { /* registry facts still render */ }
  }
  return NextResponse.json({
    managed: true,
    plan: tenant.plan,
    status: tenant.status,
    trialEndsAt,
    cancelAtPeriodEnd,
  })
})
