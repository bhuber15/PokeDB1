// lib/domain/voids.ts
//
// Void a sale: a same-day, full reversal for staff mis-rings — distinct from
// a customer refund. The sale row is kept (audit trail: who voided, when,
// why) but excluded from every report aggregate. Stock is restored and a
// store-credit charge is returned via the ledger. Sales with refunds, or
// from a previous day, must go through the refund path instead.

import { and, eq, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, salePayments, inventoryItems, refunds, creditLedger } from '@/lib/db/schema'
import { isSameLondonDay } from '@/lib/trading-day'
import { claimUnvoidedSale } from './sale-claim'
import { DomainError } from './errors'

export interface VoidSaleInput {
  staffId: number
  saleId: number
  reason?: string
}

export async function voidSale(
  input: VoidSaleInput,
  dbc: Db = db,
): Promise<{ saleId: number; total: number }> {
  if (!Number.isInteger(input.saleId)) throw new DomainError('INVALID_INPUT', 'Invalid saleId')

  const [sale] = await dbc.select().from(sales).where(eq(sales.id, input.saleId)).limit(1)
  if (!sale) throw new DomainError('NOT_FOUND', 'Sale not found')
  if (sale.voidedAt) throw new DomainError('SALE_VOIDED', 'Sale is already voided')

  // Same-day only, on the Europe/London trading day (createdAt is UTC text;
  // a UTC comparison would strand BST sales rung 00:00–00:59 local).
  if (!isSameLondonDay(sale.createdAt)) {
    throw new DomainError('VOID_NOT_ALLOWED', 'Only same-day sales can be voided — use a refund instead')
  }

  const lines = await dbc.select().from(saleItems).where(eq(saleItems.saleId, sale.id))

  await dbc.transaction(async (tx) => {
    // Claim the void first: the WHERE voided_at IS NULL guard makes a
    // concurrent double-void lose here and roll back its stock restore.
    const claimed = await claimUnvoidedSale(tx, sale.id, {
      voidedAt: sql`(datetime('now'))`,
      voidedByStaffId: input.staffId,
      voidReason: input.reason?.trim() || null,
    })
    if (!claimed) throw new DomainError('SALE_VOIDED', 'Sale is already voided')

    // Refund check inside the transaction so a racing refund can't slip in
    // between the pre-checks and the reversal.
    const [{ refunded }] = await tx.select({ refunded: sql<number>`COUNT(*)` })
      .from(refunds).where(eq(refunds.saleId, sale.id))
    if (refunded > 0) {
      throw new DomainError('VOID_NOT_ALLOWED', 'Sale has refunds — void is not possible, refund the remainder instead')
    }

    for (const line of lines) {
      if (line.inventoryItemId) {
        await tx.update(inventoryItems)
          .set({ quantity: sql`quantity + ${line.quantity}` })
          .where(eq(inventoryItems.id, line.inventoryItemId))
      }
    }

    // Return the store-credit portion (whole total on a plain store-credit
    // sale, the credit line of a split — from sale_payments either way).
    if (sale.customerId) {
      const [{ creditPaid }] = await tx.select({
        creditPaid: sql<number>`COALESCE(SUM(${salePayments.amount}), 0)`,
      }).from(salePayments).where(and(
        eq(salePayments.saleId, sale.id),
        eq(salePayments.method, 'store_credit'),
      ))
      if (creditPaid > 0) {
        await tx.insert(creditLedger).values({
          customerId: sale.customerId,
          delta: creditPaid,
          reason: 'void',
          refType: 'sale',
          refId: sale.id,
          staffId: input.staffId,
        })
      }
    }
  })

  return { saleId: sale.id, total: sale.total }
}
