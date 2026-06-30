// app/api/sales/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sales, saleItems, inventoryItems } from '@/lib/db/schema'
import { eq, and, gte, sql, desc } from 'drizzle-orm'
import { getSession } from '@/lib/auth'

interface SaleItemInput {
  inventoryItemId: number
  quantity: number
  priceAtSale: number
}

const PAYMENT_METHODS = new Set(['cash', 'card', 'store_credit', 'other'])
const VAT_SCHEMES = new Set(['standard', 'margin', 'none'])
const round2 = (n: number) => Math.round(n * 100) / 100

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
  if (!PAYMENT_METHODS.has(body.paymentMethod)) {
    return NextResponse.json({ error: 'Invalid payment method' }, { status: 400 })
  }
  for (const item of body.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 })
    }
  }

  const discountAmount = round2(Math.max(0, body.discountAmount ?? 0))
  const subtotal = round2(body.items.reduce((sum, i) => sum + i.priceAtSale * i.quantity, 0))
  const afterDiscount = Math.max(0, subtotal - discountAmount)
  const vatScheme = VAT_SCHEMES.has(body.vatScheme ?? 'none') ? (body.vatScheme ?? 'none') : 'none'
  const vatAmount = round2(vatScheme === 'standard' ? afterDiscount * 0.2 : 0)
  const total = round2(afterDiscount + vatAmount)

  try {
    const saleId = await db.transaction(async (tx) => {
      // Decrement every line first, guarded so stock can never go negative.
      // If any line lacks stock, throw to roll the whole sale back.
      for (const item of body.items) {
        const decremented = await tx.update(inventoryItems)
          .set({ quantity: sql`quantity - ${item.quantity}` })
          .where(and(
            eq(inventoryItems.id, item.inventoryItemId),
            gte(inventoryItems.quantity, item.quantity),
          ))
          .returning({ id: inventoryItems.id })
        if (decremented.length === 0) {
          throw new Error(`INSUFFICIENT_STOCK:${item.inventoryItemId}`)
        }
      }

      const [sale] = await tx.insert(sales).values({
        staffId: session.staffId!,
        subtotal,
        discountAmount,
        vatAmount,
        vatScheme,
        total,
        paymentMethod: body.paymentMethod,
      }).returning()

      await Promise.all(body.items.map(item =>
        tx.insert(saleItems).values({
          saleId: sale.id,
          inventoryItemId: item.inventoryItemId,
          quantity: item.quantity,
          priceAtSale: item.priceAtSale,
        })
      ))

      return sale.id
    })

    return NextResponse.json({ saleId, total })
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.startsWith('INSUFFICIENT_STOCK:')) {
      return NextResponse.json(
        { error: `Insufficient stock for item ${msg.split(':')[1]}` },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: 'Sale failed' }, { status: 500 })
  }
}

export async function GET() {
  const session = await getSession()
  // Sales totals are sensitive — admin only (matches the Reports page)
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  const rows = await db.select().from(sales).orderBy(desc(sales.createdAt)).limit(50)
  return NextResponse.json(rows)
}
