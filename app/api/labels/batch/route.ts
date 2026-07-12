import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq, inArray, and } from 'drizzle-orm'
import { getTenantDb } from '@/lib/db'
import { inventoryItems, cards, priceCache } from '@/lib/db/schema'
import { generateQRDataURL } from '@/lib/qr'
import { getSettings } from '@/lib/settings'
import { calculateSellPrice, pickMarketPrice } from '@/lib/pricing'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'

const batchLabelsBody = z.object({
  inventoryItemIds: z.array(z.number().int().positive()).min(1).max(500),
})

// QR label data for a set of inventory items (one buy, one CSV import, …).
// Sell prices are server-computed: override, else market × margin.
export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const { inventoryItemIds } = await parseBody(req, batchLabelsBody)

  const rows = await db.select({ item: inventoryItems, card: cards, prices: priceCache })
    .from(inventoryItems)
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .leftJoin(priceCache, eq(cards.id, priceCache.cardId))
    .where(and(inArray(inventoryItems.id, inventoryItemIds), eq(inventoryItems.isActive, true)))

  const settings = await getSettings(db)
  const labels = await Promise.all(rows.map(async ({ item, card, prices }) => ({
    inventoryItemId: item.id,
    dataUrl: await generateQRDataURL(item.qrCode),
    cardName: card?.name ?? 'Unknown',
    condition: item.condition,
    quantity: item.quantity,
    sellPrice: calculateSellPrice(
      pickMarketPrice(prices, settings.primaryPriceSource),
      item.sellPriceOverride,
      settings.marginMultiplier,
    ),
  })))

  return NextResponse.json({ labels })
})
