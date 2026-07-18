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

// Admin host (spec §3.4): founders' dashboard on admin.<base>.
export function isAdminHost(host: string, baseHost: string): boolean {
  return host.trim().toLowerCase().split(':')[0] === `admin.${baseHost.toLowerCase()}`
}

export type AdminRouting =
  | { kind: 'pass' }
  | { kind: 'redirect-login' }
  | { kind: 'rewrite'; path: string }
  | { kind: 'not-found' }

export function decideAdminRouting(pathname: string, hasAdminSession: boolean): AdminRouting {
  // API handlers enforce the admin session themselves (requirePlatformAdmin);
  // shop APIs called on this host have no tenant headers and 401 in getTenantDb.
  if (pathname.startsWith('/api/')) return { kind: 'pass' }
  if (pathname === '/admin/login') return { kind: 'pass' }
  if (!hasAdminSession) return { kind: 'redirect-login' }
  if (pathname === '/') return { kind: 'rewrite', path: '/admin' }
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return { kind: 'pass' }
  return { kind: 'not-found' }   // shop paths don't exist on the admin host
}
