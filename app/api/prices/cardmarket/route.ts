import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { fetchCardmarketPrices } from '@/lib/apis/tcgdex'
import { getSettings } from '@/lib/settings'
import { eurToGbp } from '@/lib/pricing'

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

  const id = req.nextUrl.searchParams.get('id')?.trim() ?? ''
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  try {
    const [cm, settings] = await Promise.all([
      fetchCardmarketPrices(id),
      getSettings(db),
    ])
    if (!cm) return NextResponse.json({ trend: null, low: null, avg: null })

    const rate = settings.eurToGbp
    return NextResponse.json({
      trend: eurToGbp(cm.trend, rate),
      low: eurToGbp(cm.low, rate),
      avg: eurToGbp(cm.avg, rate),
    })
  } catch {
    return NextResponse.json({ trend: null, low: null, avg: null })
  }
})
