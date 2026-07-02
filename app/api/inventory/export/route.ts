import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { inventoryItems, cards } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { toCSV } from '@/lib/csv'

export const GET = guarded(async () => {
  requireStaff(await getSession())

  const rows = await db.select({ item: inventoryItems, card: cards })
    .from(inventoryItems)
    .innerJoin(cards, eq(inventoryItems.cardId, cards.id))
    .where(eq(inventoryItems.isActive, true))

  const csv = toCSV(
    ['inventory_id', 'external_id', 'name', 'set_name', 'set_number', 'condition', 'quantity', 'cost_price', 'sell_price_override', 'location', 'defect_notes'],
    rows.map(({ item, card }) => [
      item.id, card.externalId ?? '', card.name, card.setName, card.setNumber,
      item.condition, item.quantity, item.costPrice, item.sellPriceOverride ?? '',
      item.location ?? '', item.defectNotes ?? '',
    ]),
  )
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inventory-${date}.csv"`,
    },
  })
})
