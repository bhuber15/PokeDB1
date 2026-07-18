import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseIdParam } from '@/lib/validation'
import { getInventoryValuation, getAgedStock, getLowStock } from '@/lib/domain/reports'

// Stock health report: valuation, reorder list, dead stock.
// ?agedDays= tunes the dead-stock cutoff (default 90 days).
export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))
  const agedDaysRaw = req.nextUrl.searchParams.get('agedDays')
  const agedDays = agedDaysRaw == null ? 90 : parseIdParam(agedDaysRaw, 'agedDays')
  const [valuation, lowStock, agedStock] = await Promise.all([
    getInventoryValuation(db),
    getLowStock(db),
    getAgedStock(agedDays, db),
  ])
  return NextResponse.json({ valuation, lowStock, agedStock })
})
