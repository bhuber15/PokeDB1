// app/api/sales/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sales } from '@/lib/db/schema'
import { getSession, requireStaff, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { createSale } from '@/lib/domain/sales'

export const POST = guarded(async (req: NextRequest) => {
  const session = requireStaff(await getSession())
  const body = await req.json() as {
    items?: { inventoryItemId: number; quantity: number }[]
    paymentMethod: 'cash' | 'card' | 'store_credit' | 'other'
    discountAmount?: number
    customerId?: number
    expectedTotal: number
  }
  const result = await createSale({
    staffId: session.staffId,
    items: body.items ?? [],
    paymentMethod: body.paymentMethod,
    discount: body.discountAmount ?? 0,
    customerId: body.customerId,
    expectedTotal: body.expectedTotal,
  })
  return NextResponse.json(result)
})

export const GET = guarded(async () => {
  requireAdmin(await getSession())
  const rows = await db.select().from(sales).orderBy(desc(sales.createdAt)).limit(50)
  return NextResponse.json(rows)
})
