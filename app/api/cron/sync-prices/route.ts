import { NextRequest, NextResponse } from 'next/server'
import { inArray } from 'drizzle-orm'
import { getTenantDb, getTenantDbFor, isMultiTenant, type Db } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'
import { tenants } from '@/lib/platform/schema'
import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue, syncInStockCardmarket, pruneOldHistory } from '@/lib/prices/sync'

// Full catalogue sweep takes minutes — allow the platform maximum
export const maxDuration = 300

async function syncOne(db: Db) {
  const settings = await getSettings(db)
  // Full-catalogue TCGplayer refresh (also picks up newly released sets),
  // then per-card Cardmarket for in-stock, then history retention.
  const sweep = await sweepTcgplayerCatalogue(settings, {}, db)
  const cardmarket = await syncInStockCardmarket(settings, db)
  await pruneOldHistory(db)
  return { sweep, cardmarket }
}

export async function GET(req: NextRequest) {
  // Fail closed: without a configured secret there is no valid Authorization
  // header, so an unset CRON_SECRET can never be matched by `Bearer undefined`.
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isMultiTenant()) {
    return NextResponse.json(await syncOne(await getTenantDb()))
  }
  // Simple sequential fan-out — fine for the first ~10 shops; the cursor-based
  // staggering lands in Phase 3 (spec §3.7).
  const live = await getPlatformDb().select().from(tenants)
    .where(inArray(tenants.status, ['trialing', 'active', 'past_due']))
  const results: Record<string, unknown> = {}
  for (const t of live) {
    try {
      results[t.slug] = await syncOne(getTenantDbFor(String(t.id), t.dbUrl))
    } catch (e) {
      results[t.slug] = { error: e instanceof Error ? e.message : 'sync failed' }
    }
  }
  return NextResponse.json(results)
}
