import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getTenantDbFor, isMultiTenant } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'
import { tenants, tenantSyncState } from '@/lib/platform/schema'
import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue } from '@/lib/prices/sync'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'

// Full catalogue sweep takes minutes — run in its own invocation with the
// platform maximum, kicked by the provisioning webhook (spec §3.6). Safe to
// re-run: the sweep upserts, and the nightly sync-prices cron fully seeds any
// tenant this misses.
export const maxDuration = 300

const seedBody = z.object({ tenantId: z.number().int().positive() })

export const POST = guarded(async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { tenantId } = await parseBody(req, seedBody)
  const pdb = getPlatformDb()
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  if (!t) return NextResponse.json({ error: 'Unknown tenant' }, { status: 404 })
  const db = getTenantDbFor(String(t.id), t.dbUrl)
  const result = await sweepTcgplayerCatalogue(await getSettings(db), {}, db)
  await pdb.update(tenantSyncState)
    .set({ lastCatalogueSyncAt: Math.floor(Date.now() / 1000) })
    .where(eq(tenantSyncState.tenantId, t.id))
  return NextResponse.json(result)
})
