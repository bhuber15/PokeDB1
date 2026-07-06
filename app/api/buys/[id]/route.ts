import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { buyTransactions, buyItems, cards, customers, staff } from '@/lib/db/schema'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'

// Buy transaction detail — powers the printable buy slip and batch labels.
export const GET = guarded(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  requireStaff(await getSession())
  const { id } = await params

  const [buy] = await db.select().from(buyTransactions)
    .where(eq(buyTransactions.id, parseInt(id))).limit(1)
  if (!buy) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const items = await db.select({
    id: buyItems.id,
    cardName: cards.name,
    setName: cards.setName,
    setNumber: cards.setNumber,
    condition: buyItems.condition,
    quantity: buyItems.quantity,
    payPrice: buyItems.payPrice,
    marketAtBuy: buyItems.marketAtBuy,
    inventoryItemId: buyItems.inventoryItemId,
  }).from(buyItems)
    .leftJoin(cards, eq(buyItems.cardId, cards.id))
    .where(eq(buyItems.buyId, buy.id))

  const [customer] = buy.customerId
    ? await db.select().from(customers).where(eq(customers.id, buy.customerId)).limit(1)
    : []
  const [staffMember] = buy.staffId
    ? await db.select().from(staff).where(eq(staff.id, buy.staffId)).limit(1)
    : []

  return NextResponse.json({
    buy,
    customerName: customer?.name ?? null,
    staffName: staffMember?.name ?? null,
    items,
  })
})
