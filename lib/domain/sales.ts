import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, inventoryItems, priceCache, creditLedger, customers } from '@/lib/db/schema'
import { calculateSellPrice, pickMarketPrice } from '@/lib/pricing'
import { getSettings } from '@/lib/settings'
import { DomainError } from './errors'

export interface CreateSaleInput {
  staffId: number
  items: { inventoryItemId: number; quantity: number }[]
  paymentMethod: 'cash' | 'card' | 'store_credit' | 'other'
  discount: number
  customerId?: number
  expectedTotal: number
}

const PAYMENT_METHODS = new Set(['cash', 'card', 'store_credit', 'other'])

export async function createSale(
  input: CreateSaleInput,
  dbc: Db = db,
): Promise<{ saleId: number; total: number }> {
  if (!input.items?.length) throw new DomainError('INVALID_INPUT', 'No items')
  if (!PAYMENT_METHODS.has(input.paymentMethod)) throw new DomainError('INVALID_INPUT', 'Invalid payment method')
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new DomainError('INVALID_INPUT', 'Invalid quantity')
    }
  }
  if (input.paymentMethod === 'store_credit' && !input.customerId) {
    throw new DomainError('INVALID_INPUT', 'customerId required for store credit')
  }

  const settings = await getSettings(dbc)

  // Server-canonical pricing: override, else market × margin. The client never sends prices.
  const ids = input.items.map(i => i.inventoryItemId)
  const rows = await dbc.select({ item: inventoryItems, prices: priceCache })
    .from(inventoryItems)
    .leftJoin(priceCache, eq(priceCache.cardId, inventoryItems.cardId))
    .where(inArray(inventoryItems.id, ids))
  const byId = new Map(rows.map(r => [r.item.id, r]))

  const lines = input.items.map(item => {
    const row = byId.get(item.inventoryItemId)
    if (!row || !row.item.isActive) {
      throw new DomainError('NOT_FOUND', `Inventory item ${item.inventoryItemId} not found`, { inventoryItemId: item.inventoryItemId })
    }
    const unitPrice = calculateSellPrice(
      pickMarketPrice(row.prices, settings.primaryPriceSource),
      row.item.sellPriceOverride,
      settings.marginMultiplier,
    )
    if (unitPrice == null) {
      throw new DomainError('NO_PRICE', `No price for item ${item.inventoryItemId} — set a price override`, { inventoryItemId: item.inventoryItemId })
    }
    return { ...item, unitPrice, costAtSale: row.item.costPrice }
  })

  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0)
  const discount = Math.min(Math.max(0, input.discount ?? 0), subtotal)
  const afterDiscount = subtotal - discount
  const vatAmount = settings.vatScheme === 'standard' ? Math.round(afterDiscount * 0.2) : 0
  const total = afterDiscount + vatAmount

  if (total !== input.expectedTotal) {
    throw new DomainError('PRICE_CHANGED', `Prices changed: server total is ${total}`, { total, expectedTotal: input.expectedTotal })
  }

  if (input.paymentMethod === 'store_credit') {
    const [customer] = await dbc.select().from(customers).where(eq(customers.id, input.customerId!)).limit(1)
    if (!customer) throw new DomainError('NOT_FOUND', 'Customer not found')
  }

  const saleId = await dbc.transaction(async (tx) => {
    // Guarded decrements first — stock can never go negative; any failure rolls all back.
    for (const line of lines) {
      const decremented = await tx.update(inventoryItems)
        .set({ quantity: sql`quantity - ${line.quantity}` })
        .where(and(
          eq(inventoryItems.id, line.inventoryItemId),
          gte(inventoryItems.quantity, line.quantity),
        ))
        .returning({ id: inventoryItems.id })
      if (decremented.length === 0) {
        throw new DomainError('INSUFFICIENT_STOCK', `Insufficient stock for item ${line.inventoryItemId}`, { inventoryItemId: line.inventoryItemId })
      }
    }

    // Balance check inside the transaction so concurrent spends can't overdraw.
    if (input.paymentMethod === 'store_credit') {
      const [{ balance }] = await tx.select({ balance: sql<number>`COALESCE(SUM(delta), 0)` })
        .from(creditLedger)
        .where(eq(creditLedger.customerId, input.customerId!))
      if (balance < total) {
        throw new DomainError('INSUFFICIENT_CREDIT', 'Insufficient store credit', { balance, total })
      }
    }

    const [sale] = await tx.insert(sales).values({
      staffId: input.staffId,
      subtotal,
      discountAmount: discount,
      vatAmount,
      vatScheme: settings.vatScheme,
      total,
      paymentMethod: input.paymentMethod,
    }).returning()

    for (const line of lines) {
      await tx.insert(saleItems).values({
        saleId: sale.id,
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        priceAtSale: line.unitPrice,
        costAtSale: line.costAtSale,
      })
    }

    if (input.paymentMethod === 'store_credit') {
      await tx.insert(creditLedger).values({
        customerId: input.customerId!,
        delta: -total,
        reason: 'sale',
        refType: 'sale',
        refId: sale.id,
        staffId: input.staffId,
      })
    }

    return sale.id
  })

  return { saleId, total }
}
