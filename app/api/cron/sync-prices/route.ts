import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue, syncInStockCardmarket, pruneOldHistory } from '@/lib/prices/sync'

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const settings = await getSettings()
  // Full-catalogue TCGplayer refresh (also picks up newly released sets),
  // then per-card Cardmarket for in-stock, then history retention.
  const sweep = await sweepTcgplayerCatalogue(settings)
  const cardmarket = await syncInStockCardmarket(settings)
  await pruneOldHistory()
  return NextResponse.json({ sweep, cardmarket })
}
