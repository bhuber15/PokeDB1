import type { Tenant } from './schema'

const BLOCKED_STATUSES = new Set(['suspended', 'cancelled', 'paused'])

export type TenantRouting =
  | { kind: 'not-tenant' }
  | { kind: 'unknown' }
  | { kind: 'blocked' }
  | { kind: 'serve'; headers: Record<string, string> }

export function decideTenantRouting(input: {
  slug: string | null
  tenant: Pick<Tenant, 'id' | 'dbUrl' | 'status'> | null
}): TenantRouting {
  if (input.slug === null) return { kind: 'not-tenant' }
  if (!input.tenant) return { kind: 'unknown' }
  if (BLOCKED_STATUSES.has(input.tenant.status)) return { kind: 'blocked' }
  return {
    kind: 'serve',
    headers: {
      'x-tenant-id': String(input.tenant.id),
      'x-tenant-db-url': input.tenant.dbUrl,
      'x-tenant-status': input.tenant.status,
    },
  }
}
