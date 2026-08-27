import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getTenantDb } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { syncMarketPricesForCard } from '@/lib/prices/sync'
import { getSettings } from '@/lib/settings'

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

  // ?cardId= — refresh the price_cache Cardmarket entry for a catalogue card
  // and return the updated row. The buylist browse flow uses this so offers
  // for cards the shop has never stocked are priced off Cardmarket rather
  // than the TCGplayer USD fallback.
  const cardIdParam = req.nextUrl.searchParams.get('cardId')
  if (cardIdParam == null) return NextResponse.json({ error: 'Missing cardId' }, { status: 400 })
  const cardId = Number(cardIdParam)
  if (!Number.isInteger(cardId) || cardId < 1) {
    return NextResponse.json({ error: 'Invalid cardId' }, { status: 400 })
  }
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1)
  if (!card) return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  const settings = await getSettings(db)
  try {
    await syncMarketPricesForCard(card.id, card.externalId, card.variant, { eur: settings.eurToGbp, usd: settings.usdToGbp }, db)
  } catch {
    // TCGdex down — fall through and serve whatever is cached.
  }
  const [prices] = await db.select().from(priceCache).where(eq(priceCache.cardId, cardId)).limit(1)
  return NextResponse.json({ prices: prices ?? null })
})
