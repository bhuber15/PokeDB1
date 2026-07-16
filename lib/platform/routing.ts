import type { Tenant } from './schema'
import { entitlementsFor, isPlan, type Plan } from '@/lib/plan'

const BLOCKED_STATUSES = new Set(['suspended', 'cancelled', 'paused'])

export type TenantRouting =
  | { kind: 'not-tenant' }
  | { kind: 'unknown' }
  | { kind: 'blocked'; status: string }
  | { kind: 'serve'; headers: Record<string, string> }

export function decideTenantRouting(input: {
  slug: string | null
  tenant: Pick<Tenant, 'id' | 'dbUrl' | 'status' | 'plan' | 'entitlementOverrides'> | null
}): TenantRouting {
  if (input.slug === null) return { kind: 'not-tenant' }
  if (!input.tenant) return { kind: 'unknown' }
  if (BLOCKED_STATUSES.has(input.tenant.status)) return { kind: 'blocked', status: input.tenant.status }
  const plan: Plan = isPlan(input.tenant.plan) ? input.tenant.plan : 'growth'
  return {
    kind: 'serve',
    headers: {
      'x-tenant-id': String(input.tenant.id),
      'x-tenant-db-url': input.tenant.dbUrl,
      'x-tenant-status': input.tenant.status,
      'x-tenant-plan': plan,
      // Merged here, once, so downstream readers never re-implement override
      // logic. The proxy strips inbound copies — this is the only writer.
      'x-tenant-entitlements': JSON.stringify(entitlementsFor(plan, input.tenant.entitlementOverrides)),
    },
  }
}
