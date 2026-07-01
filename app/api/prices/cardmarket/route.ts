import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { fetchCardmarketPrices } from '@/lib/apis/tcgdex'
import { getSettings } from '@/lib/settings'
import { eurToGbp } from '@/lib/pricing'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')?.trim() ?? ''
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  try {
    const [cm, settings] = await Promise.all([
      fetchCardmarketPrices(id),
      getSettings(),
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
}
