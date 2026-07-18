// app/api/reports/sales/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { sales, saleItems, inventoryItems, cards } from '@/lib/db/schema'
import { and, gte, lt, eq, sql, isNotNull } from 'drizzle-orm'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getSalesByStaff, getMarginByStaff } from '@/lib/domain/reports'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))

  const from = req.nextUrl.searchParams.get('from') ?? ''
  const to = req.nextUrl.searchParams.get('to') ?? ''
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 })
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must be before to' }, { status: 400 })
  }

  // createdAt is "YYYY-MM-DD HH:MM:SS" text (UTC). Range is [from 00:00:00, to+1day 00:00:00).
  const fromTs = `${from} 00:00:00`
  const toTs = sql<string>`datetime(${to}, '+1 day')`
  const rangeWhere = and(gte(sales.createdAt, fromTs), lt(sales.createdAt, toTs))

  const [totals] = await db.select({
    revenue: sql<number>`COALESCE(SUM(total), 0)`,
    subtotal: sql<number>`COALESCE(SUM(subtotal), 0)`,
    discountTotal: sql<number>`COALESCE(SUM(discount_amount), 0)`,
    vatTotal: sql<number>`COALESCE(SUM(vat_amount), 0)`,
    saleCount: sql<number>`COUNT(*)`,
  }).from(sales).where(rangeWhere)

  const byPaymentMethod = await db.select({
    paymentMethod: sales.paymentMethod,
    total: sql<number>`COALESCE(SUM(total), 0)`,
  }).from(sales).where(rangeWhere).groupBy(sales.paymentMethod)

  // Gross margin uses the cost snapshot taken at sale time (sale_items.cost_at_sale),
  // NOT the live inventory_items.cost_price — otherwise re-buying a card at a new
  // price (which blends the cost basis) would retroactively change past margins.
  // Lines with no captured cost are excluded from both revenue and cost.
  const [marginRow] = await db.select({
    revenue: sql<number>`COALESCE(SUM(${saleItems.priceAtSale} * ${saleItems.quantity}), 0)`,
    cost: sql<number>`COALESCE(SUM(${saleItems.costAtSale} * ${saleItems.quantity}), 0)`,
  })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .where(and(rangeWhere, isNotNull(saleItems.costAtSale)))

  const topCardsRaw = await db.select({
    cardId: inventoryItems.cardId,
    name: cards.name,
    quantitySold: sql<number>`COALESCE(SUM(${saleItems.quantity}), 0)`,
    revenue: sql<number>`COALESCE(SUM(${saleItems.priceAtSale} * ${saleItems.quantity}), 0)`,
  })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .leftJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .where(and(rangeWhere, isNotNull(inventoryItems.cardId)))
    .groupBy(inventoryItems.cardId, cards.name)
    .orderBy(sql`SUM(${saleItems.quantity}) DESC`)
    .limit(10)

  // Per-staff revenue and margin come from different grains (sales vs sale
  // lines), so they're two grouped queries merged by staffId here.
  const [staffSales, staffMargins] = await Promise.all([
    getSalesByStaff(from, to, db),
    getMarginByStaff(from, to, db),
  ])
  const marginByStaffId = new Map(staffMargins.map(m => [m.staffId, m]))
  const byStaff = staffSales.map(s => ({
    ...s,
    margin: marginByStaffId.get(s.staffId)?.margin ?? 0,
    noCostLines: marginByStaffId.get(s.staffId)?.noCostLines ?? 0,
  }))

  // All money values are SUMs of integer pence — already exact, no rounding
  return NextResponse.json({
    range: { from, to },
    revenue: totals.revenue,
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    vatTotal: totals.vatTotal,
    grossMargin: marginRow.revenue - marginRow.cost,
    saleCount: totals.saleCount,
    byPaymentMethod,
    byStaff,
    topCards: topCardsRaw
      .map(r => ({ cardId: r.cardId!, name: r.name ?? 'Unknown', quantitySold: r.quantitySold, revenue: r.revenue })),
  })
})
