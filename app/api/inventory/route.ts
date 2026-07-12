import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { inventoryItems, cards, priceCache } from '@/lib/db/schema'
import { eq, and, like } from 'drizzle-orm'
import { generateQRId } from '@/lib/qr'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'

const createInventoryBody = z.object({
  cardId: z.number().int(),
  condition: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG']),
  quantity: z.number().int(),
  costPrice: z.number().int().nonnegative(), // pence
  sellPriceOverride: z.number().int().nonnegative().nullable().optional(), // pence
  location: z.string().nullable().optional(),
  defectNotes: z.string().nullable().optional(),
})

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

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
      eq(inventoryItems.cardId, parseIdParam(cardId, 'cardId')),
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
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

  const { cardId, condition, quantity, costPrice, sellPriceOverride, location, defectNotes } =
    await parseBody(req, createInventoryBody)

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
      ? Math.round(((existing.costPrice ?? 0) * existing.quantity + costPrice * quantity) / newQty)
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
    costPrice,
    sellPriceOverride: sellPriceOverride ?? null,
    qrCode: generateQRId(),
    location: location ?? null,
    defectNotes: defectNotes ?? null,
  }).returning()

  return NextResponse.json(item, { status: 201 })
})
