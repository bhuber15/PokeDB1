import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { wantList, cards, customers, inventoryItems } from '@/lib/db/schema'
import { eq, isNull, and, inArray, desc } from 'drizzle-orm'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'

export const GET = guarded(async () => {
  requireStaff(await getSession())

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
    inStockSet = new Set(activeRows.map(r => r.cardId).filter((id): id is number => id != null))
  }

  const result = wants.map(w => ({
    ...w,
    inStock: w.cardId != null ? inStockSet.has(w.cardId) : false,
  }))

  return NextResponse.json({ wants: result })
})

export const POST = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())

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
})

export const DELETE = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const n = Number(id)
  if (!Number.isInteger(n)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  await db
    .update(wantList)
    .set({ fulfilledAt: new Date().toISOString() })
    .where(eq(wantList.id, n))

  return NextResponse.json({ ok: true })
})
