import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { inventoryItems, cards, priceCache, products } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { cardHasMarketPrice, intakeInventory, redactInventoryCosts, searchSellables } from '@/lib/domain/inventory'
import { DomainError } from '@/lib/domain/errors'
import { isGame } from '@/lib/games'
import { CONDITIONS } from '@/lib/pricing'

const createInventoryBody = z.object({
  cardId: z.number().int(),
  condition: z.enum(CONDITIONS),
  quantity: z.number().int().positive(),
  costPrice: z.number().int().nonnegative(), // pence
  sellPriceOverride: z.number().int().nonnegative().nullable().optional(), // pence
  location: z.string().nullable().optional(),
  defectNotes: z.string().nullable().optional(),
})

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  const session = requireStaff(await getSession(await currentTenantId()))
  // Cost basis is admin-only (F8): redact before the rows leave the server.
  const respond = <T extends { item: { costPrice: number | null } }>(rows: T[]) =>
    NextResponse.json(redactInventoryCosts(rows, session.staffRole))

  const cardId = req.nextUrl.searchParams.get('cardId')
  const qrCode = req.nextUrl.searchParams.get('qrCode')
  const q = req.nextUrl.searchParams.get('q')?.trim()

  const base = db
    .select({ item: inventoryItems, card: cards, product: products, prices: priceCache })
    .from(inventoryItems)
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .leftJoin(products, eq(inventoryItems.productId, products.id))
    .leftJoin(priceCache, eq(cards.id, priceCache.cardId))

  if (cardId) {
    return respond(await base.where(and(
      eq(inventoryItems.cardId, parseIdParam(cardId, 'cardId')),
      eq(inventoryItems.isActive, true),
    )))
  }
  if (qrCode) {
    return respond(await base.where(and(
      eq(inventoryItems.qrCode, qrCode),
      eq(inventoryItems.isActive, true),
    )))
  }
  if (q) {
    // POS search (cards + products + barcode fast-path) — logic in the domain.
    const gameParam = req.nextUrl.searchParams.get('game')
    const game = gameParam && isGame(gameParam) ? gameParam : undefined
    return respond(await searchSellables(q, db, game))
  }
  return respond(await base.where(eq(inventoryItems.isActive, true)))
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  const session = requireStaff(await getSession(await currentTenantId()))

  const body = await parseBody(req, createInventoryBody)

  // Same rule as applyInventoryPatch: staff may give an unpriced card its
  // first price, but overriding a market-priced card is an admin call.
  // (Cost entry stays staff-allowed — intake requires the price paid.)
  if (session.staffRole !== 'admin' && body.sellPriceOverride != null
    && await cardHasMarketPrice(body.cardId, db)) {
    throw new DomainError('FORBIDDEN', 'Only admins can set a price override on a market-priced card')
  }

  // Merge on intake: one active row per card+condition — the atomic
  // update-or-insert lives in lib/domain/inventory.ts.
  const { item, merged } = await intakeInventory(body, db)
  return NextResponse.json(item, { status: merged ? 200 : 201 })
})
