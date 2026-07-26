import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb, isMultiTenant } from '@/lib/db'
import { isAuthorizedCron } from '@/lib/api'
import { runFullPriceSync } from '@/lib/prices/run-sync'

// Full catalogue sweep takes minutes — allow the platform maximum
export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (isMultiTenant()) {
    // Multi deployments sync via /api/cron/sync-tenants (cursor-staggered,
    // spec §3.7). 200 so the daily cron stays green on both modes.
    return NextResponse.json({ skipped: 'multi-tenant' })
  }
  return NextResponse.json(await runFullPriceSync(await getTenantDb()))
}
