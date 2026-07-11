import { eq } from 'drizzle-orm'
import { getPlatformDb, type PlatformDb } from './db'
import { tenants, type Tenant } from './schema'

// Hosts that are never shop tenants.
export const RESERVED_SLUGS = ['www', 'admin', 'api', 'app'] as const

// "brads-cards.example-brand.co.uk" → "brads-cards"; anything that isn't
// exactly one non-reserved label in front of the base host → null.
export function parseTenantSlug(host: string, baseHost: string): string | null {
  const clean = host.toLowerCase().split(':')[0]
  const base = baseHost.toLowerCase()
  if (!clean.endsWith(`.${base}`)) return null
  const prefix = clean.slice(0, clean.length - base.length - 1)
  if (!prefix || prefix.includes('.')) return null
  if ((RESERVED_SLUGS as readonly string[]).includes(prefix)) return null
  return prefix
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { tenant: Tenant | null; at: number }>()

export function clearTenantCache(): void {
  cache.clear()
}

export async function getTenantBySlug(
  slug: string,
  opts: { db?: PlatformDb; ttlMs?: number; now?: number } = {},
): Promise<Tenant | null> {
  const now = opts.now ?? Date.now()
  const ttl = opts.ttlMs ?? CACHE_TTL_MS
  const hit = cache.get(slug)
  if (hit && now - hit.at < ttl) return hit.tenant
  const pdb = opts.db ?? getPlatformDb()
  const [tenant] = await pdb.select().from(tenants).where(eq(tenants.slug, slug)).limit(1)
  cache.set(slug, { tenant: tenant ?? null, at: now })
  return tenant ?? null
}
