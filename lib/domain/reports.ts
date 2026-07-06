// lib/domain/reports.ts
//
// Reporting helpers for end-of-day and staff-performance views.
//
// CashUpSummary feeds the till cash-up screen.  The caller computes:
//   expectedDrawer = openingFloat + cashSales − cashRefunds − cashBuyPayouts
// All values are integer pence (GBP).

import { and, gte, lt, sql, eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, refunds, buyTransactions, staff } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// getCashUpSummary
// ---------------------------------------------------------------------------

export interface CashUpSummary {
  cashSales: number      // SUM(sales.total) where paymentMethod = 'cash', that day
  cashRefunds: number    // SUM(refunds.amount) where method = 'cash', that day
  cashBuyPayouts: number // SUM(buy_transactions.total) where method = 'cash', that day
}

/**
 * Returns cash-movement totals for a single calendar day (UTC).
 * `day` must be 'YYYY-MM-DD'.  All three fields COALESCE to 0 so the caller
 * receives numbers even when no transactions exist for that day.
 */
export async function getCashUpSummary(day: string, dbc: Db = db): Promise<CashUpSummary> {
  const from = `${day} 00:00:00`
  const toExcl = sql<string>`datetime(${day}, '+1 day')`

  const [salesRow] = await dbc
    .select({ total: sql<number>`COALESCE(SUM(total), 0)` })
    .from(sales)
    .where(
      and(
        eq(sales.paymentMethod, 'cash'),
        gte(sales.createdAt, from),
        lt(sales.createdAt, toExcl),
      ),
    )

  const [refundsRow] = await dbc
    .select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(refunds)
    .where(
      and(
        eq(refunds.method, 'cash'),
        gte(refunds.createdAt, from),
        lt(refunds.createdAt, toExcl),
      ),
    )

  const [buysRow] = await dbc
    .select({ total: sql<number>`COALESCE(SUM(total), 0)` })
    .from(buyTransactions)
    .where(
      and(
        eq(buyTransactions.method, 'cash'),
        gte(buyTransactions.createdAt, from),
        lt(buyTransactions.createdAt, toExcl),
      ),
    )

  return {
    cashSales: salesRow.total,
    cashRefunds: refundsRow.total,
    cashBuyPayouts: buysRow.total,
  }
}

// ---------------------------------------------------------------------------
// getSalesByStaff
// ---------------------------------------------------------------------------

export interface StaffSales {
  staffId: number | null
  staffName: string | null
  saleCount: number
  revenue: number // SUM(sales.total), pence
}

/**
 * Aggregates sales by staff member over a date range [from 00:00:00, to+1day).
 * Both `from` and `to` are 'YYYY-MM-DD'.
 * Results are ordered by revenue descending.
 * Sales with a NULL staffId appear as a single row with staffName: null.
 */
export async function getSalesByStaff(from: string, to: string, dbc: Db = db): Promise<StaffSales[]> {
  const fromTs = `${from} 00:00:00`
  const toExcl = sql<string>`datetime(${to}, '+1 day')`

  const rows = await dbc
    .select({
      staffId: sales.staffId,
      staffName: staff.name,
      saleCount: sql<number>`COUNT(*)`,
      revenue: sql<number>`COALESCE(SUM(${sales.total}), 0)`,
    })
    .from(sales)
    .leftJoin(staff, eq(sales.staffId, staff.id))
    .where(and(gte(sales.createdAt, fromTs), lt(sales.createdAt, toExcl)))
    .groupBy(sales.staffId)
    .orderBy(sql`SUM(${sales.total}) DESC`)

  return rows.map(r => ({
    staffId: r.staffId ?? null,
    staffName: r.staffName ?? null,
    saleCount: r.saleCount,
    revenue: r.revenue,
  }))
}
