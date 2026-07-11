// lib/domain/reports.ts
//
// Reporting helpers for end-of-day and staff-performance views.
//
// CashUpSummary feeds the till cash-up screen.  The caller computes:
//   expectedDrawer = openingFloat + cashSales − cashRefunds − cashBuyPayouts
// All values are integer pence (GBP).

import { and, gte, lt, sql, eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, refunds, buyTransactions, staff, saleItems, inventoryItems, cards } from '@/lib/db/schema'
import { MARGIN_VAT_DIVISOR } from '@/lib/pricing'

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

// ---------------------------------------------------------------------------
// getMarginStockBook
// ---------------------------------------------------------------------------
// The VAT Margin Scheme legally requires a "stock book": a purchase→sale record
// per item. One row per line of every margin-scheme sale in the range. Money is
// integer pence; margin/VAT mirror computeMarginVat (per-line, round(margin/divisor)).
// Lines with no cost basis are flagged and carry 0 margin/VAT (they can't be in
// the scheme). Ordered oldest-first for a readable ledger.

export interface MarginStockBookRow {
  saleId: number
  soldAt: string
  cardName: string | null
  condition: string
  quantity: number
  costPence: number | null // line total (× quantity); null when no cost basis
  salePence: number        // line total (× quantity)
  marginPence: number      // line margin: max(0, salePence − costPence)
  vatPence: number         // round(margin / MARGIN_VAT_DIVISOR)
  noCostBasis: boolean
}

export async function getMarginStockBook(from: string, to: string, dbc: Db = db): Promise<MarginStockBookRow[]> {
  const fromTs = `${from} 00:00:00`
  const toExcl = sql<string>`datetime(${to}, '+1 day')`

  const rows = await dbc
    .select({
      saleId: sales.id,
      soldAt: sales.createdAt,
      cardName: cards.name,
      condition: inventoryItems.condition,
      quantity: saleItems.quantity,
      salePence: saleItems.priceAtSale,
      costPence: saleItems.costAtSale,
    })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .leftJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .where(and(
      eq(sales.vatScheme, 'margin'),
      gte(sales.createdAt, fromTs),
      lt(sales.createdAt, toExcl),
    ))
    .orderBy(sales.createdAt)

  // NOTE: every money column is a LINE TOTAL (× quantity) so the CSV reconciles:
  //   Margin = Sale − Cost (when cost present); VAT = round(Margin / divisor).
  // The stock book computes GROSS margins and does NOT apply any whole-sale
  // discount allocation.  The authoritative VAT owed per sale is the stored
  // sales.vat_amount (summed as vatTotal in the sales report); on discounted
  // sales the CSV VAT total can therefore exceed the reported figure.
  return rows.map(r => {
    const unitCost = r.costPence          // per-unit snapshot from DB (nullable)
    const unitSale = r.salePence          // per-unit snapshot from DB
    const qty = r.quantity
    const noCostBasis = unitCost == null
    const costPence = noCostBasis ? null : unitCost * qty           // line total, or null
    const salePence = unitSale * qty                                // line total
    const marginPence = noCostBasis ? 0 : Math.max(0, salePence - (costPence as number))
    return {
      saleId: r.saleId,
      soldAt: r.soldAt,
      cardName: r.cardName ?? null,
      condition: r.condition ?? '',
      quantity: qty,
      costPence,
      salePence,
      marginPence,
      vatPence: Math.round(marginPence / MARGIN_VAT_DIVISOR),
      noCostBasis,
    }
  })
}
