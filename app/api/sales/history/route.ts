// app/api/sales/history/route.ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sales, saleItems, inventoryItems, cards, staff } from '@/lib/db/schema'
import { eq, sql, gte, inArray } from 'drizzle-orm'
import { getSession, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'

export const GET = guarded(async () => {
  requireAdmin(await getSession())

  // createdAt is stored via SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC, space separator).
  // Compare against the same format — a JS toISOString() ("...T...Z") sorts differently and would
  // silently exclude every sale.
  const [todayStats] = await db.select({
    totalRevenue: sql<number>`COALESCE(SUM(total), 0)`,
    saleCount: sql<number>`COUNT(*)`,
    cashTotal: sql<number>`COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0)`,
    cardTotal: sql<number>`COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0)`,
  }).from(sales).where(gte(sales.createdAt, sql`datetime('now','start of day')`))

  const recent = await db
    .select({ sale: sales, staffName: staff.name })
    .from(sales)
    .leftJoin(staff, eq(sales.staffId, staff.id))
    .orderBy(sql`${sales.createdAt} DESC`)
    .limit(25)

  // One query for all line items across the 25 sales → "2× Pikachu, 1× Charizard"
  const saleIds = recent.map(r => r.sale.id)
  const lines = saleIds.length > 0
    ? await db.select({ saleId: saleItems.saleId, quantity: saleItems.quantity, name: cards.name })
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
  const recentSales = recent.map(r => ({ ...r, itemsSummary: (itemsBySale.get(r.sale.id) ?? []).join(', ') }))

  return NextResponse.json({ todayStats, recentSales })
})
