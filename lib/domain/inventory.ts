import { eq, or, like, and, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { inventoryItems, stockAdjustments, cards, products, priceCache } from '@/lib/db/schema'
import { DomainError } from './errors'
import { EAN_RE } from '@/lib/product-categories'
import { generateQRId } from '@/lib/qr'
import { pickMarketPrice } from '@/lib/pricing'
import { getSettings } from '@/lib/settings'
import { ADJUSTMENT_REASONS, type AdjustmentReason } from '@/lib/adjustment-reasons'
import type { Condition } from '@/lib/pricing'
import { type Game } from '@/lib/games'

export { ADJUSTMENT_REASONS, type AdjustmentReason } from '@/lib/adjustment-reasons'

export interface InventoryPatch {
  quantity?: number
  condition?: string
  costPrice?: number
  sellPriceOverride?: number | null
  location?: string | null
  defectNotes?: string | null
  lowStockThreshold?: number | null
}

// True when the shop's market source (with its fallback) prices this card —
// i.e. createSale could quote it without an override. The same
// pickMarketPrice call the POS and createSale use, so "unpriced" means the
// same thing everywhere (a cached 0 is "no data", not a price).
export async function cardHasMarketPrice(cardId: number, dbc: Db = db): Promise<boolean> {
  const [row] = await dbc.select().from(priceCache)
    .where(eq(priceCache.cardId, cardId)).limit(1)
  if (!row) return false
  const settings = await getSettings(dbc)
  return pickMarketPrice(row, settings.primaryPriceSource) != null
}

// Staff cannot read costPrice (redactInventoryCosts below), so they must not
// write it either. Sell-price overrides are likewise an admin call, with one
// deliberate exception: the POS quick-set. An item with no market price and
// no override cannot be sold at all (createSale throws NO_PRICE), so staff
// may set its FIRST price at the till. Changing or clearing any existing
// price — including undercutting a market-priced card — stays admin-only.
async function assertStaffMayPatchPrices(
  inventoryItemId: number,
  patch: InventoryPatch,
  dbc: Db,
): Promise<void> {
  if (patch.costPrice !== undefined) {
    throw new DomainError('FORBIDDEN', 'Only admins can change cost prices')
  }
  if (patch.sellPriceOverride === undefined) return
  const [current] = await dbc.select().from(inventoryItems)
    .where(eq(inventoryItems.id, inventoryItemId)).limit(1)
  if (!current) throw new DomainError('NOT_FOUND', 'Inventory item not found')
  if (patch.sellPriceOverride == null || current.sellPriceOverride != null
    || (current.cardId != null && await cardHasMarketPrice(current.cardId, dbc))) {
    throw new DomainError('FORBIDDEN', 'Only admins can change price overrides')
  }
}

// Applies a manual inventory edit. A quantity change is a stock movement with
// no sale/refund/buy behind it, so it must carry a reason and leaves an
// append-only stock_adjustments row for the audit trail.
export async function applyInventoryPatch(
  inventoryItemId: number,
  staffId: number,
  staffRole: 'admin' | 'staff' | undefined,
  patch: InventoryPatch,
  reason: AdjustmentReason | undefined,
  dbc: Db = db,
) {
  const updates = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  )
  if (Object.keys(updates).length === 0) {
    throw new DomainError('INVALID_INPUT', 'No valid fields to update')
  }

  if (staffRole !== 'admin') await assertStaffMayPatchPrices(inventoryItemId, patch, dbc)

  return dbc.transaction(async (tx) => {
    const [current] = await tx.select().from(inventoryItems)
      .where(eq(inventoryItems.id, inventoryItemId)).limit(1)
    if (!current) throw new DomainError('NOT_FOUND', 'Inventory item not found')

    if (patch.quantity !== undefined && patch.quantity !== current.quantity) {
      if (!reason) {
        throw new DomainError('INVALID_INPUT', `Quantity changes require a reason (${ADJUSTMENT_REASONS.join(' / ')})`)
      }
      await tx.insert(stockAdjustments).values({
        inventoryItemId,
        staffId,
        delta: patch.quantity - current.quantity,
        reason,
      })
    }

    const [updated] = await tx.update(inventoryItems)
      .set(updates)
      .where(eq(inventoryItems.id, inventoryItemId))
      .returning()
    return updated
  })
}

