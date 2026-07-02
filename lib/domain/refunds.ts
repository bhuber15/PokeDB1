import { eq, inArray, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, inventoryItems, refunds, refundItems, creditLedger, customers } from '@/lib/db/schema'
import { DomainError } from './errors'

export interface CreateRefundInput {
  staffId: number
  saleId: number
  method: 'cash' | 'store_credit'
  reason?: string
  items: { saleItemId: number; quantity: number }[]
  customerId?: number
}

const METHODS = new Set(['cash', 'store_credit'])
const round2 = (n: number) => Math.round(n * 100) / 100

export async function createRefund(
  input: CreateRefundInput,
  dbc: Db = db,
): Promise<{ refundId: number; amount: number }> {
  if (!Number.isInteger(input.saleId)) throw new DomainError('INVALID_INPUT', 'Invalid saleId')
  if (!METHODS.has(input.method)) throw new DomainError('INVALID_INPUT', 'Invalid method')
  if (!input.items?.length) throw new DomainError('INVALID_INPUT', 'No items to refund')
  for (const line of input.items) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new DomainError('INVALID_INPUT', 'Invalid quantity')
    }
  }
  if (input.method === 'store_credit' && !input.customerId) {
    throw new DomainError('INVALID_INPUT', 'customerId required for store credit refunds')
  }

  const [sale] = await dbc.select().from(sales).where(eq(sales.id, input.saleId)).limit(1)
  if (!sale) throw new DomainError('NOT_FOUND', 'Sale not found')

  if (input.method === 'store_credit') {
    const [customer] = await dbc.select().from(customers).where(eq(customers.id, input.customerId!)).limit(1)
    if (!customer) throw new DomainError('NOT_FOUND', 'Customer not found')
  }

  const saleItemIds = input.items.map(l => l.saleItemId)
  const originalItems = await dbc.select().from(saleItems).where(inArray(saleItems.id, saleItemIds))
  const byId = new Map(originalItems.map(i => [i.id, i]))

  return dbc.transaction(async (tx) => {
    let netAmount = 0 // pre-discount/VAT amount being refunded, drives proportional reversal
    // Tracks quantity already claimed by earlier lines in *this same request* that reference
    // the same saleItemId — the refundItems rows for those lines aren't inserted until after
    // this loop, so the DB SUM below wouldn't see them without this in-memory tally.
    const claimedThisRequest = new Map<number, number>()

    for (const line of input.items) {
      const original = byId.get(line.saleItemId)
      if (!original || original.saleId !== sale.id) {
        throw new DomainError('BAD_LINE', `Line ${line.saleItemId}: not part of this sale`, { saleItemId: line.saleItemId })
      }

      const [{ refunded }] = await tx.select({
        refunded: sql<number>`COALESCE(SUM(quantity), 0)`,
      }).from(refundItems).where(eq(refundItems.saleItemId, line.saleItemId))

      const alreadyClaimed = claimedThisRequest.get(line.saleItemId) ?? 0
      const remaining = original.quantity - refunded - alreadyClaimed
      if (line.quantity > remaining) {
        throw new DomainError('BAD_LINE', `Line ${line.saleItemId}: only ${remaining} left to refund`, { saleItemId: line.saleItemId, remaining })
      }
      claimedThisRequest.set(line.saleItemId, alreadyClaimed + line.quantity)

      netAmount += original.priceAtSale * line.quantity

      if (original.inventoryItemId) {
        await tx.update(inventoryItems)
          .set({ quantity: sql`quantity + ${line.quantity}` })
          .where(eq(inventoryItems.id, original.inventoryItemId))
      }
    }

    netAmount = round2(netAmount)
    // Reverse VAT/discount proportionally to how this sale's total related to its subtotal,
    // so a partial refund doesn't over- or under-credit versus what was actually charged.
    const chargedRatio = sale.subtotal > 0 ? sale.total / sale.subtotal : 1
    const amount = round2(netAmount * chargedRatio)

    const [refund] = await tx.insert(refunds).values({
      saleId: sale.id,
      staffId: input.staffId,
      method: input.method,
      amount,
      reason: input.reason ?? null,
    }).returning()

    for (const line of input.items) {
      await tx.insert(refundItems).values({
        refundId: refund.id,
        saleItemId: line.saleItemId,
        quantity: line.quantity,
      })
    }

    if (input.method === 'store_credit') {
      await tx.insert(creditLedger).values({
        customerId: input.customerId!,
        delta: amount,
        reason: 'refund',
        refType: 'sale',
        refId: sale.id,
        staffId: input.staffId,
      })
    }

    return { refundId: refund.id, amount }
  })
}
