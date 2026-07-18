import { inArray, sql } from 'drizzle-orm'
import type { PlatformDb } from './db'
import { tenants, tenantSyncState, type Tenant } from './schema'

// Cursor-staggered fan-out over live tenants (spec §3.7): each cron
// invocation processes the tenants whose cursor field is stale, oldest first,
// inside a time budget, then advances the cursor. Failures advance the cursor
// too — a permanently broken tenant DB must not wedge the queue head; the
// error is surfaced in the cron response (and Sentry) and retried next cycle.

export const LIVE_STATUSES = ['trialing', 'active', 'past_due'] as const

export interface FanoutResult {
  due: number
  processed: { slug: string; ok: boolean; error?: string }[]
  remaining: number
}

export async function forEachDueTenant(
  opts: {
    pdb: PlatformDb
    field: 'lastPriceSyncAt' | 'lastBackupAt'
    dueAfterSeconds: number
    budgetMs: number
    nowMs?: () => number
  },
  fn: (tenant: Tenant) => Promise<void>,
): Promise<FanoutResult> {
  const nowMs = opts.nowMs ?? Date.now
  const startedAt = nowMs()
  const cutoff = Math.floor(startedAt / 1000) - opts.dueAfterSeconds
  const col = opts.field === 'lastPriceSyncAt' ? tenantSyncState.lastPriceSyncAt : tenantSyncState.lastBackupAt

  const rows = await opts.pdb
    .select({ tenant: tenants, cursor: col })
    .from(tenants)
    .leftJoin(tenantSyncState, sql`${tenantSyncState.tenantId} = ${tenants.id}`)
    .where(inArray(tenants.status, [...LIVE_STATUSES]))
    .orderBy(sql`coalesce(${col}, 0) asc`)

  const due = rows.filter(r => r.cursor == null || r.cursor <= cutoff)
  const processed: FanoutResult['processed'] = []

  for (const { tenant } of due) {
    if (processed.length > 0 && nowMs() - startedAt >= opts.budgetMs) break
    try {
      await fn(tenant)
      processed.push({ slug: tenant.slug, ok: true })
    } catch (e) {
      processed.push({ slug: tenant.slug, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    const completedAtS = Math.floor(nowMs() / 1000)
    await opts.pdb.insert(tenantSyncState)
      .values({ tenantId: tenant.id, [opts.field]: completedAtS })
      .onConflictDoUpdate({ target: tenantSyncState.tenantId, set: { [opts.field]: completedAtS } })
  }

  return { due: due.length, processed, remaining: due.length - processed.length }
}
