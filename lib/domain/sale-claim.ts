// lib/domain/sale-claim.ts
//
// Atomic claim on a sale for mutating flows (void, refund). Reversing a sale
// must be guarded INSIDE the transaction: a pre-check read outside it can race
// a concurrent void and double-reverse (stock restored twice, credit returned
// and refund paid). Every domain function that reverses stock or credit for a
// sale must open its transaction with this claim — do not reintroduce the
// pre-check-only style.

import { and, eq, isNull } from 'drizzle-orm'
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core'
import type { Db } from '@/lib/db'
import { sales } from '@/lib/db/schema'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Claim `saleId` if it is not voided: a guarded UPDATE whose WHERE re-checks
 * voided_at atomically inside `tx`. Returns false when the sale is (or just
 * became) voided — the caller must throw and roll back. `set` lets voidSale
 * write the void columns in the same statement; refunds pass nothing (the
 * `id: saleId` self-assignment makes the UPDATE a no-op write that still
 * takes the row through the guard).
 */
export async function claimUnvoidedSale(
  tx: Tx,
  saleId: number,
  set: SQLiteUpdateSetSource<typeof sales> = {},
): Promise<boolean> {
  const claimed = await tx.update(sales)
    .set({ id: saleId, ...set })
    .where(and(eq(sales.id, saleId), isNull(sales.voidedAt)))
    .returning({ id: sales.id })
  return claimed.length > 0
}