// ---------------------------------------------------------------------------
// intakeInventory (POST /api/inventory)
// ---------------------------------------------------------------------------

export interface IntakeInput {
  cardId: number
  condition: Condition
  quantity: number
  costPrice: number
  sellPriceOverride?: number | null
  location?: string | null
  defectNotes?: string | null
}

// Stock intake: one active row per card+condition. If one exists, add to its
// quantity and blend the cost basis (weighted average across every copy).
// The merge is a single guarded UPDATE whose right-hand sides read the
// existing row inside SQL — computing the new values in JS from a prior
// SELECT lets two concurrent intakes overwrite each other, losing stock and
// corrupting the blended cost.
export async function intakeInventory(input: IntakeInput, dbc: Db = db) {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new DomainError('INVALID_INPUT', 'Invalid quantity')
  }
  if (!Number.isInteger(input.costPrice) || input.costPrice < 0) {
    throw new DomainError('INVALID_INPUT', 'Invalid cost price')
  }
  const intakeTotal = input.costPrice * input.quantity // pence paid for this intake, integer by the guards above
  const [merged] = await dbc.update(inventoryItems)
    .set({
      quantity: sql`${inventoryItems.quantity} + ${input.quantity}`,
      costPrice: sql`CAST(ROUND((COALESCE(${inventoryItems.costPrice}, 0) * ${inventoryItems.quantity} + ${intakeTotal}) * 1.0 / (${inventoryItems.quantity} + ${input.quantity})) AS INTEGER)`,
    })
    .where(and(
      eq(inventoryItems.cardId, input.cardId),
      eq(inventoryItems.condition, input.condition),
      eq(inventoryItems.isActive, true),
    ))
    .returning()
  if (merged) return { item: merged, merged: true }

  const [item] = await dbc.insert(inventoryItems).values({
    cardId: input.cardId,
    condition: input.condition,
    quantity: input.quantity,
    costPrice: input.costPrice,
    sellPriceOverride: input.sellPriceOverride ?? null,
    qrCode: generateQRId(),
    location: input.location ?? null,
    defectNotes: input.defectNotes ?? null,
  }).returning()
  return { item, merged: false }
}

// ---------------------------------------------------------------------------
// searchSellables (POS search)
// ---------------------------------------------------------------------------

// POS search: active stock whose card OR product name matches; an all-digits
// query tries the product barcode first so a USB scanner (types digits +
// Enter) lands its item instantly and exactly. An optional game scopes the
// name/product match to one TCG — undefined searches across all games.
export async function searchSellables(q: string, dbc: Db = db, game?: Game) {
  const scope = game ? [eq(cards.game, game)] : []
  const base = () => dbc
    .select({ item: inventoryItems, card: cards, product: products, prices: priceCache })
    .from(inventoryItems)
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .leftJoin(products, eq(inventoryItems.productId, products.id))
    .leftJoin(priceCache, eq(cards.id, priceCache.cardId))
  if (EAN_RE.test(q)) {
    const exact = await base().where(and(eq(inventoryItems.isActive, true), eq(products.ean, q)))
    if (exact.length > 0) return exact
  }
  return base().where(and(
    eq(inventoryItems.isActive, true),
    // Scope the game filter to the card/alias match only — sealed products have
    // no game (cards.game is NULL on a product row), so ANDing the scope onto
    // the whole OR would silently hide every product under a game selection.
    or(
      and(or(like(cards.name, `%${q}%`), like(cards.aliasName, `%${q}%`)), ...scope),
      like(products.name, `%${q}%`),
    ),
  ))
}

// ---------------------------------------------------------------------------
// redactInventoryCosts (F8)
// ---------------------------------------------------------------------------

// Cost price is admin-only: staff browsing inventory (or the POS search,
// which shares the endpoint) must not see the shop's cost basis. Applied at
// the API edge so the data never leaves the server for non-admins.
export function redactInventoryCosts<T extends { item: { costPrice: number | null } }>(
  rows: T[],
  role: 'admin' | 'staff' | undefined,
): T[] {
  if (role === 'admin') return rows
  return rows.map(r => ({ ...r, item: { ...r.item, costPrice: null } }))
}
