import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { inventoryItems, cards, priceCache } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { generateQRId } from '@/lib/qr'
import { getSession } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cardId = req.nextUrl.searchParams.get('cardId')
  const qrCode = req.nextUrl.searchParams.get('qrCode')

  const base = db
    .select({ item: inventoryItems, card: cards, prices: priceCache })
    .from(inventoryItems)
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .leftJoin(priceCache, eq(cards.id, priceCache.cardId))

  if (cardId) {
    return NextResponse.json(await base.where(eq(inventoryItems.cardId, parseInt(cardId))))
  }
  if (qrCode) {
    return NextResponse.json(await base.where(eq(inventoryItems.qrCode, qrCode)))
  }
  return NextResponse.json(await base)
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.isOwnerLoggedIn) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { cardId, condition, quantity, costPrice, sellPriceOverride, location, defectNotes } = await req.json()

  if (!cardId || !condition || quantity == null || costPrice == null) {
    return NextResponse.json({ error: 'cardId, condition, quantity and costPrice are required' }, { status: 400 })
  }

  const [item] = await db.insert(inventoryItems).values({
    cardId,
    condition,
    quantity,
    costPrice,
    sellPriceOverride: sellPriceOverride ?? null,
    qrCode: generateQRId(),
    location: location ?? null,
    defectNotes: defectNotes ?? null,
  }).returning()

  return NextResponse.json(item, { status: 201 })
}
