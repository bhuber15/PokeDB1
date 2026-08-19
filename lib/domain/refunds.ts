import { eq, inArray, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, inventoryItems, refunds, refundItems, creditLedger, customers } from '@/lib/db/schema'
import { claimUnvoidedSale } from './sale-claim'
import { DomainError } from './errors'

export interface CreateRefundInput {
  staffId: number
  saleId: number
  method: 'cash' | 'card' | 'store_credit'
  reason?: string
  items: { saleItemId: number; quantity: number }[]
  customerId?: number
}

// 'card' records that the terminal refunded the customer — PokeDB moves no
// money for it, exactly like card sales. Only 'cash' touches the drawer and
// only 'store_credit' touches the ledger.
const METHODS = new Set(['cash', 'card', 'store_credit'])

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
  const [sale] = await dbc.select().from(sales).where(eq(sales.id, input.saleId)).limit(1)
  if (!sale) throw new DomainError('NOT_FOUND', 'Sale not found')
  if (sale.voidedAt) throw new DomainError('SALE_VOIDED', 'Sale is voided — nothing to refund')

  // Store-credit refunds default to the sale's customer, so attributed sales
  // work without the client re-sending one; walk-ins must name a customer.
  const creditCustomerId = input.customerId ?? sale.customerId ?? undefined
  if (input.method === 'store_credit') {
    if (!creditCustomerId) {
      throw new DomainError('INVALID_INPUT', 'customerId required for store credit refunds')
    }
    const [customer] = await dbc.select().from(customers).where(eq(customers.id, creditCustomerId)).limit(1)
    if (!customer) throw new DomainError('NOT_FOUND', 'Customer not found')
  }

  const saleItemIds = input.items.map(l => l.saleItemId)
  const originalItems = await dbc.select().from(saleItems).where(inArray(saleItems.id, saleItemIds))
  const byId = new Map(originalItems.map(i => [i.id, i]))

  return dbc.transaction(async (tx) => {
    // Claim the sale against a concurrent void before touching anything: the
    // voidedAt pre-check above ran outside this transaction, so a void landing
    // in between would otherwise be reversed twice (stock restored by both,
    // credit returned and refund paid).
    const claimed = await claimUnvoidedSale(tx, sale.id)
    if (!claimed) throw new DomainError('SALE_VOIDED', 'Sale is voided — nothing to refund')

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

    // Reverse VAT/discount proportionally to how this sale's total related to its subtotal,
    // so a partial refund doesn't over- or under-credit versus what was actually charged.
    // The division doesn't stay integer, so the result is rounded to the nearest pence.
    const chargedRatio = sale.subtotal > 0 ? sale.total / sale.subtotal : 1
    const uncapped = Math.round(netAmount * chargedRatio)

    // Residual cap: total refunded can never exceed what was charged (sale.total).
    // Without this, rounding across successive single-unit refunds can compound to 1p over.
    const [{ refundedSoFar }] = await tx.select({
      refundedSoFar: sql<number>`COALESCE(SUM(amount), 0)`,
    }).from(refunds).where(eq(refunds.saleId, sale.id))
    const amount = Math.max(0, Math.min(uncapped, sale.total - refundedSoFar))

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
        customerId: creditCustomerId!,
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
