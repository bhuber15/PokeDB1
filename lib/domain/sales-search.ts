// lib/domain/sales-search.ts
//
// Sales history search for the returns desk: find a sale by receipt number,
// card name, or customer name, optionally within a date range. Voided sales
// are included (flagged by sale.voidedAt) — staff searching for a receipt
// need to see that it was voided rather than a hole.

import { and, desc, eq, exists, gte, inArray, like, lt, or, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, inventoryItems, cards, staff, customers } from '@/lib/db/schema'
import { DomainError } from './errors'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface SaleSearchFilters {
  q?: string    // receipt number, or a card/customer name fragment
  from?: string // YYYY-MM-DD
  to?: string   // YYYY-MM-DD
  limit?: number
}

export interface SaleSearchRow {
  sale: {
    id: number
    total: number
    paymentMethod: string
    discountAmount: number
    createdAt: string
    voidedAt: string | null
  }
  staffName: string | null
  customerName: string | null
  itemsSummary: string
}

export async function searchSales(filters: SaleSearchFilters, dbc: Db = db): Promise<SaleSearchRow[]> {
  const q = filters.q?.trim() ?? ''
  const { from, to } = filters
  if (!q && !from && !to) throw new DomainError('INVALID_INPUT', 'Provide a search term or a date range')
  for (const [field, value] of [['from', from], ['to', to]] as const) {
    if (value != null && !DATE_RE.test(value)) {
      throw new DomainError('INVALID_INPUT', `${field} must be YYYY-MM-DD`)
    }
  }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100)

  const conditions = []
  if (from) conditions.push(gte(sales.createdAt, `${from} 00:00:00`))
  if (to) conditions.push(lt(sales.createdAt, sql<string>`datetime(${to}, '+1 day')`))

  if (q) {
    if (/^\d+$/.test(q)) {
      conditions.push(eq(sales.id, Number(q)))
    } else {
      const pattern = `%${q}%`
      // Card-name match: any line of the sale is for a card whose name matches.
      const cardMatch = exists(
        dbc.select({ one: sql`1` })
          .from(saleItems)
          .innerJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
          .innerJoin(cards, eq(inventoryItems.cardId, cards.id))
          .where(and(eq(saleItems.saleId, sales.id), like(cards.name, pattern))),
      )
      const customerMatch = exists(
        dbc.select({ one: sql`1` })
          .from(customers)
          .where(and(eq(customers.id, sales.customerId), like(customers.name, pattern))),
      )
      conditions.push(or(cardMatch, customerMatch)!)
    }
  }

  const matched = await dbc
    .select({
      sale: {
        id: sales.id,
        total: sales.total,
        paymentMethod: sales.paymentMethod,
        discountAmount: sales.discountAmount,
        createdAt: sales.createdAt,
        voidedAt: sales.voidedAt,
      },
      staffName: staff.name,
      customerName: customers.name,
    })
    .from(sales)
    .leftJoin(staff, eq(sales.staffId, staff.id))
    .leftJoin(customers, eq(sales.customerId, customers.id))
    .where(and(...conditions))
    .orderBy(desc(sales.createdAt))
    .limit(limit)

  // One query for all line items across the matches → "2× Pikachu, 1× Charizard"
  const saleIds = matched.map(r => r.sale.id)
  const lines = saleIds.length > 0
    ? await dbc.select({ saleId: saleItems.saleId, quantity: saleItems.quantity, name: cards.name })
        .from(saleItems)
        .leftJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
        .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
        .where(inArray(saleItems.saleId, saleIds))
    : []
  const itemsBySale = new Map<number, string[]>()
  for (const l of lines) {
    const parts = itemsBySale.get(l.saleId) ?? []
    parts.push(`${l.quantity}× ${l.name ?? 'Unknown card'}`)
    itemsBySale.set(l.saleId, parts)
  }

  return matched.map(r => ({
    sale: { ...r.sale, voidedAt: r.sale.voidedAt ?? null },
    staffName: r.staffName ?? null,
    customerName: r.customerName ?? null,
    itemsSummary: (itemsBySale.get(r.sale.id) ?? []).join(', '),
  }))
}
