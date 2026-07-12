// app/api/sales/[id]/items/route.ts
import { NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { sales, saleItems, inventoryItems, cards, refundItems } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'

export const GET = guarded(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

  const saleId = parseInt((await params).id)
  if (!Number.isInteger(saleId)) return NextResponse.json({ error: 'Invalid sale id' }, { status: 400 })

  const [sale] = await db.select().from(sales).where(eq(sales.id, saleId)).limit(1)
  if (!sale) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })

  const rows = await db.select({
    saleItemId: saleItems.id,
    inventoryItemId: saleItems.inventoryItemId,
    quantity: saleItems.quantity,
    priceAtSale: saleItems.priceAtSale,
    condition: inventoryItems.condition,
    name: cards.name,
    refundedQuantity: sql<number>`COALESCE((
      SELECT SUM(${refundItems.quantity}) FROM ${refundItems} WHERE ${refundItems.saleItemId} = ${saleItems.id}
    ), 0)`,
  })
    .from(saleItems)
    .leftJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .where(eq(saleItems.saleId, saleId))

  return NextResponse.json({
    sale: {
      id: sale.id, total: sale.total, vatAmount: sale.vatAmount,
      subtotal: sale.subtotal, vatScheme: sale.vatScheme,
      paymentMethod: sale.paymentMethod, createdAt: sale.createdAt,
    },
    items: rows.map(r => ({ ...r, name: r.name ?? 'Unknown card', condition: r.condition ?? null })),
  })
})
