import { and, eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { buyTransactions, buyItems, inventoryItems, creditLedger, customers } from '@/lib/db/schema'
import { generateQRId } from '@/lib/qr'
import { DomainError } from './errors'

export interface CreateBuyInput {
  staffId: number
  items: { cardId: number; condition: string; quantity: number; payPrice: number }[]
  method: 'cash' | 'store_credit'
  customerId?: number
}

const CONDITIONS = new Set(['NM', 'LP', 'MP', 'HP', 'DMG'])

export async function createBuy(
  input: CreateBuyInput,
  dbc: Db = db,
): Promise<{ buyId: number; total: number }> {
  if (!input.items?.length) throw new DomainError('INVALID_INPUT', 'No items')
  if (!['cash', 'store_credit'].includes(input.method)) throw new DomainError('INVALID_INPUT', 'Invalid method')
  if (input.method === 'store_credit' && !input.customerId) {
    throw new DomainError('INVALID_INPUT', 'Store credit requires a customer')
  }
  for (const it of input.items) {
    if (!CONDITIONS.has(it.condition)) throw new DomainError('INVALID_INPUT', 'Invalid condition')
    if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new DomainError('INVALID_INPUT', 'Invalid quantity')
    if (!(it.payPrice >= 0)) throw new DomainError('INVALID_INPUT', 'Invalid pay price')
    if (!Number.isInteger(it.cardId) || it.cardId < 1) throw new DomainError('INVALID_INPUT', 'Invalid cardId')
  }
  const total = input.items.reduce((s, i) => s + i.payPrice * i.quantity, 0)

  if (input.method === 'store_credit') {
    const [customer] = await dbc.select().from(customers).where(eq(customers.id, input.customerId!)).limit(1)
    if (!customer) throw new DomainError('NOT_FOUND', 'Customer not found')
  }

  const buyId = await dbc.transaction(async (tx) => {
    const [buy] = await tx.insert(buyTransactions).values({
      staffId: input.staffId,
      customerId: input.customerId ?? null,
      method: input.method,
      total,
    }).returning()

    for (const it of input.items) {
      // Merge on intake: increment an existing active row for this card+condition,
      // blending the cost basis; otherwise create a new stock row.
      const [existing] = await tx.select().from(inventoryItems).where(and(
        eq(inventoryItems.cardId, it.cardId),
        eq(inventoryItems.condition, it.condition),
        eq(inventoryItems.isActive, true),
      )).limit(1)

      let inventoryItemId: number
      if (existing) {
        const newQty = existing.quantity + it.quantity
        // Division can produce a fraction of a pence even with integer inputs — round to nearest pence.
        const newCost = Math.round((existing.costPrice * existing.quantity + it.payPrice * it.quantity) / newQty)
        await tx.update(inventoryItems)
          .set({ quantity: newQty, costPrice: newCost })
          .where(eq(inventoryItems.id, existing.id))
        inventoryItemId = existing.id
      } else {
        const [inv] = await tx.insert(inventoryItems).values({
          cardId: it.cardId,
          condition: it.condition,
          quantity: it.quantity,
          costPrice: it.payPrice,
          qrCode: generateQRId(),
        }).returning()
        inventoryItemId = inv.id
      }

      await tx.insert(buyItems).values({
        buyId: buy.id,
        cardId: it.cardId,
        inventoryItemId,
        condition: it.condition,
        quantity: it.quantity,
        payPrice: it.payPrice,
      })
    }

    if (input.method === 'store_credit') {
      await tx.insert(creditLedger).values({
        customerId: input.customerId!,
        delta: total,
        reason: 'buylist',
        refType: 'buy',
        refId: buy.id,
        staffId: input.staffId,
      })
    }
    return buy.id
  })

  return { buyId, total }
}
