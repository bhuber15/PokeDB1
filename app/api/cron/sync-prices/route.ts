import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue, syncInStockCardmarket, pruneOldHistory } from '@/lib/prices/sync'

// Full catalogue sweep takes minutes — allow the platform maximum
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Fail closed: without a configured secret there is no valid Authorization
  // header, so an unset CRON_SECRET can never be matched by `Bearer undefined`.
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
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
