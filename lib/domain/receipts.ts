// lib/domain/receipts.ts
//
// Email receipt delivery. Rebuilds the receipt server-side from the sale
// rows (the client-built receipt only exists in the POS session) and sends
// it through lib/email — which is a logged no-op without RESEND_API_KEY, so
// nothing here blocks when no provider is configured.

import { asc, eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, salePayments, inventoryItems, cards, customers } from '@/lib/db/schema'
import { getSettings } from '@/lib/settings'
import { sendEmail, type SendResult } from '@/lib/email'
import { receiptHtml, receiptText, type ReceiptData } from '@/lib/receipt-html'
import { DomainError } from './errors'

// Deliberately loose: catches till typos, not RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function buildReceiptData(
  saleId: number,
  dbc: Db = db,
): Promise<{ receipt: ReceiptData; customerEmail: string | null }> {
  const [sale] = await dbc.select().from(sales).where(eq(sales.id, saleId)).limit(1)
  if (!sale) throw new DomainError('NOT_FOUND', 'Sale not found')
  if (sale.voidedAt) throw new DomainError('SALE_VOIDED', 'Sale is voided — no receipt to send')

  const settings = await getSettings(dbc)

  const lineRows = await dbc
    .select({
      name: cards.name,
      condition: inventoryItems.condition,
      quantity: saleItems.quantity,
      price: saleItems.priceAtSale,
    })
    .from(saleItems)
    .leftJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .where(eq(saleItems.saleId, saleId))
    .orderBy(asc(saleItems.id))

  const paymentRows = await dbc
    .select({ method: salePayments.method, amount: salePayments.amount })
    .from(salePayments)
    .where(eq(salePayments.saleId, saleId))
    .orderBy(asc(salePayments.id))

  let customerEmail: string | null = null
  if (sale.customerId) {
    const [customer] = await dbc.select().from(customers).where(eq(customers.id, sale.customerId)).limit(1)
    customerEmail = customer?.email ?? null
  }

  const receipt: ReceiptData = {
    saleId: sale.id,
    at: sale.createdAt.replace(' ', 'T') + 'Z', // stored as UTC "YYYY-MM-DD HH:MM:SS"
    shopName: settings.shopName,
    lines: lineRows.map(l => ({
      name: l.name ?? 'Unknown card',
      condition: l.condition ?? '',
      quantity: l.quantity,
      price: l.price,
    })),
    subtotal: sale.subtotal,
    discount: sale.discountAmount,
    vatAmount: sale.vatAmount,
    vatScheme: sale.vatScheme as ReceiptData['vatScheme'],
    total: sale.total,
    paymentMethod: sale.paymentMethod,
    ...(paymentRows.length > 0 ? { payments: paymentRows } : {}),
  }
  return { receipt, customerEmail }
}

export interface EmailReceiptInput {
  saleId: number
  // Explicit address wins; otherwise the sale's customer email is used.
  email?: string
}

export async function emailReceipt(
  input: EmailReceiptInput,
  dbc: Db = db,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult & { to: string }> {
  if (input.email != null && !EMAIL_RE.test(input.email)) {
    throw new DomainError('INVALID_INPUT', 'Invalid email address')
  }

  const { receipt, customerEmail } = await buildReceiptData(input.saleId, dbc)
  const to = input.email ?? customerEmail
  if (!to) {
    throw new DomainError('INVALID_INPUT', 'No email address — enter one or add it to the customer')
  }

  const result = await sendEmail({
    to,
    subject: `Receipt #${receipt.saleId} — ${receipt.shopName}`,
    text: receiptText(receipt),
    html: receiptHtml(receipt),
  }, fetchImpl)
  return { ...result, to }
}
