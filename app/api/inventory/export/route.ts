import { NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { inventoryItems, cards, priceCache } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { toCSV } from '@/lib/csv'
import { getSettings } from '@/lib/settings'
import { calculateSellPrice, conditionPct, pickMarketPrice } from '@/lib/pricing'

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))

  const settings = await getSettings(db)
  const rows = await db.select({ item: inventoryItems, card: cards, prices: priceCache })
    .from(inventoryItems)
    .innerJoin(cards, eq(inventoryItems.cardId, cards.id))
    .leftJoin(priceCache, eq(priceCache.cardId, inventoryItems.cardId))
    .where(eq(inventoryItems.isActive, true))

  // sell_price goes LAST so existing spreadsheet consumers keep their column
  // positions; the CSV import reads columns by header name and ignores extras.
  const csv = toCSV(
    ['inventory_id', 'external_id', 'name', 'set_name', 'set_number', 'condition', 'quantity', 'cost_price', 'sell_price_override', 'location', 'defect_notes', 'sell_price'],
    rows.map(({ item, card, prices }) => {
      // Same computation as the POS/labels: override, else conditioned market × margin.
      const sellPrice = calculateSellPrice(
        pickMarketPrice(prices, settings.primaryPriceSource),
        item.sellPriceOverride,
        settings.marginMultiplier,
        conditionPct(settings.conditionSellPct, item.condition),
      )
      return [
        item.id, card.externalId ?? '', card.name, card.setName, card.setNumber,
        // CSV money columns are pounds (human-facing, opened in Excel) — bare
        // numbers, not formatGBP, so the column stays numeric
        item.condition, item.quantity, item.costPrice != null ? (item.costPrice / 100).toFixed(2) : '',
        item.sellPriceOverride != null ? (item.sellPriceOverride / 100).toFixed(2) : '',
        item.location ?? '', item.defectNotes ?? '',
        sellPrice != null ? (sellPrice / 100).toFixed(2) : '',
      ]
    }),
  )
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inventory-${date}.csv"`,
    },
  })
})
