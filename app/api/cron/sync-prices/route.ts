import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cards, inventoryItems } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getSettings } from '@/lib/settings'
import { syncCardmarketForCard } from '@/lib/prices/sync'

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const settings = await getSettings()
  const inStock = await db.selectDistinct({ id: cards.id, externalId: cards.externalId, variant: cards.variant })
    .from(cards)
    .innerJoin(inventoryItems, and(eq(inventoryItems.cardId, cards.id), eq(inventoryItems.isActive, true)))
  let ok = 0
  for (const c of inStock) { await syncCardmarketForCard(c.id, c.externalId, c.variant, settings.eurToGbp); ok++ }
  return NextResponse.json({ synced: ok })
}
