import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { wantList, cards, customers, inventoryItems } from '@/lib/db/schema'
import { eq, isNull, and, inArray, desc } from 'drizzle-orm'
import { getSession } from '@/lib/auth'

export async function GET() {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch open wants with card and customer info
  const wants = await db
    .select({
      id: wantList.id,
      customerId: wantList.customerId,
      cardId: wantList.cardId,
      freeText: wantList.freeText,
      notify: wantList.notify,
      createdAt: wantList.createdAt,
      customerName: customers.name,
      cardName: cards.name,
      cardSetName: cards.setName,
      cardSetNumber: cards.setNumber,
    })
    .from(wantList)
    .leftJoin(customers, eq(wantList.customerId, customers.id))
    .leftJoin(cards, eq(wantList.cardId, cards.id))
    .where(isNull(wantList.fulfilledAt))
    .orderBy(desc(wantList.createdAt))

  // Determine inStock for wants that have a cardId
  const cardIds = wants.map(w => w.cardId).filter((id): id is number => id != null)

  let inStockSet = new Set<number>()
  if (cardIds.length > 0) {
    const activeRows = await db
      .select({ cardId: inventoryItems.cardId })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.isActive, true), inArray(inventoryItems.cardId, cardIds)))
    for (const row of activeRows) {
      if (row.cardId != null) inStockSet.add(row.cardId)
    }
  }

  const result = wants.map(w => ({
    ...w,
    inStock: w.cardId != null ? inStockSet.has(w.cardId) : false,
  }))

  return NextResponse.json({ wants: result })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { customerId, cardId, freeText } = body

  if (!customerId || typeof customerId !== 'number') {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 })
  }
  if (!cardId && !freeText?.trim()) {
    return NextResponse.json({ error: 'Either cardId or freeText is required' }, { status: 400 })
  }

  const [item] = await db.insert(wantList).values({
    customerId,
    cardId: cardId ?? null,
    freeText: freeText?.trim() ?? null,
  }).returning()

  return NextResponse.json(item, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  await db
    .update(wantList)
    .set({ fulfilledAt: new Date().toISOString() })
    .where(eq(wantList.id, parseInt(id)))

  return NextResponse.json({ ok: true })
}
