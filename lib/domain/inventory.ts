import { eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { inventoryItems, stockAdjustments } from '@/lib/db/schema'
import { DomainError } from './errors'
import type { AdjustmentReason } from '@/lib/adjustment-reasons'

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

// Applies a manual inventory edit. A quantity change is a stock movement with
// no sale/refund/buy behind it, so it must carry a reason and leaves an
// append-only stock_adjustments row for the audit trail.
export async function applyInventoryPatch(
  inventoryItemId: number,
  staffId: number,
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

  return dbc.transaction(async (tx) => {
    const [current] = await tx.select().from(inventoryItems)
      .where(eq(inventoryItems.id, inventoryItemId)).limit(1)
    if (!current) throw new DomainError('NOT_FOUND', 'Inventory item not found')

    if (patch.quantity !== undefined && patch.quantity !== current.quantity) {
      if (!reason) {
        throw new DomainError('INVALID_INPUT', 'Quantity changes require a reason (recount / damage / lost / other)')
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
