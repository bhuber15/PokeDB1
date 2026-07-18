// lib/domain/reports.ts
//
// Reporting helpers for end-of-day and staff-performance views.
//
// CashUpSummary feeds the till cash-up screen.  The caller computes:
//   expectedDrawer = openingFloat + cashSales − cashRefunds − cashBuyPayouts
// All values are integer pence (GBP).

import { and, gt, gte, lt, or, isNull, sql, eq, asc, desc } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, salePayments, refunds, buyTransactions, staff, saleItems, inventoryItems, cards, priceCache, customers, buyItems } from '@/lib/db/schema'
import { MARGIN_VAT_DIVISOR, pickMarketPrice } from '@/lib/pricing'
import { getSettings } from '@/lib/settings'
import { DomainError } from './errors'

// ---------------------------------------------------------------------------
// getCashUpSummary
// ---------------------------------------------------------------------------

export interface CashUpSummary {
  cashSales: number      // SUM(sale_payments.amount) where method = 'cash', non-voided sales that day
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

  // Cash arriving through sale_payments so a split tender contributes only
  // its cash portion (every sale has payment rows — see migration 0019).
  const [salesRow] = await dbc
    .select({ total: sql<number>`COALESCE(SUM(${salePayments.amount}), 0)` })
    .from(salePayments)
    .innerJoin(sales, eq(salePayments.saleId, sales.id))
    .where(
      and(
        eq(salePayments.method, 'cash'),
        isNull(sales.voidedAt),
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
    .where(and(isNull(sales.voidedAt), gte(sales.createdAt, fromTs), lt(sales.createdAt, toExcl)))
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
      isNull(sales.voidedAt),
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

// ---------------------------------------------------------------------------
// getInventoryValuation
// ---------------------------------------------------------------------------

export interface InventoryValuation {
  totalUnits: number        // Σ quantity over active, in-stock items
  distinctItems: number     // number of those inventory rows
  costValue: number         // Σ quantity × costPrice, rows with a cost
  unitsWithoutCost: number  // Σ quantity of rows with no cost price
  marketValue: number       // Σ quantity × market price (primaryPriceSource, raw — no margin multiplier / overrides)
  unitsWithoutMarket: number
}

/**
 * Stock-on-hand valuation over active items with quantity > 0. Market prices
 * come from price_cache via pickMarketPrice with the shop's primary source,
 * mirroring how sale prices are derived (before margin/overrides).
 */
export async function getInventoryValuation(dbc: Db = db): Promise<InventoryValuation> {
  const settings = await getSettings(dbc)
  const rows = await dbc
    .select({ quantity: inventoryItems.quantity, costPrice: inventoryItems.costPrice, prices: priceCache })
    .from(inventoryItems)
    .leftJoin(priceCache, eq(priceCache.cardId, inventoryItems.cardId))
    .where(and(eq(inventoryItems.isActive, true), gt(inventoryItems.quantity, 0)))

  const v: InventoryValuation = {
    totalUnits: 0, distinctItems: 0, costValue: 0,
    unitsWithoutCost: 0, marketValue: 0, unitsWithoutMarket: 0,
  }
  for (const row of rows) {
    v.totalUnits += row.quantity
    v.distinctItems += 1
    if (row.costPrice != null) v.costValue += row.quantity * row.costPrice
    else v.unitsWithoutCost += row.quantity
    const market = pickMarketPrice(row.prices, settings.primaryPriceSource)
    if (market != null) v.marketValue += row.quantity * market
    else v.unitsWithoutMarket += row.quantity
  }
  return v
}

// ---------------------------------------------------------------------------
// getAgedStock
// ---------------------------------------------------------------------------

export interface AgedStockRow {
  inventoryItemId: number
  cardName: string | null
  setName: string | null
  condition: string
  quantity: number
  costPrice: number | null
  createdAt: string
  lastSoldAt: string | null // null = never sold
}

/**
 * Dead-stock report: active in-stock items added more than `olderThanDays`
 * ago whose last sale (if any) is also older than the cutoff. Ordered by
 * least-recent activity (last sale, else intake date), capped at 100 rows.
 */
export async function getAgedStock(olderThanDays: number, dbc: Db = db): Promise<AgedStockRow[]> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new DomainError('INVALID_INPUT', 'olderThanDays must be a positive integer')
  }
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ')

  const lastSold = dbc
    .select({
      inventoryItemId: saleItems.inventoryItemId,
      lastSoldAt: sql<string>`MAX(${sales.createdAt})`.as('last_sold_at'),
    })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .groupBy(saleItems.inventoryItemId)
    .as('last_sold')

  const rows = await dbc
    .select({
      inventoryItemId: inventoryItems.id,
      cardName: cards.name,
      setName: cards.setName,
      condition: inventoryItems.condition,
      quantity: inventoryItems.quantity,
      costPrice: inventoryItems.costPrice,
      createdAt: inventoryItems.createdAt,
      lastSoldAt: lastSold.lastSoldAt,
    })
    .from(inventoryItems)
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .leftJoin(lastSold, eq(lastSold.inventoryItemId, inventoryItems.id))
    .where(and(
      eq(inventoryItems.isActive, true),
      gt(inventoryItems.quantity, 0),
      lt(inventoryItems.createdAt, cutoff),
      or(isNull(lastSold.lastSoldAt), lt(lastSold.lastSoldAt, cutoff)),
    ))
    .orderBy(asc(sql`COALESCE(${lastSold.lastSoldAt}, ${inventoryItems.createdAt})`))
    .limit(100)

  return rows.map(r => ({ ...r, lastSoldAt: r.lastSoldAt ?? null }))
}

// ---------------------------------------------------------------------------
// getLowStock
// ---------------------------------------------------------------------------

export interface LowStockRow {
  inventoryItemId: number
  cardName: string | null
  setName: string | null
  condition: string
  quantity: number
  lowStockThreshold: number
  location: string | null
}

/** Reorder list: active items at or below their low-stock threshold, emptiest first. */
export async function getLowStock(dbc: Db = db): Promise<LowStockRow[]> {
  return dbc
    .select({
      inventoryItemId: inventoryItems.id,
      cardName: cards.name,
      setName: cards.setName,
      condition: inventoryItems.condition,
      quantity: inventoryItems.quantity,
      lowStockThreshold: inventoryItems.lowStockThreshold,
      location: inventoryItems.location,
    })
    .from(inventoryItems)
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .where(and(
      eq(inventoryItems.isActive, true),
      sql`${inventoryItems.quantity} <= ${inventoryItems.lowStockThreshold}`,
    ))
    .orderBy(asc(inventoryItems.quantity), asc(cards.name))
    .limit(100)
}

// ---------------------------------------------------------------------------
// getMarginByStaff
// ---------------------------------------------------------------------------

export interface StaffMargin {
  staffId: number | null
  margin: number      // Σ (priceAtSale − costAtSale) × qty over lines WITH a cost snapshot
  noCostLines: number // lines excluded from margin for lack of a cost basis
}

/**
 * Gross margin per staff member over [from, to]. Mirrors the sales-report
 * convention: margin uses the sale-time cost snapshot (sale_items.cost_at_sale)
 * and lines with no captured cost are excluded (and counted separately).
 */
export async function getMarginByStaff(from: string, to: string, dbc: Db = db): Promise<StaffMargin[]> {
  const fromTs = `${from} 00:00:00`
  const toExcl = sql<string>`datetime(${to}, '+1 day')`

  return dbc
    .select({
      staffId: sales.staffId,
      margin: sql<number>`COALESCE(SUM(CASE WHEN ${saleItems.costAtSale} IS NOT NULL THEN (${saleItems.priceAtSale} - ${saleItems.costAtSale}) * ${saleItems.quantity} ELSE 0 END), 0)`,
      noCostLines: sql<number>`COALESCE(SUM(CASE WHEN ${saleItems.costAtSale} IS NULL THEN 1 ELSE 0 END), 0)`,
    })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .where(and(isNull(sales.voidedAt), gte(sales.createdAt, fromTs), lt(sales.createdAt, toExcl)))
    .groupBy(sales.staffId)
}

// ---------------------------------------------------------------------------
// getBuyExportRows
// ---------------------------------------------------------------------------

export interface BuyExportRow {
  buyId: number
  createdAt: string
  staffName: string | null
  customerName: string | null
  method: string
  txnTotal: number
  cardName: string | null
  condition: string
  quantity: number
  payPrice: number
  marketAtBuy: number | null
}

/** Buy-transaction CSV feed: one row per buy line with its parent txn columns. */
export async function getBuyExportRows(dbc: Db = db): Promise<BuyExportRow[]> {
  return dbc
    .select({
      buyId: buyTransactions.id,
      createdAt: buyTransactions.createdAt,
      staffName: staff.name,
      customerName: customers.name,
      method: buyTransactions.method,
      txnTotal: buyTransactions.total,
      cardName: cards.name,
      condition: buyItems.condition,
      quantity: buyItems.quantity,
      payPrice: buyItems.payPrice,
      marketAtBuy: buyItems.marketAtBuy,
    })
    .from(buyItems)
    .innerJoin(buyTransactions, eq(buyItems.buyId, buyTransactions.id))
    .leftJoin(staff, eq(buyTransactions.staffId, staff.id))
    .leftJoin(customers, eq(buyTransactions.customerId, customers.id))
    .leftJoin(cards, eq(buyItems.cardId, cards.id))
    .orderBy(desc(buyTransactions.createdAt), asc(buyItems.id))
}

// ---------------------------------------------------------------------------
// getSalesByPaymentMethod
// ---------------------------------------------------------------------------

export interface PaymentMethodTotal {
  paymentMethod: string
  total: number
}

/**
 * Money taken per tender method over [from, to], summed from sale_payments so
 * split sales contribute each portion to its own method ('split' never
 * appears). Voided sales are excluded.
 */
export async function getSalesByPaymentMethod(from: string, to: string, dbc: Db = db): Promise<PaymentMethodTotal[]> {
  const fromTs = `${from} 00:00:00`
  const toExcl = sql<string>`datetime(${to}, '+1 day')`

  return dbc
    .select({
      paymentMethod: salePayments.method,
      total: sql<number>`COALESCE(SUM(${salePayments.amount}), 0)`,
    })
    .from(salePayments)
    .innerJoin(sales, eq(salePayments.saleId, sales.id))
    .where(and(isNull(sales.voidedAt), gte(sales.createdAt, fromTs), lt(sales.createdAt, toExcl)))
    .groupBy(salePayments.method)
}
