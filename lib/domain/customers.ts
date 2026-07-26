// lib/domain/customers.ts
//
// Customer purchase history: recent sales with their line items. Voided sales
// are mis-rings, not purchases — they are excluded here (their store-credit
// reversals still show in the credit ledger, which is the bookkeeping truth).

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, inventoryItems, cards } from '@/lib/db/schema'

export interface CustomerPurchase {
  id: number
  total: number
  paymentMethod: string
  createdAt: string
  items: {
    saleId: number
    quantity: number
    priceAtSale: number
    cardName: string | null
    cardSetName: string | null
    cardSetNumber: string | null
  }[]
}

export async function getCustomerPurchases(
  customerId: number,
  dbc: Db = db,
): Promise<CustomerPurchase[]> {
  const saleRows = await dbc.select().from(sales)
    .where(and(eq(sales.customerId, customerId), isNull(sales.voidedAt)))
    .orderBy(desc(sales.createdAt))
    .limit(50)

  // Fetch the line items for those sales and group them back by sale.
  const saleIds = saleRows.map(s => s.id)
  const itemRows = saleIds.length === 0 ? [] : await dbc.select({
    saleId: saleItems.saleId,
    quantity: saleItems.quantity,
    priceAtSale: saleItems.priceAtSale,
    cardName: cards.name,
    cardSetName: cards.setName,
    cardSetNumber: cards.setNumber,
  }).from(saleItems)
    .leftJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .where(inArray(saleItems.saleId, saleIds))
  const itemsBySale = new Map<number, CustomerPurchase['items']>()
  for (const row of itemRows) {
    const list = itemsBySale.get(row.saleId) ?? []
    list.push(row)
    itemsBySale.set(row.saleId, list)
  }

  return saleRows.map(s => ({
    id: s.id,
    total: s.total,
    paymentMethod: s.paymentMethod,
    createdAt: s.createdAt,
    items: itemsBySale.get(s.id) ?? [],
  }))
}
