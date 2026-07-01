import { db } from '@/lib/db'
import { priceCache } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { fetchCardmarketPrices } from '@/lib/apis/tcgdex'
import { eurToGbp } from '@/lib/pricing'

export async function syncCardmarketForCard(
  cardId: number, externalId: string | null, variant: string | null, eurRate: number,
): Promise<void> {
  if (!externalId) return
  const cm = await fetchCardmarketPrices(externalId, variant)
  if (!cm) return
  try {
    await db.update(priceCache).set({
      cardmarketTrend: eurToGbp(cm.trend, eurRate),
      cardmarketLow: eurToGbp(cm.low, eurRate),
      cardmarketAvg: eurToGbp(cm.avg, eurRate),
      cardmarketSyncedAt: new Date().toISOString(),
    }).where(eq(priceCache.cardId, cardId))
  } catch { /* price row may not exist yet; ignore */ }
}
