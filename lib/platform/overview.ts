import { asc, sql } from 'drizzle-orm'
import { getTenantDbFor } from '@/lib/db'
import { getPlatformDb, type PlatformDb } from './db'
import { tenants, type Tenant } from './schema'

// The founders' tenant list (spec Phase 3): registry facts + a light probe
// into each tenant DB for "when did this shop last trade". The probe doubles
// as a reachability check — a tenant whose DB errors shows as unreachable,
// which is exactly the ops signal we want on this page.

export interface TenantOverviewRow {
  tenant: Tenant
  lastActivityAt: string | null   // TEXT datetime('now') convention in tenant DBs
  reachable: boolean
}

const CACHE_TTL_MS = 5 * 60_000
const CONCURRENCY = 5
let cache: { rows: TenantOverviewRow[]; at: number } | null = null

export function clearOverviewCache(): void { cache = null }

export async function tenantOverview(opts: {
  pdb?: PlatformDb
  nowMs?: number
  probe?: (t: Tenant) => Promise<string | null>
} = {}): Promise<TenantOverviewRow[]> {
  const nowMs = opts.nowMs ?? Date.now()
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.rows

  const pdb = opts.pdb ?? getPlatformDb()
  const probe = opts.probe ?? defaultProbe
  const all = await pdb.select().from(tenants).orderBy(asc(tenants.slug))

  const rows: TenantOverviewRow[] = []
  for (let i = 0; i < all.length; i += CONCURRENCY) {
    const chunk = all.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(chunk.map(t => probe(t)))
    settled.forEach((s, j) => {
      rows.push(s.status === 'fulfilled'
        ? { tenant: chunk[j], lastActivityAt: s.value, reachable: true }
        : { tenant: chunk[j], lastActivityAt: null, reachable: false })
    })
  }
  cache = { rows, at: nowMs }
  return rows
}

async function defaultProbe(t: Tenant): Promise<string | null> {
  const db = getTenantDbFor(String(t.id), t.dbUrl)
  const [r] = await db.all<{ s: string | null; b: string | null }>(sql`
    SELECT (SELECT max(created_at) FROM sales) AS s,
           (SELECT max(created_at) FROM buy_transactions) AS b`)
  if (!r) return null
  const latest = [r.s, r.b].filter((x): x is string => x != null).sort().at(-1)
  return latest ?? null
}
