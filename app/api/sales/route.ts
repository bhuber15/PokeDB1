// app/api/sales/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sales, saleItems, inventoryItems } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { getSession } from '@/lib/auth'

interface SaleItemInput {
  inventoryItemId: number
  quantity: number
  priceAtSale: number
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    items: SaleItemInput[]
    paymentMethod: string
    discountAmount?: number
    vatScheme?: string
  }

  if (!body.items?.length) return NextResponse.json({ error: 'No items' }, { status: 400 })

  // Check stock before decrement
  for (const item of body.items) {
    const [inv] = await db.select({ quantity: inventoryItems.quantity })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, item.inventoryItemId))
      .limit(1)
    if (!inv || inv.quantity < item.quantity) {
      return NextResponse.json(
        { error: `Insufficient stock for item ${item.inventoryItemId}` },
        { status: 409 }
      )
    }
  }

  const discountAmount = body.discountAmount ?? 0
  const subtotal = body.items.reduce((sum, i) => sum + i.priceAtSale * i.quantity, 0)
  const afterDiscount = Math.max(0, subtotal - discountAmount)
  const vatScheme = body.vatScheme ?? 'none'
  const vatAmount = vatScheme === 'standard' ? afterDiscount * 0.2 : 0
  const total = afterDiscount + vatAmount

  const [sale] = await db.insert(sales).values({
    staffId: session.staffId ?? null,
    subtotal,
    discountAmount,
    vatAmount,
    vatScheme,
    total,
    paymentMethod: body.paymentMethod,
  }).returning()

  await Promise.all(body.items.map(async item => {
    await db.insert(saleItems).values({
      saleId: sale.id,
      inventoryItemId: item.inventoryItemId,
      quantity: item.quantity,
      priceAtSale: item.priceAtSale,
    })
    await db.update(inventoryItems)
      .set({ quantity: sql`quantity - ${item.quantity}` })
      .where(eq(inventoryItems.id, item.inventoryItemId))
  }))

  return NextResponse.json({ saleId: sale.id, total })
}

export async function GET() {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rows = await db.select().from(sales).orderBy(sql`created_at DESC`).limit(50)
  return NextResponse.json(rows)
}
