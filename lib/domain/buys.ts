import { and, eq, inArray } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { buyTransactions, buyItems, inventoryItems, creditLedger, customers, priceCache } from '@/lib/db/schema'
import { generateQRId } from '@/lib/qr'
import { applyConditionPct, conditionPct, pickMarketPrice, CONDITIONS } from '@/lib/pricing'
import { getSettings } from '@/lib/settings'
import { DomainError } from './errors'

export interface CreateBuyInput {
  staffId: number
  staffRole?: 'admin' | 'staff'
  items: { cardId: number; condition: string; quantity: number; payPrice: number }[]
  method: 'cash' | 'store_credit'
  customerId?: number
}

// Staff can haggle, but not past 110% of market — that gap is where buylist
// fraud lives. Admins are exempt; cards with no cached market price can't be
// capped and pass through with marketAtBuy = null.
export const BUY_CAP_NUMERATOR = 11
export const BUY_CAP_DENOMINATOR = 10

const CONDITION_SET = new Set<string>(CONDITIONS)

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
    if (!CONDITION_SET.has(it.condition)) throw new DomainError('INVALID_INPUT', 'Invalid condition')
    if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new DomainError('INVALID_INPUT', 'Invalid quantity')
    if (!(it.payPrice >= 0)) throw new DomainError('INVALID_INPUT', 'Invalid pay price')
    if (!Number.isInteger(it.cardId) || it.cardId < 1) throw new DomainError('INVALID_INPUT', 'Invalid cardId')
  }
  const total = input.items.reduce((s, i) => s + i.payPrice * i.quantity, 0)

  // Snapshot market prices for every line; enforce the overpayment cap for
  // non-admin staff. Integer comparison (pay×10 > market×11) avoids floats.
  const cardIds = [...new Set(input.items.map(i => i.cardId))]
  const cacheRows = await dbc.select().from(priceCache).where(inArray(priceCache.cardId, cardIds))
  const settings = await getSettings(dbc)
  const marketByCard = new Map<number, number | null>(
    cardIds.map(id => [id, pickMarketPrice(cacheRows.find(r => r.cardId === id), settings.primaryPriceSource)]),
  )
  for (const it of input.items) {
    const market = marketByCard.get(it.cardId) ?? null
    // The cap protects against overpaying for the card AS GRADED — reference
    // is the condition-adjusted market, not raw NM market.
    const conditioned = market !== null
      ? applyConditionPct(market, conditionPct(settings.conditionSellPct, it.condition))
      : null
    if (
      input.staffRole !== 'admin' && conditioned !== null
      && it.payPrice * BUY_CAP_DENOMINATOR > conditioned * BUY_CAP_NUMERATOR
    ) {
      const maxPay = Math.floor(conditioned * BUY_CAP_NUMERATOR / BUY_CAP_DENOMINATOR)
      throw new DomainError(
        'BUY_CAP_EXCEEDED',
        `Pay price is above 110% of market for this condition — max £${(maxPay / 100).toFixed(2)} for this card. An admin can override.`,
        { cardId: it.cardId, payPrice: it.payPrice, market: conditioned, maxPay },
      )
    }
  }

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
        // A null existing cost means "no recorded cost basis"; treating it as 0 understates
        // blended cost → conservatively over-states future margin VAT (never under-charges HMRC).
        // This is intentionally different from the sale path, where a null cost is preserved so
        // the line is excluded from the margin scheme rather than treated as zero-cost.
        const newCost = Math.round(((existing.costPrice ?? 0) * existing.quantity + it.payPrice * it.quantity) / newQty)
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
        marketAtBuy: marketByCard.get(it.cardId) ?? null,
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
