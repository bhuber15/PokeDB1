import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, inventoryItems, priceCache, creditLedger, customers } from '@/lib/db/schema'
import { calculateSellPrice, pickMarketPrice, computeSaleTotals, computeMarginVat } from '@/lib/pricing'
import { getSettings } from '@/lib/settings'
import { DomainError, isUniqueViolation } from './errors'

export interface CreateSaleInput {
  staffId: number
  items: { inventoryItemId: number; quantity: number }[]
  paymentMethod: 'cash' | 'card' | 'store_credit' | 'other'
  discount: number
  customerId?: number
  expectedTotal: number
  clientUuid?: string
}

const PAYMENT_METHODS = new Set(['cash', 'card', 'store_credit', 'other'])

export async function createSale(
  input: CreateSaleInput,
  dbc: Db = db,
): Promise<{ saleId: number; total: number; marginNoCostCount: number }> {
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

  // Idempotent replay: a queued offline sale re-POSTed with the same uuid
  // returns the original result instead of charging/decrementing again.
  if (input.clientUuid) {
    const [existing] = await dbc.select().from(sales)
      .where(eq(sales.clientUuid, input.clientUuid)).limit(1)
    if (existing) return { saleId: existing.id, total: existing.total, marginNoCostCount: 0 }
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
  const { discount, vatAmount: standardVat, total } = computeSaleTotals(subtotal, input.discount ?? 0, settings.vatScheme)

  // Margin scheme: VAT is inclusive (total already correct above); compute the
  // per-line margin VAT owed to HMRC from the cost snapshots, server-side only.
  let vatAmount = standardVat
  let marginNoCostCount = 0
  if (settings.vatScheme === 'margin') {
    const margin = computeMarginVat(lines, discount)
    vatAmount = margin.vatAmount
    marginNoCostCount = margin.noCostLineCount
    if (settings.marginNoCostHandling === 'block' && marginNoCostCount > 0) {
      throw new DomainError('MARGIN_NO_COST', 'Sale contains item(s) with no cost basis — cannot use the VAT Margin Scheme. Enter a cost or change the no-cost setting.', { marginNoCostCount })
    }
  }

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
      clientUuid: input.clientUuid ?? null,
      staffId: input.staffId,
      customerId: input.customerId ?? null,
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
  }).catch(async (e: unknown) => {
    // Two replays of the same queued sale racing: the loser's insert hits the
    // unique index — hand back the winner's sale instead of erroring.
    if (input.clientUuid && isUniqueViolation(e, 'sales.client_uuid')) {
      const [existing] = await dbc.select().from(sales)
        .where(eq(sales.clientUuid, input.clientUuid)).limit(1)
      if (existing) return existing.id
    }
    throw e
  })

  return { saleId, total, marginNoCostCount }
}
