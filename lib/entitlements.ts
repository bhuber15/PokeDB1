import { entitlementsFor, isPlan, type Entitlements } from '@/lib/plan'

// Server-side view of the current request's entitlements, from the
// proxy-injected headers. Single-tenant installs are unmanaged
// (Wizard-of-Oz / dev / tests) — nothing is gated, i.e. pro.
export async function getEntitlements(): Promise<Entitlements> {
  if (process.env.TENANCY_MODE !== 'multi') return entitlementsFor('pro')
  const { headers } = await import('next/headers')
  const h = await headers()
  const raw = h.get('x-tenant-entitlements')
  if (raw) {
    try {
      return JSON.parse(raw) as Entitlements
    } catch { /* fall through to plan default */ }
  }
  const plan = h.get('x-tenant-plan')
  return entitlementsFor(isPlan(plan) ? plan : 'growth')
}
