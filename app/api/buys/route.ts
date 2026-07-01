import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buyTransactions, buyItems, inventoryItems, creditLedger, customers } from '@/lib/db/schema'
import { desc, eq, and } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { generateQRId } from '@/lib/qr'

const CONDITIONS = new Set(['NM', 'LP', 'MP', 'HP', 'DMG'])
const round2 = (n: number) => Math.round(n * 100) / 100

interface BuyLine { cardId: number; condition: string; quantity: number; payPrice: number }

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json() as { items: BuyLine[]; method: string; customerId?: number }

  if (!body.items?.length) return NextResponse.json({ error: 'No items' }, { status: 400 })
  if (!['cash', 'store_credit'].includes(body.method)) return NextResponse.json({ error: 'Invalid method' }, { status: 400 })
  if (body.method === 'store_credit' && !body.customerId) {
    return NextResponse.json({ error: 'Store credit requires a customer' }, { status: 400 })
  }
  for (const it of body.items) {
    if (!CONDITIONS.has(it.condition)) return NextResponse.json({ error: 'Invalid condition' }, { status: 400 })
    if (!Number.isInteger(it.quantity) || it.quantity < 1) return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 })
    if (!(it.payPrice >= 0)) return NextResponse.json({ error: 'Invalid pay price' }, { status: 400 })
    if (!Number.isInteger(it.cardId) || it.cardId < 1) return NextResponse.json({ error: 'Invalid cardId' }, { status: 400 })
  }
  const total = round2(body.items.reduce((s, i) => s + round2(i.payPrice) * i.quantity, 0))

  if (body.method === 'store_credit') {
    const [customer] = await db.select().from(customers).where(eq(customers.id, body.customerId!)).limit(1)
    if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  try {
    const buyId = await db.transaction(async (tx) => {
      const [buy] = await tx.insert(buyTransactions).values({
        staffId: session.staffId!, customerId: body.customerId ?? null,
        method: body.method, total,
      }).returning()

      for (const it of body.items) {
        // Merge on intake: increment an existing active row for this card+condition,
        // blending the cost basis; otherwise create a new stock row.
        const [existing] = await tx.select().from(inventoryItems).where(and(
          eq(inventoryItems.cardId, it.cardId),
          eq(inventoryItems.condition, it.condition),
          eq(inventoryItems.isActive, true),
        )).limit(1)

        let inventoryItemId: number
        if (existing) {
          const newQty = existing.quantity + it.quantity
          const newCost = round2((existing.costPrice * existing.quantity + round2(it.payPrice) * it.quantity) / newQty)
          await tx.update(inventoryItems)
            .set({ quantity: newQty, costPrice: newCost })
            .where(eq(inventoryItems.id, existing.id))
          inventoryItemId = existing.id
        } else {
          const [inv] = await tx.insert(inventoryItems).values({
            cardId: it.cardId, condition: it.condition, quantity: it.quantity,
            costPrice: round2(it.payPrice), qrCode: generateQRId(),
          }).returning()
          inventoryItemId = inv.id
        }

        await tx.insert(buyItems).values({
          buyId: buy.id, cardId: it.cardId, inventoryItemId,
          condition: it.condition, quantity: it.quantity, payPrice: round2(it.payPrice),
        })
      }

      if (body.method === 'store_credit') {
        await tx.insert(creditLedger).values({
          customerId: body.customerId!, delta: total, reason: 'buylist',
          refType: 'buy', refId: buy.id, staffId: session.staffId!,
        })
      }
      return buy.id
    })
    return NextResponse.json({ buyId, total })
  } catch (e) {
    console.error('Buy failed:', e)
    return NextResponse.json({ error: 'Buy failed' }, { status: 500 })
  }
}

export async function GET() {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rows = await db.select().from(buyTransactions).orderBy(desc(buyTransactions.createdAt)).limit(50)
  return NextResponse.json(rows)
}
