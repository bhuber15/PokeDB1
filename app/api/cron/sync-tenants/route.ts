import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getTenantDbFor, isMultiTenant } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'
import { tenantSyncState } from '@/lib/platform/schema'
import { forEachDueTenant } from '@/lib/platform/fanout'
import { runFullPriceSync } from '@/lib/prices/run-sync'
import { captureException } from '@/lib/observability'

// Cursor-staggered price sync (spec §3.7): runs every 15 minutes; each
// invocation refreshes the tenants whose last sync is >20h old, oldest
// first, inside a 240s budget (maxDuration leaves headroom to finish the
// tenant in flight). A full sweep is minutes per tenant, so one invocation
// handles a few tenants and the fleet is covered daily with lots of slack.
export const maxDuration = 300
const BUDGET_MS = 240_000
const DUE_AFTER_S = 20 * 3600

export async function GET(req: NextRequest) {
  // Fail closed: without a configured secret there is no valid Authorization
  // header, so an unset CRON_SECRET can never be matched by `Bearer undefined`.
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isMultiTenant()) {
    // Single-tenant deploys sync via the daily /api/cron/sync-prices.
    return NextResponse.json({ skipped: 'single-tenant' })
  }
  const pdb = getPlatformDb()
  const result = await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: DUE_AFTER_S, budgetMs: BUDGET_MS },
    async (tenant) => {
      await runFullPriceSync(getTenantDbFor(String(tenant.id), tenant.dbUrl))
      // The sweep refreshes the catalogue too; keep that cursor honest for
      // the admin overview.
      await pdb.update(tenantSyncState)
        .set({ lastCatalogueSyncAt: Math.floor(Date.now() / 1000) })
        .where(eq(tenantSyncState.tenantId, tenant.id))
    },
  )
  for (const p of result.processed) {
    if (!p.ok) await captureException(new Error(`price sync failed for ${p.slug}: ${p.error}`))
  }
  return NextResponse.json(result)
}
