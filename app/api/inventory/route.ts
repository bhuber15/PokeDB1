import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { inventoryItems, cards, priceCache } from '@/lib/db/schema'
import { eq, and, like } from 'drizzle-orm'
import { generateQRId } from '@/lib/qr'
import { getSession } from '@/lib/auth'

const CONDITIONS = new Set(['NM', 'LP', 'MP', 'HP', 'DMG'])
const round2 = (n: number) => Math.round(n * 100) / 100

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cardId = req.nextUrl.searchParams.get('cardId')
  const qrCode = req.nextUrl.searchParams.get('qrCode')
  const q = req.nextUrl.searchParams.get('q')?.trim()

  const base = db
    .select({ item: inventoryItems, card: cards, prices: priceCache })
    .from(inventoryItems)
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .leftJoin(priceCache, eq(cards.id, priceCache.cardId))

  if (cardId) {
    return NextResponse.json(await base.where(and(
      eq(inventoryItems.cardId, parseInt(cardId)),
      eq(inventoryItems.isActive, true),
    )))
  }
  if (qrCode) {
    return NextResponse.json(await base.where(and(
      eq(inventoryItems.qrCode, qrCode),
      eq(inventoryItems.isActive, true),
    )))
  }
  if (q) {
    // In-stock name search (used by the POS) — active items whose card name matches.
    return NextResponse.json(await base.where(and(
      eq(inventoryItems.isActive, true),
      like(cards.name, `%${q}%`),
    )))
  }
  return NextResponse.json(await base.where(eq(inventoryItems.isActive, true)))
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.isOwnerLoggedIn) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { cardId, condition, quantity, costPrice, sellPriceOverride, location, defectNotes } = await req.json()

  if (!cardId || !condition || quantity == null || costPrice == null) {
    return NextResponse.json({ error: 'cardId, condition, quantity and costPrice are required' }, { status: 400 })
  }
  if (!CONDITIONS.has(condition)) {
    return NextResponse.json({ error: 'Invalid condition' }, { status: 400 })
  }

  // Merge on intake: one active row per card+condition. If it already exists,
  // add to its quantity and blend the cost basis (weighted average).
  const [existing] = await db.select().from(inventoryItems).where(and(
    eq(inventoryItems.cardId, cardId),
    eq(inventoryItems.condition, condition),
    eq(inventoryItems.isActive, true),
  )).limit(1)

  if (existing) {
    const newQty = existing.quantity + quantity
    const newCost = newQty > 0
      ? round2((existing.costPrice * existing.quantity + costPrice * quantity) / newQty)
      : existing.costPrice
    const [updated] = await db.update(inventoryItems)
      .set({ quantity: newQty, costPrice: newCost })
      .where(eq(inventoryItems.id, existing.id))
      .returning()
    return NextResponse.json(updated, { status: 200 })
  }

  const [item] = await db.insert(inventoryItems).values({
    cardId,
    condition,
    quantity,
    costPrice: round2(costPrice),
    sellPriceOverride: sellPriceOverride ?? null,
    qrCode: generateQRId(),
    location: location ?? null,
    defectNotes: defectNotes ?? null,
  }).returning()

  return NextResponse.json(item, { status: 201 })
}
