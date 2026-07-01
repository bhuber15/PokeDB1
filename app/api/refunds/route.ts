// app/api/refunds/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sales, saleItems, inventoryItems, refunds, refundItems, creditLedger, customers } from '@/lib/db/schema'
import { eq, sql, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/auth'

const METHODS = new Set(['cash', 'store_credit'])
const round2 = (n: number) => Math.round(n * 100) / 100

interface RefundLine { saleItemId: number; quantity: number }

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    saleId: number; method: string; reason?: string; items: RefundLine[]; customerId?: number
  }

  if (!Number.isInteger(body.saleId)) return NextResponse.json({ error: 'Invalid saleId' }, { status: 400 })
  if (!METHODS.has(body.method)) return NextResponse.json({ error: 'Invalid method' }, { status: 400 })
  if (!body.items?.length) return NextResponse.json({ error: 'No items to refund' }, { status: 400 })
  for (const line of body.items) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 })
    }
  }
  if (body.method === 'store_credit' && !body.customerId) {
    return NextResponse.json({ error: 'customerId required for store credit refunds' }, { status: 400 })
  }

  const [sale] = await db.select().from(sales).where(eq(sales.id, body.saleId)).limit(1)
  if (!sale) return NextResponse.json({ error: 'Sale not found' }, { status: 404 })

  if (body.method === 'store_credit') {
    const [customer] = await db.select().from(customers).where(eq(customers.id, body.customerId!)).limit(1)
    if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const saleItemIds = body.items.map(l => l.saleItemId)
  const originalItems = await db.select().from(saleItems).where(inArray(saleItems.id, saleItemIds))
  const byId = new Map(originalItems.map(i => [i.id, i]))

  try {
    const result = await db.transaction(async (tx) => {
      let netAmount = 0 // ex-VAT amount being refunded, drives proportional VAT reversal
      // Tracks quantity already claimed by earlier lines in *this same request* that reference
      // the same saleItemId — the refundItems rows for those lines aren't inserted until after
      // this loop, so the DB SUM below wouldn't see them without this in-memory tally.
      const claimedThisRequest = new Map<number, number>()

      for (const line of body.items) {
        const original = byId.get(line.saleItemId)
        if (!original || original.saleId !== sale.id) {
          throw new Error(`BAD_LINE:${line.saleItemId}:not part of this sale`)
        }

        const [{ refunded }] = await tx.select({
          refunded: sql<number>`COALESCE(SUM(quantity), 0)`,
        }).from(refundItems).where(eq(refundItems.saleItemId, line.saleItemId))

        const alreadyClaimed = claimedThisRequest.get(line.saleItemId) ?? 0
        const remaining = original.quantity - refunded - alreadyClaimed
        if (line.quantity > remaining) {
          throw new Error(`BAD_LINE:${line.saleItemId}:only ${remaining} left to refund`)
        }
        claimedThisRequest.set(line.saleItemId, alreadyClaimed + line.quantity)

        netAmount += original.priceAtSale * line.quantity

        if (original.inventoryItemId) {
          await tx.update(inventoryItems)
            .set({ quantity: sql`quantity + ${line.quantity}` })
            .where(eq(inventoryItems.id, original.inventoryItemId))
        }
      }

      netAmount = round2(netAmount)
      // Reverse VAT/discount proportionally to how this sale's total related to its subtotal,
      // so a partial refund doesn't over- or under-credit VAT versus what was actually charged.
      const chargedRatio = sale.subtotal > 0 ? sale.total / sale.subtotal : 1
      const amount = round2(netAmount * chargedRatio)

      const [refund] = await tx.insert(refunds).values({
        saleId: sale.id, staffId: session.staffId!, method: body.method,
        amount, reason: body.reason ?? null,
      }).returning()

      await Promise.all(body.items.map(line =>
        tx.insert(refundItems).values({ refundId: refund.id, saleItemId: line.saleItemId, quantity: line.quantity })
      ))

      if (body.method === 'store_credit') {
        await tx.insert(creditLedger).values({
          customerId: body.customerId!, delta: amount, reason: 'refund',
          refType: 'sale', refId: sale.id, staffId: session.staffId!,
        })
      }

      return { refundId: refund.id, amount }
    })

    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.startsWith('BAD_LINE:')) {
      const [, saleItemId, detail] = msg.split(':')
      return NextResponse.json({ error: `Line ${saleItemId}: ${detail}` }, { status: 409 })
    }
    return NextResponse.json({ error: 'Refund failed' }, { status: 500 })
  }
}
